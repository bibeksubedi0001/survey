/* =============================================================
 * KUKLGis — QField-style field GIS editor for Leaflet maps
 *
 *   window.KUKLGis.mount(containerEl) → { map, refresh, destroy }
 *
 *  Features
 *  --------
 *   • Standalone full-height map with OSM + Satellite base layers
 *   • Leaflet-Geoman drawing/editing toolbar (point / line / polygon /
 *     rectangle / circle, plus edit / drag / cut / rotate / remove)
 *   • Multiple named editable layers (like QField "vector layers"),
 *     each toggled, renamed, coloured, zoomed-to, exported, deleted
 *   • Import: zipped Shapefile (.zip), GeoJSON (.geojson/.json),
 *     KML (.kml), GPX (.gpx) → become editable layers
 *   • Export: each layer → GeoJSON download (and KML for the active one)
 *   • Snap-to-GPS: capture the device location and drop a vertex/point
 *   • Auto-persist every layer + feature to its own IndexedDB store so
 *     edits survive reloads and work fully offline
 *   • Read-only DMA reference overlay reusing window.KUKLDma
 *
 *  Depends on (all vendored locally, see index.html):
 *     Leaflet, Leaflet-Geoman, shpjs (window.shp), toGeoJSON
 * ============================================================ */
(function () {
  'use strict';
  if (window.KUKLGis) return;

  // ---------------------------------------------------------------
  // Tiny IndexedDB wrapper (separate DB so it never clashes with the
  // survey DB schema/version).
  // ---------------------------------------------------------------
  var GIS_DB = 'kukl_gis_db';
  var GIS_VER = 1;
  var GIS_STORE = 'layers';
  var _dbPromise = null;

  function openGisDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(GIS_DB, GIS_VER);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(GIS_STORE)) {
          db.createObjectStore(GIS_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return _dbPromise;
  }
  function dbAllLayers() {
    return openGisDB().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(GIS_STORE, 'readonly');
        var rq = tx.objectStore(GIS_STORE).getAll();
        rq.onsuccess = function () { res(rq.result || []); };
        rq.onerror = function () { rej(rq.error); };
      });
    });
  }
  function dbPutLayer(rec) {
    return openGisDB().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(GIS_STORE, 'readwrite');
        tx.objectStore(GIS_STORE).put(rec);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }
  function dbDelLayer(id) {
    return openGisDB().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(GIS_STORE, 'readwrite');
        tx.objectStore(GIS_STORE).delete(id);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  // ---------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------
  var KTM_DEFAULT = [27.6915, 85.3420];
  var PALETTE = ['#c1001f', '#1b6fd6', '#1a7f1a', '#e07a00', '#7d3cb5', '#0a8f8f', '#d4007a', '#444'];
  var CATEGORY_COLOR = { building: '#1b6fd6', connection: '#0a8f8f', valve: '#c1001f', pipe: '#1a7f1a', hydrant: '#e8430f', meter: '#a36b00', generic: '#7d3cb5' };

  // ---- Feature schemas (QField-style typed layers) ----
  var SCHEMAS = {
    building: {
      label: 'Building', geom: 'point', geoms: ['point', 'polygon'],
      titleKey: 'building_id', fallbackKey: 'office_name',
      fields: [
        { key: 'surveyor', label: 'Surveyor', type: 'text' },
        { key: 'date', label: 'Date', type: 'date' },
        { key: 'building_id', label: 'Building ID', type: 'text' },
        { key: 'block', label: 'Block', type: 'text' },
        { key: 'office_name', label: 'Office / Occupant (1)', type: 'text' },
        { key: 'office_name_2', label: 'Office / Occupant (2)', type: 'text' },
        { key: 'office_name_3', label: 'Office / Occupant (3)', type: 'text' },
        { key: 'meter_status', label: 'Meter Status', type: 'select', options: ['', 'Present and Working', 'Present but not Working', 'Not Present'] },
        { key: 'floors', label: 'Floors', type: 'number' },
        { key: 'area_m2', label: 'Area (m\u00b2) \u2014 auto (area shape only)', type: 'number', readonly: true },
        { key: 'builtup_m2', label: 'Built-up Area (m\u00b2) \u2014 auto', type: 'number', readonly: true },
        { key: 'remarks', label: 'Remarks', type: 'textarea' },
      ],
    },
    connection: {
      label: 'Connection', geom: 'point', titleKey: 'connection_id', fallbackKey: 'building_id',
      fields: [
        { key: 'surveyor', label: 'Surveyor', type: 'text' },
        { key: 'date', label: 'Date', type: 'date' },
        { key: 'connection_id', label: 'Connection ID', type: 'text' },
        { key: 'building_id', label: 'Linked Building ID', type: 'text', list: 'buildings' },
        { key: 'account_no', label: 'Account / Customer No.', type: 'text' },
        { key: 'conn_type', label: 'Connection Type', type: 'select', options: ['Domestic', 'Commercial', 'Institutional', 'Standpost'] },
        { key: 'meter_no', label: 'Meter No.', type: 'text' },
        { key: 'meter_size', label: 'Meter Size', type: 'select', options: ['\u00bd\u2033 (15mm)', '\u00be\u2033 (20mm)', '1\u2033 (25mm)', '1\u00bd\u2033 (40mm)', '2\u2033 (50mm)'] },
        { key: 'pipe_size', label: 'Service Pipe Size', type: 'select', options: ['\u00bd\u2033', '\u00be\u2033', '1\u2033', '1\u00bd\u2033', '2\u2033'] },
        { key: 'status', label: 'Status', type: 'select', options: ['Active', 'Inactive', 'Disconnected', 'Illegal'] },
        { key: 'supply_hours', label: 'Supply Hours / Day', type: 'number' },
        { key: 'remarks', label: 'Remarks', type: 'textarea' },
      ],
    },
    valve: {
      label: 'Valve', geom: 'point', titleKey: 'valve_id', fallbackKey: 'valve_type',
      fields: [
        { key: 'surveyor', label: 'Surveyor', type: 'text' },
        { key: 'date', label: 'Date', type: 'date' },
        { key: 'valve_id', label: 'Valve ID', type: 'text' },
        { key: 'valve_type', label: 'Valve Type', type: 'select', options: ['Gate', 'Butterfly', 'Sluice', 'Air Release', 'Check', 'Washout', 'Pressure Reducing'] },
        { key: 'diameter_mm', label: 'Diameter (mm)', type: 'number' },
        { key: 'status', label: 'Status', type: 'select', options: ['Open', 'Closed', 'Partially Open', 'Unknown'] },
        { key: 'chamber', label: 'Chamber / Cover', type: 'select', options: ['Good', 'Damaged', 'Buried', 'Missing'] },
        { key: 'depth_m', label: 'Depth (m)', type: 'number' },
        { key: 'remarks', label: 'Remarks', type: 'textarea' },
      ],
    },
    pipe: {
      label: 'Pipe', geom: 'line', titleKey: 'pipe_id', fallbackKey: 'material',
      fields: [
        { key: 'surveyor', label: 'Surveyor', type: 'text' },
        { key: 'date', label: 'Date', type: 'date' },
        { key: 'pipe_id', label: 'Pipe ID', type: 'text' },
        { key: 'material', label: 'Material', type: 'select', options: ['HDPE', 'DI', 'GI', 'CI', 'AC'] },
        { key: 'diameter_mm', label: 'Diameter (mm)', type: 'number' },
        { key: 'length_m', label: 'Length (m) \u2014 auto', type: 'number', readonly: true },
        { key: 'status', label: 'Status', type: 'select', options: ['In Service', 'Abandoned', 'Proposed', 'Under Construction'] },
        { key: 'remarks', label: 'Remarks', type: 'textarea' },
      ],
    },
    hydrant: {
      label: 'Fire Hydrant', geom: 'point', titleKey: 'hydrant_id', fallbackKey: 'hydrant_type',
      fields: [
        { key: 'surveyor', label: 'Surveyor', type: 'text' },
        { key: 'date', label: 'Date', type: 'date' },
        { key: 'hydrant_id', label: 'Hydrant ID', type: 'text' },
        { key: 'hydrant_type', label: 'Hydrant Type', type: 'select', options: ['Pillar', 'Underground', 'Post', 'Wall'] },
        { key: 'outlet_size_mm', label: 'Outlet Size (mm)', type: 'select', options: ['', '63', '80', '100', '150'] },
        { key: 'outlets', label: 'No. of Outlets', type: 'number' },
        { key: 'status', label: 'Status', type: 'select', options: ['Working', 'Not Working', 'Damaged', 'Buried', 'Missing'] },
        { key: 'chamber', label: 'Chamber / Cover', type: 'select', options: ['Good', 'Damaged', 'Buried', 'Missing'] },
        { key: 'last_inspected', label: 'Last Inspected', type: 'date' },
        { key: 'remarks', label: 'Remarks', type: 'textarea' },
      ],
    },
    meter: {
      label: 'Meter', geom: 'point', titleKey: 'meter_id', fallbackKey: 'meter_no',
      fields: [
        { key: 'surveyor', label: 'Surveyor', type: 'text' },
        { key: 'date', label: 'Date', type: 'date' },
        { key: 'meter_id', label: 'Meter ID', type: 'text' },
        { key: 'meter_type', label: 'Meter Type', type: 'select', options: ['Customer', 'Bulk', 'DMA / Zonal', 'Production', 'Check'] },
        { key: 'building_id', label: 'Linked Building ID', type: 'text', list: 'buildings' },
        { key: 'meter_no', label: 'Meter No. / Serial', type: 'text' },
        { key: 'make', label: 'Make / Brand', type: 'text' },
        { key: 'meter_size', label: 'Meter Size', type: 'select', options: ['\u00bd\u2033 (15mm)', '\u00be\u2033 (20mm)', '1\u2033 (25mm)', '1\u00bd\u2033 (40mm)', '2\u2033 (50mm)', '3\u2033 (80mm)', '4\u2033 (100mm)', '6\u2033 (150mm)', '8\u2033 (200mm)'] },
        { key: 'reading', label: 'Current Reading (m\u00b3)', type: 'number' },
        { key: 'reading_date', label: 'Reading Date', type: 'date' },
        { key: 'status', label: 'Status', type: 'select', options: ['Working', 'Not Working', 'Stuck', 'Leaking', 'Removed'] },
        { key: 'remarks', label: 'Remarks', type: 'textarea' },
      ],
    },
    generic: {
      label: 'Feature', geom: 'any', titleKey: 'name',
      fields: [
        { key: 'name', label: 'Name', type: 'text' },
        { key: 'surveyor', label: 'Surveyor', type: 'text' },
        { key: 'date', label: 'Date', type: 'date' },
        { key: 'notes', label: 'Notes', type: 'textarea' },
      ],
    },
  };

  function today() { return new Date().toISOString().slice(0, 10); }
  function defaultSurveyor() { try { return localStorage.getItem('kukl_gis_surveyor') || ''; } catch (_) { return ''; } }

  function uid() { return 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  // Stable shared key that links a building's point + polygon features so they
  // can be re-joined in desktop GIS after export.
  function genUUID() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (_) {}
    return 'bld-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function toast(msg) {
    if (typeof window.toast === 'function') { window.toast(msg); return; }
    var t = document.getElementById('toast');
    if (!t) { console.log('[GIS]', msg); return; }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  function download(name, text, type) {
    var blob = new Blob([text], { type: type || 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  // ---- GeoJSON → KML with full ExtendedData ------------------------------
  // Every feature property is emitted as a <Data> element so rich attributes
  // (Building ID, Meter Status, building_uuid, geometry_role …) survive the
  // round-trip into Google Earth, QGIS and QField. building_uuid keeps a
  // building's point + footprint joined as one record after import.
  var KML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>';
  function kmlCoord(c) { return c[0] + ',' + c[1] + (c.length > 2 ? ',' + c[2] : ''); }
  function kmlRing(r) { return r.map(kmlCoord).join(' '); }
  function kmlPolygon(rings) {
    var out = '<Polygon><outerBoundaryIs><LinearRing><coordinates>' +
      kmlRing(rings[0] || []) + '</coordinates></LinearRing></outerBoundaryIs>';
    // Inner rings (holes) — preserved so footprints with courtyards survive.
    for (var i = 1; i < rings.length; i++) {
      out += '<innerBoundaryIs><LinearRing><coordinates>' +
        kmlRing(rings[i]) + '</coordinates></LinearRing></innerBoundaryIs>';
    }
    return out + '</Polygon>';
  }
  function kmlGeometry(g) {
    if (!g) return '';
    if (g.type === 'Point') return '<Point><coordinates>' + kmlCoord(g.coordinates) + '</coordinates></Point>';
    if (g.type === 'LineString') return '<LineString><coordinates>' + g.coordinates.map(kmlCoord).join(' ') + '</coordinates></LineString>';
    if (g.type === 'MultiLineString') {
      return '<MultiGeometry>' + (g.coordinates || []).map(function (line) {
        return '<LineString><coordinates>' + line.map(kmlCoord).join(' ') + '</coordinates></LineString>';
      }).join('') + '</MultiGeometry>';
    }
    if (g.type === 'Polygon') return kmlPolygon(g.coordinates || []);
    if (g.type === 'MultiPolygon') {
      return '<MultiGeometry>' + (g.coordinates || []).map(kmlPolygon).join('') + '</MultiGeometry>';
    }
    return '';
  }
  // Internal / binary keys to skip when building ExtendedData.
  var KML_SKIP_KEYS = { name: 1, Name: 1 };
  function featureToPlacemark(f) {
    var g = f && f.geometry; if (!g) return '';
    var props = f.properties || {};
    var nm = props.name || props.Name || '';
    var out = '<Placemark>';
    if (nm) out += '<name>' + esc(nm) + '</name>';
    var dataKeys = Object.keys(props).filter(function (k) {
      return k.charAt(0) !== '_' && !KML_SKIP_KEYS[k] && props[k] != null && props[k] !== '';
    });
    if (dataKeys.length) {
      out += '<ExtendedData>';
      dataKeys.forEach(function (k) {
        out += '<Data name="' + esc(k) + '"><value>' + esc(String(props[k])) + '</value></Data>';
      });
      out += '</ExtendedData>';
    }
    return out + kmlGeometry(g) + '</Placemark>';
  }
  // Single FeatureCollection → flat KML document.
  function geojsonToKml(fc, layerName) {
    var feats = (fc && fc.features) || [];
    var out = KML_HEADER + '<name>' + esc(layerName || 'layer') + '</name>';
    feats.forEach(function (f) { out += featureToPlacemark(f); });
    return out + '</Document></kml>';
  }
  // Many layers → one KML document, one <Folder> per layer so the structure
  // reads cleanly in Google Earth / QGIS / QField.
  function layersToKml(layerFCs, docName) {
    var out = KML_HEADER + '<name>' + esc(docName || 'project') + '</name>';
    (layerFCs || []).forEach(function (entry) {
      out += '<Folder><name>' + esc(entry.name || 'layer') + '</name>';
      ((entry.fc && entry.fc.features) || []).forEach(function (f) { out += featureToPlacemark(f); });
      out += '</Folder>';
    });
    return out + '</Document></kml>';
  }

  // ---------------------------------------------------------------
  // Main mount
  // ---------------------------------------------------------------
  function mount(host) {
    var L = window.L;
    if (!L) { console.warn('[KUKLGis] Leaflet not loaded'); return null; }
    if (!host) { console.warn('[KUKLGis] no host element'); return null; }
    if (host._kuklGis) return host._kuklGis;

    // ---- Build DOM skeleton ----
    host.classList.add('gis-host');
    host.innerHTML =
      '<div class="gis-sidebar" data-role="sidebar">' +
      '  <div class="gis-side-head gis-side-top"><strong>GIS Tools</strong>' +
      '    <button type="button" class="gis-panel-close" data-act="panel-close" title="Hide panel">\u00d7</button></div>' +
      '  <div class="gis-tabs" data-role="gis-tabs">' +
      '    <button type="button" class="gis-tab active" data-tab="layers">\ud83d\uddfa Layers</button>' +
      '    <button type="button" class="gis-tab" data-tab="project">\ud83d\udcca Project</button>' +
      '    <button type="button" class="gis-tab" data-tab="import">\ud83d\udce5 Import</button>' +
      '    <button type="button" class="gis-tab" data-tab="gps">\ud83d\udce1 GPS</button>' +
      '  </div>' +
      '  <div class="gis-tab-content active" data-content="layers">' +
      '    <div class="gis-new-row">' +
      '      <select class="gis-cat-select" data-role="cat-select" title="Feature type for the next new layer">' +
      '        <option value="building">Buildings (point + footprint)</option>' +
      '        <option value="connection">Connections (point)</option>' +
      '        <option value="valve">Valves (point)</option>' +
      '        <option value="hydrant">Fire Hydrants (point)</option>' +
      '        <option value="meter">Meters (point)</option>' +
      '        <option value="pipe">Pipes (line)</option>' +
      '        <option value="generic">Generic</option>' +
      '      </select>' +
      '      <button type="button" class="btn btn-mini btn-primary" data-act="new-layer">+ NEW</button>' +
      '    </div>' +
      '    <div class="gis-bwiz-row" data-role="bwiz-row" hidden>' +
      '      <button type="button" class="btn btn-mini btn-primary gis-bwiz-launch" data-act="add-building">\uff0b Add Building (point + footprint)</button>' +
      '    </div>' +
      '    <div class="gis-layer-list" data-role="layers"></div>' +
      '    <label class="gis-ref-toggle"><input type="checkbox" data-role="dma-toggle"> Show DMA reference network</label>' +
      '  </div>' +
      '  <div class="gis-tab-content" data-content="project">' +
      '    <div class="gis-tab-section">' +
      '      <div class="gis-tab-section-head">Summary</div>' +
      '      <button type="button" class="btn btn-outline gis-full-btn" data-act="dashboard">\u2637 PROJECT SUMMARY</button>' +
      '    </div>' +
      '    <div class="gis-tab-section">' +
      '      <div class="gis-tab-section-head">Export All Layers</div>' +
      '      <div class="gis-btn-grid">' +
      '        <button type="button" class="btn btn-outline" data-act="proj-geojson">\ud83d\uddfa GeoJSON</button>' +
      '        <button type="button" class="btn btn-outline" data-act="proj-kml">\ud83c\udf10 KML</button>' +
      '        <button type="button" class="btn btn-outline" data-act="proj-xlsx">\ud83d\udcca Excel</button>' +
      '      </div>' +
      '    </div>' +
      '    <p class="gis-tip">Export the entire project (all layers) in one file. Individual layers can also be exported from their menu in the Layers tab.</p>' +
      '  </div>' +
      '  <div class="gis-tab-content" data-content="import">' +
      '    <div class="gis-tab-section">' +
      '      <div class="gis-tab-section-head">Import GIS Data</div>' +
      '      <div class="gis-import-grid">' +
      '        <label class="gis-import-btn">' +
      '          <span class="gis-import-ic">\ud83d\udce6</span>' +
      '          <span class="gis-import-lbl">Shapefile<small>.zip</small></span>' +
      '          <input type="file" accept=".zip" data-role="imp-shp" hidden>' +
      '        </label>' +
      '        <label class="gis-import-btn">' +
      '          <span class="gis-import-ic">\ud83d\uddfa</span>' +
      '          <span class="gis-import-lbl">GeoJSON<small>.geojson / .json</small></span>' +
      '          <input type="file" accept=".geojson,.json" data-role="imp-geojson" hidden>' +
      '        </label>' +
      '        <label class="gis-import-btn">' +
      '          <span class="gis-import-ic">\ud83c\udf10</span>' +
      '          <span class="gis-import-lbl">KML / GPX<small>.kml / .gpx</small></span>' +
      '          <input type="file" accept=".kml,.gpx" data-role="imp-kmlgpx" hidden>' +
      '        </label>' +
      '        <label class="gis-import-btn">' +
      '          <span class="gis-import-ic">\ud83d\udcca</span>' +
      '          <span class="gis-import-lbl">Spreadsheet<small>.xlsx / .csv</small></span>' +
      '          <input type="file" accept=".xlsx,.xls,.csv" data-role="imp-excel" hidden>' +
      '        </label>' +
      '      </div>' +
      '    </div>' +
      '    <p class="gis-tip">Import existing GIS files. Features will be sorted into layers by type (Building, Connection, Pipe, etc.) or a new layer will be created. Spreadsheets need lat/lng columns.</p>' +
      '  </div>' +
      '  <div class="gis-tab-content" data-content="gps">' +
      '    <div class="gis-tab-section">' +
      '      <div class="gis-tab-section-head">GNSS Receiver</div>' +
      '      <div class="gis-gnss-status" data-role="gnss-status">Internal device GPS</div>' +
      '      <div class="gis-gnss-readout" data-role="gnss-readout" hidden>' +
      '        <div><span>Fix</span><b data-role="gnss-fix">\u2014</b></div>' +
      '        <div><span>Sats</span><b data-role="gnss-sats">\u2014</b></div>' +
      '        <div><span>\u00b1 m</span><b data-role="gnss-acc">\u2014</b></div>' +
      '        <div class="wide"><span>Lat</span><b data-role="gnss-lat">\u2014</b></div>' +
      '        <div class="wide"><span>Lng</span><b data-role="gnss-lng">\u2014</b></div>' +
      '      </div>' +
      '      <div class="gis-gnss-btns">' +
      '        <button type="button" class="btn btn-outline" data-act="gnss-ble">\ud83d\udcf6 Bluetooth</button>' +
      '        <button type="button" class="btn btn-outline" data-act="gnss-serial">\ud83d\udd0c Serial / USB</button>' +
      '      </div>' +
      '      <button type="button" class="btn btn-mini btn-danger gis-gnss-disc" data-act="gnss-disconnect" hidden>DISCONNECT</button>' +
      '      <button type="button" class="btn btn-primary gis-full-btn gis-gnss-drop" data-act="gnss-drop" hidden>\ud83d\udccd DROP POINT AT GNSS POSITION</button>' +
      '    </div>' +
      '    <p class="gis-tip">Connect an external GNSS receiver (via Bluetooth or USB serial) for higher accuracy than phone GPS. Use "Drop Point" to capture a survey point at the current GNSS position.</p>' +
      '  </div>' +
      '</div>' +
      '<div class="gis-map-wrap"><div class="gis-map" data-role="map"></div>' +
      '  <div class="gis-sidebar-backdrop" data-act="sidebar-backdrop"></div>' +
      '  <button type="button" class="gis-panel-toggle" data-act="panel-toggle" title="Show tools">\u2630 Tools</button>' +
      '  <div class="gis-attr" data-role="attr" hidden>' +
      '    <div class="gis-attr-card">' +
      '      <div class="gis-attr-head"><strong data-role="attr-title">Attributes</strong>' +
      '        <button type="button" class="gis-attr-x" data-act="attr-close" title="Close">\u00d7</button></div>' +
      '      <div class="gis-attr-body" data-role="attr-body"></div>' +
      '      <div class="gis-attr-foot">' +
      '        <button type="button" class="btn btn-mini btn-outline" data-act="attr-zoom">ZOOM</button>' +
      '        <button type="button" class="btn btn-mini btn-outline" data-act="attr-redraw" hidden>\u21ba REDRAW</button>' +
      '        <button type="button" class="btn btn-mini btn-outline" data-act="attr-report" hidden>\u29c9 REPORT</button>' +
      '        <button type="button" class="btn btn-mini btn-danger" data-act="attr-del">DELETE</button>' +
      '        <button type="button" class="btn btn-mini btn-primary" data-act="attr-save">SAVE</button>' +
      '      </div>' +
      '    </div>' +
      '  </div>' +
      '  <div class="gis-bwiz" data-role="bwiz" hidden>' +
      '    <div class="gis-bwiz-card">' +
      '      <div class="gis-bwiz-head"><strong>Add Building</strong>' +
      '        <button type="button" class="gis-attr-x" data-act="bwiz-close" title="Cancel">\u00d7</button></div>' +
      '      <div class="gis-bwiz-body">' +
      '        <div class="gis-bwiz-sec">' +
      '          <div class="gis-bwiz-step">1 \u00b7 Building details</div>' +
      '          <label class="gis-attr-field"><span>Surveyor</span><input type="text" data-bkey="surveyor"></label>' +
      '          <label class="gis-attr-field"><span>Date</span><input type="date" data-bkey="date"></label>' +
      '          <label class="gis-attr-field"><span>Block</span><input type="text" data-bkey="block"></label>' +
      '          <label class="gis-attr-field"><span>Office / Occupant (1)</span><input type="text" data-bkey="office_name"></label>' +
      '          <label class="gis-attr-field"><span>Office / Occupant (2)</span><input type="text" data-bkey="office_name_2"></label>' +
      '          <label class="gis-attr-field"><span>Office / Occupant (3)</span><input type="text" data-bkey="office_name_3"></label>' +
      '          <label class="gis-attr-field"><span>Meter Status</span>' +
      '            <select data-bkey="meter_status">' +
      '              <option value="">\u2014 Select \u2014</option>' +
      '              <option value="Present and Working">Present and Working</option>' +
      '              <option value="Present but not Working">Present but not Working</option>' +
      '              <option value="Not Present">Not Present</option>' +
      '            </select>' +
      '          </label>' +
      '        </div>' +
      '        <div class="gis-bwiz-sec">' +
      '          <div class="gis-bwiz-step">2 \u00b7 Capture geometry</div>' +
      '          <div class="gis-bwiz-geoms">' +
      '            <button type="button" class="gis-bwiz-geom" data-act="bwiz-draw-point">' +
      '              <span class="gis-bwiz-geom-ic">\u25cf</span>' +
      '              <span class="gis-bwiz-geom-lbl">Draw Point</span>' +
      '              <span class="gis-bwiz-geom-stat" data-role="bwiz-pt-stat">Pending</span></button>' +
      '            <button type="button" class="gis-bwiz-geom" data-act="bwiz-draw-polygon">' +
      '              <span class="gis-bwiz-geom-ic">\u25b0</span>' +
      '              <span class="gis-bwiz-geom-lbl">Draw Polygon</span>' +
      '              <span class="gis-bwiz-geom-stat" data-role="bwiz-pg-stat">Pending</span></button>' +
      '          </div>' +
      '          <div class="gis-bwiz-hint" data-role="bwiz-hint">Capture a point and/or a footprint. Both share the same attributes.</div>' +
      '        </div>' +
      '        <div class="gis-bwiz-sec gis-bwiz-locked" data-role="bwiz-more">' +
      '          <div class="gis-bwiz-step">3 \u00b7 More details</div>' +
      '          <label class="gis-attr-field"><span>Floors</span><input type="number" inputmode="decimal" step="any" data-bkey="floors"></label>' +
      '          <label class="gis-attr-field"><span>Area (m\u00b2) \u2014 auto (footprint)</span><input type="number" data-bkey="area_m2" readonly></label>' +
      '          <label class="gis-attr-field"><span>Built-up Area (m\u00b2) \u2014 auto</span><input type="number" data-bkey="builtup_m2" readonly></label>' +
      '          <label class="gis-attr-field"><span>Remarks</span><textarea rows="2" data-bkey="remarks"></textarea></label>' +
      '          <div class="gis-bwiz-photos" data-role="bwiz-photos"></div>' +
      '        </div>' +
      '      </div>' +
      '      <div class="gis-bwiz-foot">' +
      '        <button type="button" class="btn btn-mini btn-outline" data-act="bwiz-cancel">CANCEL</button>' +
      '        <button type="button" class="btn btn-mini btn-primary" data-act="bwiz-save" disabled>SAVE BUILDING</button>' +
      '      </div>' +
      '    </div>' +
      '  </div>' +
      '  <div class="gis-table" data-role="table" hidden>' +
      '    <div class="gis-table-card">' +
      '      <div class="gis-table-head"><strong data-role="table-title">Attribute table</strong>' +
      '        <span class="gis-table-actions">' +
      '          <button type="button" class="gis-table-exp" data-act="table-csv" title="Export to CSV">CSV</button>' +
      '          <button type="button" class="gis-table-exp" data-act="table-xlsx" title="Export to Excel">XLSX</button>' +
      '        </span>' +
      '        <button type="button" class="gis-attr-x" data-act="table-close" title="Close">\u00d7</button></div>' +
      '      <div class="gis-table-wrap" data-role="table-wrap"></div>' +
      '    </div>' +
      '  </div>' +
      '  <div class="gis-table" data-role="dash" hidden>' +
      '    <div class="gis-table-card">' +
      '      <div class="gis-table-head"><strong>Project Summary</strong>' +
      '        <button type="button" class="gis-attr-x" data-act="dash-close" title="Close">\u00d7</button></div>' +
      '      <div class="gis-table-wrap gis-dash-body" data-role="dash-body"></div>' +
      '    </div>' +
      '  </div>' +
      '</div>';

    var $ = function (r) { return host.querySelector('[data-role="' + r + '"]'); };
    var mapEl = $('map');
    var attrPanel = $('attr');
    var attrTitle = $('attr-title');
    var attrBody = $('attr-body');
    var tablePanel = $('table');
    var tableTitle = $('table-title');
    var tableWrap = $('table-wrap');
    var dashPanel = $('dash');
    var dashBody = $('dash-body');
    var reportBtn = host.querySelector('[data-act="attr-report"]');
    var redrawBtn = host.querySelector('[data-act="attr-redraw"]');
    var editorTarget = null;
    var currentTableMeta = null;

    // ---- Init map ----
    // maxZoom 22 lets phones zoom in far closer than the tiles natively go;
    // tiles upscale past maxNativeZoom (19) so close survey work stays usable.
    var map = L.map(mapEl, { zoomControl: true, maxZoom: 22 }).setView(KTM_DEFAULT, 14);
    var osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 22, maxNativeZoom: 19, attribution: '© OpenStreetMap',
    }).addTo(map);
    var sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 22, maxNativeZoom: 19, attribution: 'Esri',
    });
    L.control.layers({ 'Street': osm, 'Satellite': sat }, null, { position: 'topright', collapsed: true }).addTo(map);

    // ---- Geoman toolbar ----
    if (map.pm) {
      map.pm.addControls({
        position: 'topleft',
        drawCircleMarker: false,
        rotateMode: true,
        cutPolygon: true,
      });
      map.pm.setGlobalOptions({ snappable: true, snapDistance: 20 });
    } else {
      toast('Drawing tools failed to load');
    }

    // Active building geometry choice (Point or Area). Buildings are a single
    // Buildings are created through the "Add Building" wizard (a single shared
    // attribute set linked to BOTH a point and a polygon), so their direct draw
    // tools are hidden — see openBuildingWizard().

    // Show only the draw tools that match the active layer's geometry.
    function applyToolsForCategory(category) {
      if (!map.pm || !map.pm.Toolbar || !map.pm.Toolbar.getButtons) return;
      var schema = SCHEMAS[category] || SCHEMAS.generic;
      var geom = schema.geom; // 'point' | 'line' | 'polygon' | 'any'
      var isPoint = geom === 'point';
      var isLine = geom === 'line';
      var isPolygon = geom === 'polygon';
      var anyGeom = !isPoint && !isLine && !isPolygon;
      // Buildings capture geometry only through the wizard, so hide every direct
      // draw tool while a Building layer is active (edit/drag/cut stay available).
      if (category === 'building') {
        isPoint = false; isLine = false; isPolygon = false; anyGeom = false;
      }
      var vis = {
        drawMarker: isPoint || anyGeom,
        drawPolyline: isLine || anyGeom,
        drawRectangle: isPolygon || anyGeom,
        drawPolygon: isPolygon || anyGeom,
        drawCircle: anyGeom,
        drawText: anyGeom,
      };
      var btns = map.pm.Toolbar.getButtons();
      Object.keys(vis).forEach(function (name) {
        var b = btns[name];
        var node = b && (b.buttonsDomNode || (b._button && b._button.buttonsDomNode));
        if (node) node.style.display = vis[name] ? '' : 'none';
      });
    }

    // Show the "Add Building" launcher only when a Building layer is active.
    function updateBwizRow() {
      var row = $('bwiz-row');
      if (!row) return;
      var meta = layers[activeId];
      row.hidden = !(meta && meta.category === 'building');
    }

    // ---- Live user location (device GPS blue-dot, like Google Maps) ----
    var meWatchId = null, meMarker = null, meAccCircle = null, meFollow = false, meCenteredOnce = false;
    var LocateControl = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function () {
        var c = L.DomUtil.create('div', 'leaflet-bar gis-locate-ctl');
        var a = L.DomUtil.create('a', 'gis-locate-btn', c);
        a.href = '#'; a.title = 'Show my live location'; a.setAttribute('role', 'button');
        a.innerHTML = '\u25C9';
        L.DomEvent.on(a, 'click', function (e) {
          L.DomEvent.stop(e);
          toggleLocate();
        });
        this._btn = a;
        return c;
      },
    });
    var locateCtl = new LocateControl();
    map.addControl(locateCtl);

    function setLocateActive(on) {
      meFollow = on;
      if (locateCtl._btn) locateCtl._btn.classList.toggle('active', on);
    }

    function toggleLocate() {
      if (meWatchId != null) { stopLocate(); return; }
      if (!navigator.geolocation) { toast('Geolocation not available on this device'); return; }
      toast('Locating you…');
      meCenteredOnce = false;
      setLocateActive(true);
      meWatchId = navigator.geolocation.watchPosition(function (pos) {
        var ll = [pos.coords.latitude, pos.coords.longitude];
        var acc = pos.coords.accuracy || 0;
        if (!meMarker) {
          meMarker = L.circleMarker(ll, {
            radius: 7, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1,
            className: 'gis-me-dot', pane: 'markerPane',
          }).addTo(map);
          meMarker.bindTooltip('You are here', { direction: 'top' });
        } else { meMarker.setLatLng(ll); }
        if (acc > 0) {
          if (!meAccCircle) {
            meAccCircle = L.circle(ll, { radius: acc, color: '#1a73e8', weight: 1, fillColor: '#1a73e8', fillOpacity: 0.1, interactive: false }).addTo(map);
          } else { meAccCircle.setLatLng(ll); meAccCircle.setRadius(acc); }
        }
        if (!meCenteredOnce) { meCenteredOnce = true; try { map.setView(ll, Math.max(map.getZoom(), 17)); } catch (_) {} }
      }, function (err) {
        console.warn('[GIS] geolocation error', err);
        toast(err && err.code === 1 ? 'Location permission denied' : 'Could not get your location');
        stopLocate();
      }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
    }

    function stopLocate() {
      if (meWatchId != null) { try { navigator.geolocation.clearWatch(meWatchId); } catch (_) {} meWatchId = null; }
      setLocateActive(false);
      if (meMarker) { try { map.removeLayer(meMarker); } catch (_) {} meMarker = null; }
      if (meAccCircle) { try { map.removeLayer(meAccCircle); } catch (_) {} meAccCircle = null; }
    }

    // ---- Layer model ----
    // layers: id → { id, name, color, visible, group:L.FeatureGroup, row:DOM }
    var layers = Object.create(null);
    var activeId = null;
    var colorIdx = 0;
    var dmaCtl = null;

    function nextColor() { var c = PALETTE[colorIdx % PALETTE.length]; colorIdx++; return c; }
    function catSelectValue() { var s = $('cat-select'); return (s && s.value) || 'generic'; }

    function styleFor(color) {
      return { color: color, weight: 3, fillColor: color, fillOpacity: 0.25 };
    }

    // Distinct line styling per pipe material so the network reads at a glance.
    var PIPE_MATERIAL_STYLE = {
      HDPE: { color: '#1a7f1a', dash: null },          // solid green
      DI:   { color: '#0a3d91', dash: null },          // solid dark blue
      GI:   { color: '#b07000', dash: '9,6' },         // dashed amber
      CI:   { color: '#7d3cb5', dash: '2,7' },         // dotted purple
      AC:   { color: '#b23a00', dash: '14,5,3,5' },    // dash-dot rust
    };
    function pipeStyle(material, baseColor) {
      var st = PIPE_MATERIAL_STYLE[String(material || '').toUpperCase()];
      return {
        color: st ? st.color : (baseColor || CATEGORY_COLOR.pipe),
        weight: 4, opacity: 1, dashArray: st ? st.dash : null, fill: false,
      };
    }
    function applyPipeStyle(meta, lyr) {
      if (!lyr || !lyr.setStyle) return;
      var p = (lyr.feature && lyr.feature.properties) || {};
      try { lyr.setStyle(pipeStyle(p.material, meta.color)); } catch (_) {}
    }
    // Tiny inline SVG line preview for a pipe material (used in the legend key).
    function pipeLineSVG(material) {
      var st = pipeStyle(material);
      var dash = st.dashArray ? ' stroke-dasharray="' + st.dashArray + '"' : '';
      return '<svg width="34" height="10" viewBox="0 0 34 10" aria-hidden="true">' +
        '<line x1="1" y1="5" x2="33" y2="5" stroke="' + esc(st.color) +
        '" stroke-width="3" stroke-linecap="round"' + dash + '/></svg>';
    }

    // ---- Custom point symbols (category-shaped divIcons, like SW Maps) ----
    function pointSymbolSVG(category, color) {
      var c = esc(color);
      if (category === 'building') {
        return '<svg viewBox="0 0 22 22" width="22" height="22">' +
          '<polygon points="3,9 11,2 19,9" fill="' + c + '" stroke="#fff" stroke-width="1.6"/>' +
          '<rect x="5" y="8.5" width="12" height="10.5" rx="1" fill="' + c + '" stroke="#fff" stroke-width="1.6"/>' +
          '<rect x="9" y="12" width="4" height="7" fill="#fff" opacity="0.85"/></svg>';
      }
      if (category === 'valve') {
        return '<svg viewBox="0 0 22 22" width="22" height="22">' +
          '<polygon points="11,2 20,11 11,20 2,11" fill="' + c + '" stroke="#fff" stroke-width="1.8"/>' +
          '<rect x="9.6" y="6" width="2.8" height="10" fill="#fff" opacity="0.9"/>' +
          '<rect x="6" y="9.6" width="10" height="2.8" fill="#fff" opacity="0.9"/></svg>';
      }
      if (category === 'connection') {
        return '<svg viewBox="0 0 22 22" width="22" height="22">' +
          '<path d="M11 2 C 6 8, 4 12, 6.5 16 C 9 20, 13 20, 15.5 16 C 18 12, 16 8, 11 2 Z" ' +
          'fill="' + c + '" stroke="#fff" stroke-width="1.6"/>' +
          '<circle cx="11" cy="13.5" r="2.6" fill="#fff" opacity="0.9"/></svg>';
      }
      if (category === 'hydrant') {
        return '<svg viewBox="0 0 22 22" width="22" height="22">' +
          '<rect x="7.5" y="6" width="7" height="11" rx="2.4" fill="' + c + '" stroke="#fff" stroke-width="1.5"/>' +
          '<rect x="9.3" y="3" width="3.4" height="3.2" rx="1.1" fill="' + c + '" stroke="#fff" stroke-width="1.3"/>' +
          '<rect x="3.8" y="10.4" width="3.4" height="3" rx="1" fill="' + c + '" stroke="#fff" stroke-width="1.2"/>' +
          '<rect x="14.8" y="10.4" width="3.4" height="3" rx="1" fill="' + c + '" stroke="#fff" stroke-width="1.2"/>' +
          '<circle cx="11" cy="10" r="1.7" fill="#fff" opacity="0.9"/>' +
          '<rect x="5.5" y="17" width="11" height="2.6" rx="1.1" fill="' + c + '" stroke="#fff" stroke-width="1.3"/></svg>';
      }
      if (category === 'meter') {
        return '<svg viewBox="0 0 22 22" width="22" height="22">' +
          '<circle cx="11" cy="11" r="8.2" fill="' + c + '" stroke="#fff" stroke-width="1.6"/>' +
          '<circle cx="11" cy="11" r="4.6" fill="#fff" opacity="0.92"/>' +
          '<line x1="11" y1="11" x2="13.9" y2="8.1" stroke="' + c + '" stroke-width="1.7" stroke-linecap="round"/>' +
          '<circle cx="11" cy="11" r="1.1" fill="' + c + '"/></svg>';
      }
      // generic / other → circle dot
      return '<svg viewBox="0 0 22 22" width="22" height="22">' +
        '<circle cx="11" cy="11" r="7.5" fill="' + c + '" stroke="#fff" stroke-width="2"/></svg>';
    }
    function makePointIcon(category, color) {
      return L.divIcon({
        className: 'gis-sym gis-sym-' + category,
        html: pointSymbolSVG(category, color),
        iconSize: [22, 22], iconAnchor: [11, 11], tooltipAnchor: [0, -10],
      });
    }
    function makePointMarker(meta, latlng) {
      return L.marker(latlng, { icon: makePointIcon(meta.category, meta.color) });
    }
    function isIconMarker(lyr) {
      return (lyr instanceof L.Marker) && !(lyr instanceof L.CircleMarker);
    }

    // Actual rendered geometry of a Leaflet layer (independent of schema) so
    // dual-geometry building layers compute the right derived fields and lock
    // only their point features. Note: L.Polygon extends L.Polyline, so test
    // Polygon first.
    function layerGeomType(lyr) {
      if (!lyr) return null;
      if ((lyr instanceof L.CircleMarker) || (lyr instanceof L.Marker)) return 'point';
      if (lyr instanceof L.Polygon) return 'polygon';
      if (lyr instanceof L.Polyline) return 'line';
      return null;
    }

    function applyStyleToGroup(meta, color) {
      meta.group.eachLayer(function (lyr) {
        if (isIconMarker(lyr)) {
          try { lyr.setIcon(makePointIcon(meta.category, color)); } catch (_) {}
        } else if (meta.category === 'pipe' && lyr.setStyle) {
          // Pipes keep their per-material colour/dash; the layer colour is only
          // a fallback for features whose material isn't in the style table.
          applyPipeStyle(meta, lyr);
        } else if (lyr.setStyle) {
          try { lyr.setStyle(styleFor(color)); } catch (_) {}
          if (lyr instanceof L.CircleMarker) {
            try { lyr.setStyle({ color: color, fillColor: color, fillOpacity: 0.9 }); } catch (_) {}
          }
        }
      });
    }

    // ---- Legend (auto-built from current layers) ----
    var legendCtl = null, legendBody = null, legendCollapsed = false;
    var LegendControl = L.Control.extend({
      options: { position: 'bottomright' },
      onAdd: function () {
        var c = L.DomUtil.create('div', 'gis-legend');
        var head = L.DomUtil.create('div', 'gis-legend-head', c);
        head.innerHTML = '<span>Legend</span><button type="button" class="gis-legend-toggle" title="Collapse">\u2013</button>';
        legendBody = L.DomUtil.create('div', 'gis-legend-body', c);
        L.DomEvent.disableClickPropagation(c);
        L.DomEvent.on(head.querySelector('.gis-legend-toggle'), 'click', function () {
          legendCollapsed = !legendCollapsed;
          c.classList.toggle('collapsed', legendCollapsed);
          head.querySelector('.gis-legend-toggle').textContent = legendCollapsed ? '+' : '\u2013';
        });
        return c;
      },
    });

    function legendSwatch(category, color) {
      var schema = SCHEMAS[category] || SCHEMAS.generic;
      if (schema.geom === 'line') {
        return '<span class="gis-leg-line" style="background:' + esc(color) + '"></span>';
      }
      if (schema.geom === 'polygon') {
        return '<span class="gis-leg-poly" style="border-color:' + esc(color) + ';background:' + esc(color) + '33"></span>';
      }
      return '<span class="gis-leg-sym">' + pointSymbolSVG(category, color) + '</span>';
    }
    function rebuildLegend() {
      if (!legendBody) return;
      // Only list layers that are currently shown on the map — hiding ("cutting")
      // a layer removes both its features and its legend entry.
      var ids = Object.keys(layers).filter(function (k) { return layers[k].visible; });
      if (!ids.length) { legendBody.innerHTML = '<div class="gis-leg-empty">No visible layers</div>'; return; }
      var html = ids.map(function (k) {
        var m = layers[k];
        var schema = SCHEMAS[m.category] || SCHEMAS.generic;
        return '<div class="gis-leg-row">' +
          legendSwatch(m.category, m.color) +
          '<span class="gis-leg-name">' + esc(m.name) + '</span>' +
          '<span class="gis-leg-cat">' + esc(schema.label) + '</span></div>';
      }).join('');
      // Pipe-material key (colour + dash pattern) so the network reads at a glance.
      var hasPipe = ids.some(function (k) { return layers[k].category === 'pipe'; });
      if (hasPipe) {
        html += '<div class="gis-leg-sub">Pipe material</div>';
        html += Object.keys(PIPE_MATERIAL_STYLE).map(function (mat) {
          return '<div class="gis-leg-row gis-leg-mat">' +
            '<span class="gis-leg-line-svg">' + pipeLineSVG(mat) + '</span>' +
            '<span class="gis-leg-name">' + mat + '</span></div>';
        }).join('');
      }
      legendBody.innerHTML = html;
    }
    legendCtl = new LegendControl();
    map.addControl(legendCtl);

    // ---- Declutter permanent labels at low zoom ----
    var LABEL_MIN_ZOOM = 17;
    function updateLabelDeclutter() {
      var hide = map.getZoom() < LABEL_MIN_ZOOM;
      if (mapEl) mapEl.classList.toggle('gis-hide-labels', hide);
    }
    map.on('zoomend', updateLabelDeclutter);
    updateLabelDeclutter();

    // Persist one layer to IndexedDB.
    function persist(id) {
      var meta = layers[id];
      if (!meta) return;
      var fc = groupToGeoJSON(meta.group);
      dbPutLayer({
        id: id, name: meta.name, category: meta.category, color: meta.color,
        visible: meta.visible, geojson: fc, updatedAt: Date.now(),
      }).catch(function (e) { console.warn('[GIS] persist failed', e); });
    }

    function groupToGeoJSON(group) {
      var features = [];
      group.eachLayer(function (lyr) {
        if (typeof lyr.toGeoJSON === 'function') {
          var gj = lyr.toGeoJSON();
          if (gj.type === 'FeatureCollection') features = features.concat(gj.features);
          else features.push(gj);
        }
      });
      return { type: 'FeatureCollection', features: features };
    }

    // ---- Layer creation ----
    function createLayer(opts) {
      opts = opts || {};
      var id = opts.id || uid();
      var category = opts.category || 'generic';
      if (!SCHEMAS[category]) category = 'generic';
      var color = opts.color || CATEGORY_COLOR[category] || nextColor();
      var group = L.featureGroup();
      if (opts.visible !== false) group.addTo(map);
      var meta = {
        id: id,
        name: opts.name || (SCHEMAS[category].label + ' ' + (Object.keys(layers).length + 1)),
        category: category,
        color: color,
        visible: opts.visible !== false,
        group: group,
        row: null,
      };
      layers[id] = meta;

      // Wire feature edits → re-persist
      group.on('pm:edit pm:update pm:dragend', function () { persist(id); });

      buildRow(meta);
      if (!activeId) setActive(id);
      rebuildLegend();
      return meta;
    }

    function loadGeoJSONInto(meta, fc) {
      var added = L.geoJSON(fc, {
        style: styleFor(meta.color),
        pointToLayer: function (f, latlng) {
          return makePointMarker(meta, latlng);
        },
        onEachFeature: function (f, lyr) { attachFeatureBehavior(meta, lyr, false); },
      });
      added.eachLayer(function (lyr) { meta.group.addLayer(lyr); });
    }

    function ensureFeatureProps(meta, lyr, isNew) {
      if (!lyr.feature) lyr.feature = { type: 'Feature', properties: {}, geometry: null };
      if (!lyr.feature.properties) lyr.feature.properties = {};
      var schema = SCHEMAS[meta.category] || SCHEMAS.generic;
      var p = lyr.feature.properties;
      schema.fields.forEach(function (f) { if (p[f.key] == null) p[f.key] = ''; });
      if (isNew) {
        if (!p.surveyor) p.surveyor = defaultSurveyor();
        if (!p.date) p.date = today();
      }
      // Derive area/length from the feature's ACTUAL geometry, not the schema,
      // so a Building drawn as a point stays blank while one drawn as an area
      // gets its footprint + built-up figures.
      var gt = layerGeomType(lyr);
      if (gt === 'line') {
        var len = lineLength(lyr);
        if (len != null && (isNew || !p.length_m)) p.length_m = len;
      }
      if (gt === 'polygon') {
        var a = polygonArea(lyr);
        if (a != null && (isNew || !p.area_m2)) p.area_m2 = a;
        if (meta.category === 'building') {
          var fl = parseFloat(p.floors) || 0;
          var ar2 = parseFloat(p.area_m2) || 0;
          if (ar2) p.builtup_m2 = Math.round(ar2 * (fl > 0 ? fl : 1) * 100) / 100;
        }
      }
    }

    function lineLength(lyr) {
      try {
        var lls = lyr.getLatLngs ? lyr.getLatLngs() : null;
        if (!lls) return null;
        while (lls.length && Array.isArray(lls[0])) lls = lls[0];
        var total = 0;
        for (var i = 1; i < lls.length; i++) total += map.distance(lls[i - 1], lls[i]);
        return Math.round(total * 100) / 100;
      } catch (_) { return null; }
    }

    // Spherical polygon area (m²) via L.GeometryUtil-style shoelace on the sphere.
    function polygonArea(lyr) {
      try {
        var lls = lyr.getLatLngs ? lyr.getLatLngs() : null;
        if (!lls) return null;
        while (lls.length && Array.isArray(lls[0]) && Array.isArray(lls[0][0])) lls = lls[0];
        var ring = Array.isArray(lls[0]) ? lls[0] : lls;
        if (!ring || ring.length < 3) return null;
        var R = 6378137, area = 0;
        var d2r = Math.PI / 180;
        for (var i = 0; i < ring.length; i++) {
          var p1 = ring[i], p2 = ring[(i + 1) % ring.length];
          area += (p2.lng - p1.lng) * d2r * (2 + Math.sin(p1.lat * d2r) + Math.sin(p2.lat * d2r));
        }
        area = Math.abs(area * R * R / 2.0);
        return Math.round(area * 100) / 100;
      } catch (_) { return null; }
    }

    // Representative lat/lng for ANY feature: points use their own position,
    // lines/polygons use the centre of their bounds (centroid-ish) so every
    // feature gets coordinates in the table and exports.
    function featureLatLng(lyr) {
      try {
        if (lyr.getLatLng) return lyr.getLatLng();
        if (lyr.getBounds) {
          var b = lyr.getBounds();
          if (b && b.isValid && b.isValid()) return b.getCenter();
        }
      } catch (_) {}
      return null;
    }

    function featureTitle(meta, p) {
      var schema = SCHEMAS[meta.category] || SCHEMAS.generic;
      p = p || {};
      var t = (schema.titleKey && p[schema.titleKey]) ||
              (schema.fallbackKey && p[schema.fallbackKey]) || '';
      return t ? String(t) : schema.label;
    }

    // Map label text. Buildings get "ID · Block" so completed survey points
    // are identifiable straight on the map; other point layers show their title.
    function featureLabel(meta, p) {
      p = p || {};
      if (meta.category === 'building') {
        var id = p.building_id || '';
        var blk = p.block || '';
        var s = [id, blk].filter(Boolean).join(' \u00b7 ');
        return s || '';
      }
      if (meta.category === 'valve') return p.valve_id || '';
      if (meta.category === 'pipe') return p.pipe_id || '';
      if (meta.category === 'connection') {
        var cid = p.connection_id || p.account_no || '';
        var cb = p.building_id || '';
        return [cid, cb].filter(Boolean).join(' \u00b7 ');
      }
      return featureTitle(meta, p) === (SCHEMAS[meta.category] || SCHEMAS.generic).label ? '' : featureTitle(meta, p);
    }

    function isPointLayer(lyr) {
      return (lyr instanceof L.CircleMarker) || (lyr instanceof L.Marker);
    }

    // Collect all known Building IDs across building layers so a Connection can
    // be linked to an existing building (datalist autocomplete).
    function allBuildingIds() {
      var ids = {};
      Object.keys(layers).forEach(function (k) {
        var m = layers[k];
        if (m.category !== 'building') return;
        m.group.eachLayer(function (lyr) {
          var p = lyr.feature && lyr.feature.properties;
          var bid = p && p.building_id;
          if (bid != null && String(bid).trim()) ids[String(bid).trim()] = true;
        });
      });
      return Object.keys(ids).sort();
    }

    // Default ID prefix + the schema field that holds the ID, per category.
    var ID_DEFAULTS = {
      building: { prefix: 'SD', key: 'building_id', noun: 'building' },
      connection: { prefix: 'C', key: 'connection_id', noun: 'connection' },
      valve: { prefix: 'V', key: 'valve_id', noun: 'valve' },
      pipe: { prefix: 'P', key: 'pipe_id', noun: 'pipe' },
      hydrant: { prefix: 'FH', key: 'hydrant_id', noun: 'fire hydrant' },
      meter: { prefix: 'M', key: 'meter_id', noun: 'meter' },
    };
    // True for categories that carry a meaningful, auto-numberable ID field.
    function canAutoNumber(category) { return !!ID_DEFAULTS[category]; }

    // Prefix used for self-generated IDs (editable via auto-number), per
    // category and remembered in localStorage.
    function categoryPrefix(category) {
      var def = (ID_DEFAULTS[category] || ID_DEFAULTS.building).prefix;
      try {
        var v = localStorage.getItem('kukl_gis_prefix_' + category);
        // Migrate the old building-only key.
        if (v == null && category === 'building') v = localStorage.getItem('kukl_gis_bprefix');
        return (v || def).trim() || def;
      } catch (_) { return def; }
    }
    // Back-compat shim — older code/migrations referenced buildingPrefix().
    function buildingPrefix() { return categoryPrefix('building'); }

    // Self-generated, collision-free Building ID. Scans every existing building
    // ID, finds the highest trailing number and returns PREFIX-### (zero-padded).
    function nextBuildingId() {
      var prefix = buildingPrefix();
      var max = 0;
      Object.keys(layers).forEach(function (k) {
        var m = layers[k];
        if (m.category !== 'building') return;
        m.group.eachLayer(function (lyr) {
          var p = lyr.feature && lyr.feature.properties;
          var bid = p && p.building_id ? String(p.building_id) : '';
          var match = bid.match(/(\d+)\s*$/);
          if (match) { var n = parseInt(match[1], 10); if (n > max) max = n; }
        });
      });
      return prefix + '-' + ('000' + (max + 1)).slice(-3);
    }

    function updateTooltip(meta, lyr) {
      var props = lyr.feature && lyr.feature.properties;
      var point = isPointLayer(lyr);
      // Building areas (polygons) also get a permanent centered label, like points.
      var permLabel = point || (meta.category === 'building' && layerGeomType(lyr) === 'polygon');
      var label = permLabel ? featureLabel(meta, props) : '';
      try {
        if (permLabel) {
          if (label) {
            if (lyr.getTooltip && lyr.getTooltip()) {
              lyr.setTooltipContent(label);
            } else {
              lyr.bindTooltip(label, {
                permanent: true, direction: point ? 'top' : 'center', offset: [0, point ? -6 : 0],
                className: 'gis-feat-label', opacity: 1,
              });
            }
          } else if (lyr.getTooltip && lyr.getTooltip()) {
            lyr.unbindTooltip();
          }
        } else {
          var t = featureTitle(meta, props);
          if (lyr.getTooltip && lyr.getTooltip()) lyr.setTooltipContent(t);
          else lyr.bindTooltip(t, { sticky: true });
        }
      } catch (_) {}
    }

    function inEditMode() {
      if (!map.pm) return false;
      return (map.pm.globalEditModeEnabled && map.pm.globalEditModeEnabled()) ||
             (map.pm.globalDragModeEnabled && map.pm.globalDragModeEnabled()) ||
             (map.pm.globalRemovalModeEnabled && map.pm.globalRemovalModeEnabled()) ||
             (map.pm.globalCutModeEnabled && map.pm.globalCutModeEnabled()) ||
             (map.pm.globalRotateModeEnabled && map.pm.globalRotateModeEnabled());
    }

    function attachFeatureBehavior(meta, lyr, isNew) {
      ensureFeatureProps(meta, lyr, isNew);
      updateTooltip(meta, lyr);
      // Colour pipes by material so the network reads at a glance.
      if (meta.category === 'pipe') applyPipeStyle(meta, lyr);
      // Building & connection POINT markers are fixed survey points — lock them
      // so they can't be accidentally dragged once placed, but keep them as snap
      // targets (snapIgnore:false) so pipes can still snap onto them. Building
      // AREAS (polygons) stay editable so their footprint can be reshaped.
      if ((meta.category === 'building' || meta.category === 'connection') && layerGeomType(lyr) === 'point') {
        try {
          lyr.options.pmIgnore = true;
          lyr.options.snapIgnore = false;
          if (window.L && L.PM && typeof L.PM.reInitLayer === 'function') L.PM.reInitLayer(lyr);
          else if (lyr.pm && lyr.pm.disable) lyr.pm.disable();
        } catch (_) {}
      }
      lyr.on('click', function () {
        if (inEditMode()) return;
        openAttributeEditor(meta, lyr);
      });
      lyr.on('pm:edit pm:update pm:dragend', function () {
        var pp = lyr.feature && lyr.feature.properties;
        var gt = layerGeomType(lyr);
        if (gt === 'line' && pp) {
          var len = lineLength(lyr);
          if (len != null) pp.length_m = len;
        }
        if (gt === 'polygon' && pp) {
          var ar = polygonArea(lyr);
          if (ar != null) pp.area_m2 = ar;
          if (meta.category === 'building') {
            var fl = parseFloat(pp.floors) || 0;
            var a2 = parseFloat(pp.area_m2) || 0;
            if (a2) pp.builtup_m2 = Math.round(a2 * (fl > 0 ? fl : 1) * 100) / 100;
          }
        }
        persist(meta.id);
      });
      lyr.on('pm:remove', function () { persist(meta.id); updateCount(meta); });
    }

    function openAttributeEditor(meta, lyr) {
      var schema = SCHEMAS[meta.category] || SCHEMAS.generic;
      ensureFeatureProps(meta, lyr, false);
      var props = lyr.feature.properties;
      editorTarget = { meta: meta, lyr: lyr };
      if (attrTitle) attrTitle.textContent = schema.label + ' attributes';
      // Per-building printable report (attributes + photos + map snippet).
      if (reportBtn) reportBtn.hidden = !(meta.category === 'building');
      // Redraw is offered for shapes you can trace over: footprints and lines.
      if (redrawBtn) { var rgt = layerGeomType(lyr); redrawBtn.hidden = !(rgt === 'polygon' || rgt === 'line'); }
      attrBody.innerHTML = '';
      // Schema fields first, then any extra imported properties as text inputs.
      // building_uuid / geometry_role are auto-managed links — show them, but
      // read-only, so they stay visible for verification yet can't be edited.
      var EXTRA_READONLY = { building_uuid: true, geometry_role: true };
      var EXTRA_LABELS = { building_uuid: 'Building UUID (link)', geometry_role: 'Geometry role' };
      var fields = schema.fields.slice();
      var known = {};
      fields.forEach(function (f) { known[f.key] = true; });
      Object.keys(props).forEach(function (k) {
        if (k.charAt(0) === '_') return;
        if (!known[k]) {
          known[k] = true;
          fields.push({ key: k, label: EXTRA_LABELS[k] || k, type: 'text', readonly: !!EXTRA_READONLY[k] });
        }
      });
      fields.forEach(function (fld) {
        var val = props[fld.key] != null ? props[fld.key] : '';
        var wrap = document.createElement('label');
        wrap.className = 'gis-attr-field';
        var span = document.createElement('span');
        span.textContent = fld.label;
        wrap.appendChild(span);
        var input;
        if (fld.type === 'select') {
          input = document.createElement('select');
          var blank = document.createElement('option');
          blank.value = ''; blank.textContent = '\u2014';
          input.appendChild(blank);
          (fld.options || []).forEach(function (o) {
            var op = document.createElement('option');
            op.value = o; op.textContent = o;
            if (String(val) === o) op.selected = true;
            input.appendChild(op);
          });
        } else if (fld.type === 'textarea') {
          input = document.createElement('textarea');
          input.rows = 2; input.value = val;
        } else {
          input = document.createElement('input');
          input.type = fld.type === 'number' ? 'number' : (fld.type === 'date' ? 'date' : 'text');
          input.value = val;
          // Touch keyboard hints for field use: numeric pad for numbers.
          if (fld.type === 'number') { input.setAttribute('inputmode', 'decimal'); input.step = 'any'; }
          if (fld.list === 'buildings') {
            var dlId = 'gis-dl-buildings';
            var dl = document.getElementById(dlId);
            if (!dl) { dl = document.createElement('datalist'); dl.id = dlId; document.body.appendChild(dl); }
            dl.innerHTML = allBuildingIds().map(function (b) {
              return '<option value="' + esc(b) + '"></option>';
            }).join('');
            input.setAttribute('list', dlId);
            input.placeholder = 'Type or pick a Building ID';
          }
        }
        if (fld.readonly) input.readOnly = true;
        input.dataset.key = fld.key;
        wrap.appendChild(input);
        attrBody.appendChild(wrap);
      });
      buildPhotoSection(meta, lyr);
      attrPanel.hidden = false;
    }

    // Capture a GPS fix for a photo: try the device, fall back to the
    // feature's own location so every photo still gets coordinates offline.
    function photoGeo(lyr, cb) {
      var fb = featureLatLng(lyr);
      var fallback = fb ? { lat: fb.lat, lng: fb.lng, acc: null, src: 'feature' } : null;
      if (!navigator.geolocation) { cb(fallback); return; }
      var done = false;
      try {
        navigator.geolocation.getCurrentPosition(function (pos) {
          if (done) return; done = true;
          cb({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy || null, src: 'gps' });
        }, function () {
          if (done) return; done = true; cb(fallback);
        }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 8000 });
      } catch (_) { cb(fallback); }
    }

    // Human-readable photo metadata. full=true -> date + time + coords + accuracy.
    function photoMetaText(ph, full) {
      var parts = [];
      if (ph.time) {
        var d = new Date(ph.time);
        var hh = ('0' + d.getHours()).slice(-2), mm = ('0' + d.getMinutes()).slice(-2);
        if (full) {
          var y = d.getFullYear(), mo = ('0' + (d.getMonth() + 1)).slice(-2), da = ('0' + d.getDate()).slice(-2);
          parts.push(y + '-' + mo + '-' + da + ' ' + hh + ':' + mm);
        } else {
          parts.push(hh + ':' + mm);
        }
      }
      if (ph.lat != null && ph.lng != null) {
        parts.push(ph.lat.toFixed(full ? 6 : 4) + ', ' + ph.lng.toFixed(full ? 6 : 4));
        if (full && ph.acc != null) parts.push('\u00b1' + Math.round(ph.acc) + 'm');
        if (full && ph.geoSrc === 'feature') parts.push('(feature loc.)');
      }
      return parts.join(full ? ' \u00b7 ' : ' \u00b7 ');
    }

    // ---- Field photos per feature (stored as dataURLs in props._photos) ----
    function buildPhotoSection(meta, lyr) {
      var props = lyr.feature.properties;
      if (!Array.isArray(props._photos)) props._photos = [];
      var isConn = meta && meta.category === 'connection';
      var sec = document.createElement('div');
      sec.className = 'gis-photo-sec';
      var head = document.createElement('div');
      head.className = 'gis-photo-head';
      head.innerHTML = '<span>Photos</span>';
      var btns = document.createElement('span');
      btns.className = 'gis-photo-btns';
      // General photo capture.
      var addLbl = document.createElement('label');
      addLbl.className = 'gis-photo-add';
      addLbl.textContent = '\uff0b Add';
      var fileIn = document.createElement('input');
      fileIn.type = 'file'; fileIn.accept = 'image/*';
      fileIn.setAttribute('capture', 'environment');
      fileIn.multiple = true; fileIn.hidden = true;
      addLbl.appendChild(fileIn);
      btns.appendChild(addLbl);
      // Connections also get a dedicated, auditable Meter photo button.
      var meterIn = null;
      if (isConn) {
        var meterLbl = document.createElement('label');
        meterLbl.className = 'gis-photo-add gis-photo-meter';
        meterLbl.textContent = '\uff0b Meter photo';
        meterIn = document.createElement('input');
        meterIn.type = 'file'; meterIn.accept = 'image/*';
        meterIn.setAttribute('capture', 'environment');
        meterIn.hidden = true;
        meterLbl.appendChild(meterIn);
        btns.appendChild(meterLbl);
      }
      head.appendChild(btns);
      sec.appendChild(head);
      var strip = document.createElement('div');
      strip.className = 'gis-photo-strip';
      sec.appendChild(strip);
      attrBody.appendChild(sec);

      function renderStrip() {
        strip.innerHTML = '';
        if (!props._photos.length) {
          strip.innerHTML = '<span class="gis-photo-empty">No photos yet</span>';
          return;
        }
        props._photos.forEach(function (ph, idx) {
          var cell = document.createElement('figure');
          cell.className = 'gis-photo-cell';
          var t = document.createElement('div');
          t.className = 'gis-photo-thumb' + (ph.kind === 'meter' ? ' is-meter' : '');
          var img = document.createElement('img');
          img.src = ph.dataUrl; img.alt = ph.name || ('photo ' + (idx + 1));
          img.title = photoMetaText(ph, true);
          img.addEventListener('click', function () { openPhotoLightbox(ph.dataUrl, photoMetaText(ph, true)); });
          if (ph.kind === 'meter') {
            var badge = document.createElement('span');
            badge.className = 'gis-photo-badge';
            badge.textContent = 'METER';
            t.appendChild(badge);
          }
          if (ph.lat != null && ph.lng != null) {
            var geo = document.createElement('span');
            geo.className = 'gis-photo-geo';
            geo.textContent = '\ud83d\udccd';
            geo.title = 'Geotagged';
            t.appendChild(geo);
          }
          var rm = document.createElement('button');
          rm.type = 'button'; rm.className = 'gis-photo-rm'; rm.textContent = '\u00d7';
          rm.title = 'Remove photo';
          rm.addEventListener('click', function () {
            props._photos.splice(idx, 1);
            renderStrip();
          });
          t.appendChild(img); t.appendChild(rm);
          cell.appendChild(t);
          var cap = document.createElement('figcaption');
          cap.className = 'gis-photo-cap';
          cap.textContent = photoMetaText(ph, false);
          cell.appendChild(cap);
          strip.appendChild(cell);
        });
      }
      renderStrip();

      function readFiles(input, kind) {
        var files = Array.prototype.slice.call(input.files || []);
        input.value = '';
        if (!files.length) return;
        // Capture one GPS fix for this batch, then attach to each photo so
        // meter readings are geo-stamped and auditable.
        photoGeo(lyr, function (geo) {
          var pending = files.length;
          files.forEach(function (file) {
            var reader = new FileReader();
            reader.onload = function () {
              var ph = {
                dataUrl: reader.result,
                name: file.name,
                time: Date.now(),
                kind: kind || undefined,
              };
              if (geo) { ph.lat = geo.lat; ph.lng = geo.lng; ph.acc = geo.acc; ph.geoSrc = geo.src; }
              props._photos.push(ph);
              pending -= 1;
              if (pending === 0) renderStrip();
            };
            reader.onerror = function () { pending -= 1; if (pending === 0) renderStrip(); };
            reader.readAsDataURL(file);
          });
        });
      }

      fileIn.addEventListener('change', function () { readFiles(fileIn, null); });
      if (meterIn) meterIn.addEventListener('change', function () { readFiles(meterIn, 'meter'); });
    }

    function openPhotoLightbox(src, caption) {
      var ov = document.createElement('div');
      ov.className = 'gis-photo-lightbox';
      var img = document.createElement('img');
      img.src = src;
      ov.appendChild(img);
      if (caption) {
        var cap = document.createElement('div');
        cap.className = 'gis-photo-lightcap';
        cap.textContent = caption;
        ov.appendChild(cap);
      }
      ov.addEventListener('click', function () { ov.remove(); });
      host.appendChild(ov);
    }

    // =====================================================================
    // Building wizard — ONE shared attribute set linked to BOTH a point and a
    // polygon. On save we emit two GeoJSON features that share a building_uuid
    // and are tagged geometry_role: 'centroid' (point) / 'footprint' (polygon),
    // so they can be relationally re-joined in desktop GIS after export.
    // =====================================================================
    var bwizPanel = $('bwiz');
    var bwiz = {
      open: false, metaId: null,
      point: null, polygon: null,        // captured L.LatLng / [L.LatLng]
      ptPreview: null, pgPreview: null,  // on-map previews while editing
      photos: [], drawing: null,         // 'point' | 'polygon' while armed
    };

    function bwizField(key) { return bwizPanel.querySelector('[data-bkey="' + key + '"]'); }
    function bwizSetVal(key, v) { var el = bwizField(key); if (el) el.value = (v == null ? '' : v); }
    function bwizGetVal(key) { var el = bwizField(key); return el ? el.value : ''; }

    // Building layer the wizard writes into: the active one, else the first
    // building layer, else a freshly created one.
    function activeBuildingMeta() {
      var m = layers[activeId];
      if (m && m.category === 'building') return m;
      var found = null;
      Object.keys(layers).forEach(function (k) { if (!found && layers[k].category === 'building') found = layers[k]; });
      return found || createLayer({ category: 'building' });
    }

    function openBuildingWizard() {
      var meta = activeBuildingMeta();
      bwizClearGeometry();
      bwiz.open = true;
      bwiz.metaId = meta.id;
      bwiz.photos = [];
      bwizSetVal('surveyor', defaultSurveyor());
      bwizSetVal('date', today());
      bwizSetVal('block', '');
      bwizSetVal('office_name', '');
      bwizSetVal('office_name_2', '');
      bwizSetVal('office_name_3', '');
      bwizSetVal('meter_status', '');
      bwizSetVal('floors', '');
      bwizSetVal('area_m2', '');
      bwizSetVal('builtup_m2', '');
      bwizSetVal('remarks', '');
      var more = $('bwiz-more'); if (more) more.classList.add('gis-bwiz-locked');
      renderBwizPhotos();
      updateBwizGeomStatus();
      updateBwizSave();
      // Clear other overlays so the map stays free for drawing.
      if (attrPanel) attrPanel.hidden = true;
      if (tablePanel) tablePanel.hidden = true;
      if (dashPanel) dashPanel.hidden = true;
      setPanelOpen(false); // close mobile sidebar so the map is fully visible
      bwizPanel.hidden = false;
    }

    function bwizClearGeometry() {
      try { if (map.pm) map.pm.disableDraw(); } catch (_) {}
      bwiz.drawing = null;
      if (bwiz.ptPreview) { try { map.removeLayer(bwiz.ptPreview); } catch (_) {} bwiz.ptPreview = null; }
      if (bwiz.pgPreview) { try { map.removeLayer(bwiz.pgPreview); } catch (_) {} bwiz.pgPreview = null; }
      bwiz.point = null; bwiz.polygon = null;
    }

    function closeBuildingWizard() {
      bwizClearGeometry();
      bwiz.open = false; bwiz.metaId = null; bwiz.photos = [];
      bwizPanel.classList.remove('gis-bwiz-drawing');
      bwizPanel.hidden = true;
    }

    // Arm a Geoman draw tool for the wizard; the shape is caught in pm:create.
    function bwizDraw(shape) {
      if (!map.pm) { toast('Drawing tools unavailable'); return; }
      if (!bwiz.open) return;
      try { map.pm.disableDraw(); } catch (_) {}
      bwiz.drawing = shape;
      var tool = shape === 'polygon' ? 'Polygon' : 'Marker';
      try {
        map.pm.enableDraw(tool, { continueDrawing: false, snappable: true, snapDistance: 20 });
      } catch (_) { toast('Could not start drawing'); bwiz.drawing = null; }
      updateBwizGeomStatus();
      // On mobile: collapse the wizard card so the map is fully visible for drawing.
      bwizPanel.classList.add('gis-bwiz-drawing');
      toast(shape === 'polygon'
        ? 'Tap the map to trace the footprint, double-tap to finish'
        : 'Tap the map to place the point');
    }

    // Captured from the global pm:create handler while a wizard tool is armed.
    function bwizCapture(e) {
      var lyr = e.layer;
      try { map.removeLayer(lyr); } catch (_) {}
      var meta = layers[bwiz.metaId];
      if (bwiz.drawing === 'point') {
        bwiz.point = lyr.getLatLng();
        if (bwiz.ptPreview) { try { map.removeLayer(bwiz.ptPreview); } catch (_) {} }
        bwiz.ptPreview = makePointMarker(meta, bwiz.point).addTo(map);
      } else if (bwiz.drawing === 'polygon') {
        var lls = lyr.getLatLngs ? lyr.getLatLngs() : null;
        while (lls && lls.length && Array.isArray(lls[0])) lls = lls[0];
        bwiz.polygon = lls;
        if (bwiz.pgPreview) { try { map.removeLayer(bwiz.pgPreview); } catch (_) {} }
        bwiz.pgPreview = L.polygon(bwiz.polygon, styleFor(meta.color)).addTo(map);
        var a = polygonArea(bwiz.pgPreview);
        if (a != null) { bwizSetVal('area_m2', a); recomputeBwizBuiltup(); }
      }
      try { map.pm.disableDraw(); } catch (_) {}
      bwiz.drawing = null;
      if (bwiz.point || bwiz.polygon) {
        var more = $('bwiz-more'); if (more) more.classList.remove('gis-bwiz-locked');
      }
      // Geometry captured — restore the full wizard panel.
      bwizPanel.classList.remove('gis-bwiz-drawing');
      updateBwizGeomStatus();
      updateBwizSave();
    }

    function recomputeBwizBuiltup() {
      var ar = parseFloat(bwizGetVal('area_m2')) || 0;
      var fl = parseFloat(bwizGetVal('floors')) || 0;
      if (ar) bwizSetVal('builtup_m2', Math.round(ar * (fl > 0 ? fl : 1) * 100) / 100);
    }

    function updateBwizGeomStatus() {
      var ptBtn = bwizPanel.querySelector('[data-act="bwiz-draw-point"]');
      var pgBtn = bwizPanel.querySelector('[data-act="bwiz-draw-polygon"]');
      function set(statEl, btn, captured, armed) {
        if (statEl) statEl.textContent = armed ? 'Drawing\u2026' : (captured ? '\u2713 Captured' : 'Pending');
        if (btn) { btn.classList.toggle('is-captured', !!captured); btn.classList.toggle('is-armed', !!armed); }
      }
      set($('bwiz-pt-stat'), ptBtn, !!bwiz.point, bwiz.drawing === 'point');
      set($('bwiz-pg-stat'), pgBtn, !!bwiz.polygon, bwiz.drawing === 'polygon');
      var hint = $('bwiz-hint');
      if (hint) {
        if (bwiz.point && bwiz.polygon) hint.textContent = '\u2713 Both geometries captured \u2014 they will share one attribute record.';
        else if (bwiz.point || bwiz.polygon) hint.textContent = 'One geometry captured. Add the other, or save now.';
        else hint.textContent = 'Capture a point and/or a footprint. Both share the same attributes.';
      }
    }

    function updateBwizSave() {
      var btn = bwizPanel.querySelector('[data-act="bwiz-save"]');
      if (btn) btn.disabled = !(bwiz.point || bwiz.polygon);
    }

    // Lightweight photo capture for the wizard (object shape == feature _photos).
    function renderBwizPhotos() {
      var box = $('bwiz-photos');
      if (!box) return;
      box.innerHTML =
        '<div class="gis-photo-head"><span>Photos</span>' +
        '<span class="gis-photo-btns"><label class="gis-photo-add">\uff0b Add' +
        '<input type="file" accept="image/*" capture="environment" multiple hidden></label></span></div>' +
        '<div class="gis-photo-strip" data-role="bwiz-strip"></div>';
      var input = box.querySelector('input[type="file"]');
      input.addEventListener('change', function () {
        var files = Array.prototype.slice.call(input.files || []);
        input.value = '';
        if (!files.length) return;
        var anchor = { getLatLng: function () { return bwiz.point || (bwiz.pgPreview && bwiz.pgPreview.getBounds().getCenter()) || null; } };
        photoGeo(anchor, function (geo) {
          var pending = files.length;
          files.forEach(function (file) {
            var reader = new FileReader();
            reader.onload = function () {
              var ph = { dataUrl: reader.result, name: file.name, time: Date.now() };
              if (geo) { ph.lat = geo.lat; ph.lng = geo.lng; ph.acc = geo.acc; ph.geoSrc = geo.src; }
              bwiz.photos.push(ph);
              pending -= 1; if (pending === 0) renderBwizStrip();
            };
            reader.onerror = function () { pending -= 1; if (pending === 0) renderBwizStrip(); };
            reader.readAsDataURL(file);
          });
        });
      });
      renderBwizStrip();
    }

    function renderBwizStrip() {
      var strip = $('bwiz-strip');
      if (!strip) return;
      if (!bwiz.photos.length) { strip.innerHTML = '<span class="gis-photo-empty">No photos yet</span>'; return; }
      strip.innerHTML = '';
      bwiz.photos.forEach(function (ph, idx) {
        var cell = document.createElement('figure');
        cell.className = 'gis-photo-cell';
        var t = document.createElement('div');
        t.className = 'gis-photo-thumb';
        var img = document.createElement('img');
        img.src = ph.dataUrl; img.alt = ph.name || ('photo ' + (idx + 1));
        img.addEventListener('click', function () { openPhotoLightbox(ph.dataUrl, photoMetaText(ph, true)); });
        var rm = document.createElement('button');
        rm.type = 'button'; rm.className = 'gis-photo-rm'; rm.textContent = '\u00d7';
        rm.title = 'Remove photo';
        rm.addEventListener('click', function () { bwiz.photos.splice(idx, 1); renderBwizStrip(); });
        t.appendChild(img); t.appendChild(rm);
        cell.appendChild(t);
        var cap = document.createElement('figcaption');
        cap.className = 'gis-photo-cap';
        cap.textContent = photoMetaText(ph, false);
        cell.appendChild(cap);
        strip.appendChild(cell);
      });
    }

    // Build the shared attribute object, then emit one feature per captured
    // geometry. Both carry the same attrs + building_uuid, tagged by role.
    function saveBuilding() {
      if (!bwiz.open) return;
      if (!bwiz.point && !bwiz.polygon) { toast('Capture a point or a polygon first'); return; }
      var meta = layers[bwiz.metaId] || activeBuildingMeta();
      if (!meta.visible) {
        meta.visible = true; meta.group.addTo(map);
        if (meta.row) { var cb = meta.row.querySelector('.gis-vis'); if (cb) cb.checked = true; }
      }
      var uuid = genUUID();
      var bid = nextBuildingId();
      var shared = {
        surveyor: bwizGetVal('surveyor'), date: bwizGetVal('date'),
        building_id: bid, block: bwizGetVal('block'),
        office_name: bwizGetVal('office_name'),
        office_name_2: bwizGetVal('office_name_2'),
        office_name_3: bwizGetVal('office_name_3'),
        meter_status: bwizGetVal('meter_status'),
        floors: bwizGetVal('floors'),
        area_m2: bwizGetVal('area_m2'), builtup_m2: bwizGetVal('builtup_m2'),
        remarks: bwizGetVal('remarks'),
        building_uuid: uuid,
      };
      if (shared.surveyor) { try { localStorage.setItem('kukl_gis_surveyor', shared.surveyor); } catch (_) {} }

      function photosClone() { try { return JSON.parse(JSON.stringify(bwiz.photos)); } catch (_) { return []; } }
      function makeProps(role) {
        var p = {};
        Object.keys(shared).forEach(function (k) { p[k] = shared[k]; });
        p.geometry_role = role;     // 'centroid' (point) | 'footprint' (polygon)
        p._photos = photosClone();
        return p;
      }

      var made = 0;
      if (bwiz.point) {
        var marker = bwiz.ptPreview || makePointMarker(meta, bwiz.point);
        bwiz.ptPreview = null;
        try { map.removeLayer(marker); } catch (_) {}
        marker.feature = { type: 'Feature', properties: makeProps('centroid'), geometry: null };
        meta.group.addLayer(marker);
        attachFeatureBehavior(meta, marker, false);
        made += 1;
      }
      if (bwiz.polygon) {
        var poly = bwiz.pgPreview || L.polygon(bwiz.polygon, styleFor(meta.color));
        bwiz.pgPreview = null;
        try { map.removeLayer(poly); } catch (_) {}
        try { poly.setStyle(styleFor(meta.color)); } catch (_) {}
        poly.feature = { type: 'Feature', properties: makeProps('footprint'), geometry: null };
        meta.group.addLayer(poly);
        attachFeatureBehavior(meta, poly, false);
        made += 1;
      }
      updateCount(meta);
      persist(meta.id);
      closeBuildingWizard();
      toast('Building ' + bid + ' saved (' + (made === 2 ? 'point + footprint' : '1 geometry') + ')');
    }

    // A building's point + footprint share ONE record. After editing one,
    // copy the shared (descriptive) attributes onto its sibling(s) so they
    // never drift apart. area_m2/builtup_m2 stay per-geometry — the footprint
    // owns the measured area; the point has none.
    var BUILDING_SHARED_KEYS = ['surveyor', 'date', 'building_id', 'block',
      'office_name', 'office_name_2', 'office_name_3', 'meter_status', 'floors', 'remarks'];
    function syncBuildingSiblings(meta, lyr) {
      if (meta.category !== 'building') return;
      var p = (lyr.feature && lyr.feature.properties) || {};
      var uuid = p.building_uuid;
      if (!uuid) return;
      meta.group.eachLayer(function (other) {
        if (other === lyr) return;
        var op = other.feature && other.feature.properties;
        if (!op || op.building_uuid !== uuid) return;
        BUILDING_SHARED_KEYS.forEach(function (k) { op[k] = p[k]; });
        if (layerGeomType(other) === 'polygon') {
          var fl = parseFloat(op.floors) || 0, ar = parseFloat(op.area_m2) || 0;
          if (ar) op.builtup_m2 = Math.round(ar * (fl > 0 ? fl : 1) * 100) / 100;
        }
        updateTooltip(meta, other);
      });
    }

    function saveAttrFromEditor() {
      if (!editorTarget) return;
      var meta = editorTarget.meta, lyr = editorTarget.lyr;
      var props = (lyr.feature && lyr.feature.properties) || {};
      attrBody.querySelectorAll('[data-key]').forEach(function (inp) {
        props[inp.dataset.key] = inp.value;
      });
      lyr.feature.properties = props;
      // Built-up area = footprint × floors (recompute after a floors edit).
      if (meta.category === 'building' && layerGeomType(lyr) === 'polygon') {
        var fl = parseFloat(props.floors) || 0;
        var ar = parseFloat(props.area_m2) || 0;
        if (ar) props.builtup_m2 = Math.round(ar * (fl > 0 ? fl : 1) * 100) / 100;
      }
      // Keep the building's point + footprint in sync.
      syncBuildingSiblings(meta, lyr);
      // Re-colour a pipe if its material changed.
      if (meta.category === 'pipe') applyPipeStyle(meta, lyr);
      if (props.surveyor) { try { localStorage.setItem('kukl_gis_surveyor', props.surveyor); } catch (_) {} }
      updateTooltip(meta, lyr);
      persist(meta.id);
      attrPanel.hidden = true;
      toast('Attributes saved');
    }

    function deleteFeatureFromEditor() {
      if (!editorTarget) return;
      var meta = editorTarget.meta, lyr = editorTarget.lyr;
      if (!confirm('Delete this feature? This cannot be undone.')) return;
      try { meta.group.removeLayer(lyr); } catch (_) {}
      persist(meta.id); updateCount(meta);
      attrPanel.hidden = true;
      editorTarget = null;
    }

    function zoomFeatureFromEditor() {
      if (!editorTarget) return;
      var lyr = editorTarget.lyr;
      try {
        if (lyr.getBounds) map.fitBounds(lyr.getBounds().pad(0.4), { maxZoom: 19 });
        else if (lyr.getLatLng) map.setView(lyr.getLatLng(), 19);
      } catch (_) {}
    }

    // ---- Redraw an existing feature's geometry (keep its attributes/photos) ----
    // Lets the surveyor trace a brand-new footprint or line over an existing
    // feature; the old shape is replaced while the attribute record, photos and
    // building point+footprint link stay intact.
    var redrawTarget = null; // { meta, lyr, gt } while a redraw is armed

    // Re-apply a feature's normal styling (pipes keep their per-material look).
    // Explicitly resets opacity/dashArray since setStyle merges with the dimmed
    // style applied while redrawing.
    function restoreFeatureStyle(meta, lyr) {
      try {
        if (meta.category === 'pipe' && layerGeomType(lyr) === 'line') applyPipeStyle(meta, lyr);
        else if (lyr.setStyle) {
          var s = styleFor(meta.color);
          s.opacity = 1; s.dashArray = null;
          lyr.setStyle(s);
        }
      } catch (_) {}
    }

    // Abort an in-progress redraw and restore the original shape + editor.
    function cancelRedraw() {
      if (!redrawTarget) return;
      var t = redrawTarget; redrawTarget = null;
      try { map.pm.disableDraw(); } catch (_) {}
      restoreFeatureStyle(t.meta, t.lyr);
      editorTarget = { meta: t.meta, lyr: t.lyr };
      openAttributeEditor(t.meta, t.lyr);
    }

    function redrawFeatureFromEditor() {
      if (!editorTarget) return;
      var meta = editorTarget.meta, lyr = editorTarget.lyr;
      var gt = layerGeomType(lyr);
      if (gt !== 'polygon' && gt !== 'line') { toast('Only an area or a line can be redrawn'); return; }
      if (!map.pm) { toast('Drawing tools unavailable'); return; }
      redrawTarget = { meta: meta, lyr: lyr, gt: gt };
      // Dim the old shape so the new trace is easy to see, but keep it as a guide.
      try { if (lyr.setStyle) lyr.setStyle({ opacity: 0.35, fillOpacity: 0.08, dashArray: '4,6' }); } catch (_) {}
      attrPanel.hidden = true;
      try { map.pm.disableDraw(); } catch (_) {}
      try {
        map.pm.enableDraw(gt === 'polygon' ? 'Polygon' : 'Line', { continueDrawing: false, snappable: true, snapDistance: 20 });
        toast(gt === 'polygon'
          ? 'Trace the NEW footprint \u00b7 double-tap to finish (replaces the old shape)'
          : 'Trace the NEW line \u00b7 double-tap to finish (replaces the old shape)');
      } catch (_) { toast('Could not start drawing'); cancelRedraw(); }
    }

    // Apply a freshly-drawn shape onto the existing feature, preserving attrs.
    function redrawCapture(e) {
      var drawn = e.layer;
      try { map.removeLayer(drawn); } catch (_) {}
      if (!redrawTarget) return;
      var meta = redrawTarget.meta, lyr = redrawTarget.lyr, gt = redrawTarget.gt;
      redrawTarget = null;
      var lls = drawn.getLatLngs ? drawn.getLatLngs() : null;
      if (gt === 'polygon') { while (lls && lls.length && Array.isArray(lls[0]) && Array.isArray(lls[0][0])) lls = lls[0]; }
      else { while (lls && lls.length && Array.isArray(lls[0])) lls = lls[0]; }
      try { lyr.setLatLngs(lls); }
      catch (_) { toast('Could not apply the new shape'); restoreFeatureStyle(meta, lyr); editorTarget = { meta: meta, lyr: lyr }; openAttributeEditor(meta, lyr); return; }
      // Recompute derived measurements from the new geometry.
      var pp = lyr.feature && lyr.feature.properties;
      if (pp) {
        if (gt === 'polygon') {
          var ar = polygonArea(lyr);
          if (ar != null) pp.area_m2 = ar;
          if (meta.category === 'building') {
            var fl = parseFloat(pp.floors) || 0, a2 = parseFloat(pp.area_m2) || 0;
            if (a2) pp.builtup_m2 = Math.round(a2 * (fl > 0 ? fl : 1) * 100) / 100;
          }
        } else if (gt === 'line') {
          var len = lineLength(lyr);
          if (len != null) pp.length_m = len;
        }
      }
      restoreFeatureStyle(meta, lyr);
      updateTooltip(meta, lyr);
      syncBuildingSiblings(meta, lyr);
      try { map.pm.disableDraw(); } catch (_) {}
      persist(meta.id);
      editorTarget = { meta: meta, lyr: lyr };
      openAttributeEditor(meta, lyr);
      toast('Shape updated');
    }

    // ---- Per-building printable report (attributes + photos + map figure) ----
    // Web-Mercator pixel projection at a given zoom (256-px tiles).
    function projectPx(lng, lat, zoom) {
      var n = Math.pow(2, zoom) * 256;
      var x = (lng + 180) / 360 * n;
      var s = Math.max(-0.9999, Math.min(0.9999, Math.sin(lat * Math.PI / 180)));
      var y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
      return { x: x, y: y };
    }
    // Visit every [lng,lat] coordinate in a GeoJSON geometry.
    function eachCoord(geom, fn) {
      if (!geom || !geom.coordinates) return;
      var c = geom.coordinates;
      if (geom.type === 'Point') fn(c);
      else if (geom.type === 'LineString' || geom.type === 'MultiPoint') c.forEach(fn);
      else if (geom.type === 'Polygon' || geom.type === 'MultiLineString') c.forEach(function (r) { r.forEach(fn); });
      else if (geom.type === 'MultiPolygon') c.forEach(function (poly) { poly.forEach(function (r) { r.forEach(fn); }); });
    }
    // Static OSM figure centred on the feature, with the actual point /
    // footprint polygon / line drawn on top (so the report shows the shape,
    // not just a dot). geoms: GeoJSON geometries; color: layer colour.
    function mapSnippetHTML(geoms, color) {
      geoms = (geoms || []).filter(Boolean);
      color = color || '#1b6fd6';
      var W = 320, H = 240;
      var minLng = 180, minLat = 90, maxLng = -180, maxLat = -90, has = false;
      geoms.forEach(function (g) {
        eachCoord(g, function (c) {
          has = true;
          if (c[0] < minLng) minLng = c[0]; if (c[0] > maxLng) maxLng = c[0];
          if (c[1] < minLat) minLat = c[1]; if (c[1] > maxLat) maxLat = c[1];
        });
      });
      if (!has) return '<p class="rep-none">No location.</p>';
      var cLng = (minLng + maxLng) / 2, cLat = (minLat + maxLat) / 2;
      // Largest zoom where the geometry's bbox fits comfortably in the frame.
      var degenerate = (maxLng - minLng < 1e-7 && maxLat - minLat < 1e-7);
      var zoom = 12;
      for (var z = 20; z >= 12; z--) {
        var a = projectPx(minLng, maxLat, z), b = projectPx(maxLng, minLat, z);
        zoom = z;
        if (Math.abs(b.x - a.x) <= W * 0.7 && Math.abs(b.y - a.y) <= H * 0.7) break;
      }
      if (degenerate) zoom = 18;
      zoom = Math.min(zoom, 20);
      var ctr = projectPx(cLng, cLat, zoom);
      var originX = ctr.x - W / 2, originY = ctr.y - H / 2;
      var nTiles = Math.pow(2, zoom);
      var sub = ['a', 'b', 'c'];
      var tiles = '';
      var tx0 = Math.floor(originX / 256), tx1 = Math.floor((originX + W) / 256);
      var ty0 = Math.floor(originY / 256), ty1 = Math.floor((originY + H) / 256);
      for (var ty = ty0; ty <= ty1; ty++) {
        if (ty < 0 || ty >= nTiles) continue;
        for (var tx = tx0; tx <= tx1; tx++) {
          var wtx = ((tx % nTiles) + nTiles) % nTiles;
          var s = sub[Math.abs(tx + ty) % 3];
          tiles += '<img class="snip-tile" style="left:' + (tx * 256 - originX) + 'px;top:' + (ty * 256 - originY) + 'px" ' +
            'src="https://' + s + '.tile.openstreetmap.org/' + zoom + '/' + wtx + '/' + ty + '.png" alt="" referrerpolicy="no-referrer-when-downgrade">';
        }
      }
      // SVG overlay of the geometry, using the same projection.
      function pxStr(c) { var p = projectPx(c[0], c[1], zoom); return (p.x - originX).toFixed(1) + ',' + (p.y - originY).toFixed(1); }
      var svg = '';
      geoms.forEach(function (g) {
        if (!g) return;
        if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
          var polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
          polys.forEach(function (poly) {
            var d = poly.map(function (ring) { return 'M' + ring.map(pxStr).join('L') + 'Z'; }).join('');
            svg += '<path d="' + d + '" fill="' + color + '" fill-opacity="0.28" stroke="' + color + '" stroke-width="2.5"/>';
          });
        } else if (g.type === 'LineString' || g.type === 'MultiLineString') {
          var lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
          lines.forEach(function (line) {
            svg += '<polyline points="' + line.map(pxStr).join(' ') + '" fill="none" stroke="' + color + '" stroke-width="3"/>';
          });
        } else if (g.type === 'Point') {
          var p = pxStr(g.coordinates).split(',');
          svg += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="6.5" fill="' + color + '" stroke="#fff" stroke-width="2.5"/>';
        }
      });
      var overlay = '<svg class="snip-svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' + svg + '</svg>';
      return '<div class="snip-frame" style="width:' + W + 'px;height:' + H + 'px">' +
        '<div class="snip-mosaic">' + tiles + '</div>' + overlay + '</div>';
    }

    function printFeatureReport(meta, lyr) {
      if (!meta || !lyr) return;
      var schema = SCHEMAS[meta.category] || SCHEMAS.generic;
      var props = (lyr.feature && lyr.feature.properties) || {};
      var ll = featureLatLng(lyr);
      var title = featureTitle(meta, props) || schema.label;
      var bid = props.building_id || '';

      // Collect every geometry of THIS building so the figure shows both the
      // point and the footprint together (they share a building_uuid).
      var uuid = props.building_uuid;
      var geoms = [], geomKinds = {};
      meta.group.eachLayer(function (l) {
        if (typeof l.toGeoJSON !== 'function') return;
        var lp = (l.feature && l.feature.properties) || {};
        var same = uuid ? lp.building_uuid === uuid : l === lyr;
        if (!same) return;
        var gj = l.toGeoJSON();
        if (gj && gj.geometry) { geoms.push(gj.geometry); geomKinds[gj.geometry.type] = true; }
      });
      if (!geoms.length) { var gj0 = lyr.toGeoJSON(); if (gj0 && gj0.geometry) { geoms.push(gj0.geometry); geomKinds[gj0.geometry.type] = true; } }
      var hasPoly = geomKinds.Polygon || geomKinds.MultiPolygon;
      var hasPoint = geomKinds.Point || geomKinds.MultiPoint;
      var hasLine = geomKinds.LineString || geomKinds.MultiLineString;

      // Attribute rows (skip empty + internal keys).
      var rows = '';
      schema.fields.forEach(function (f) {
        var v = props[f.key];
        if (v == null || v === '') return;
        rows += '<tr><th>' + esc(f.label) + '</th><td>' + esc(String(v)) + '</td></tr>';
      });
      Object.keys(props).forEach(function (k) {
        if (k.charAt(0) === '_') return;
        if (schema.fields.some(function (f) { return f.key === k; })) return;
        var v = props[k];
        if (v == null || v === '') return;
        rows += '<tr><th>' + esc(k) + '</th><td>' + esc(String(v)) + '</td></tr>';
      });
      if (ll) {
        rows += '<tr><th>Latitude</th><td>' + ll.lat.toFixed(6) + '</td></tr>';
        rows += '<tr><th>Longitude</th><td>' + ll.lng.toFixed(6) + '</td></tr>';
      }

      // Photos with geo-stamp captions.
      var photos = Array.isArray(props._photos) ? props._photos : [];
      var photoHTML = '';
      photos.forEach(function (ph) {
        var cap = photoMetaText(ph, true);
        var tag = ph.kind === 'meter' ? '<span class="rep-meter">METER</span> ' : '';
        photoHTML += '<figure class="rep-photo"><img src="' + ph.dataUrl + '" alt="">' +
          '<figcaption>' + tag + esc(cap || '') + '</figcaption></figure>';
      });
      if (!photoHTML) photoHTML = '<p class="rep-none">No photos captured.</p>';

      var snippet = mapSnippetHTML(geoms, meta.color);
      var col = meta.color || '#1b6fd6';
      // Map legend — show only the geometry symbols this building actually has.
      var legend = '';
      if (hasPoly) legend += '<span class="lg-it"><span class="lg-poly" style="background:' + col + '33;border-color:' + col + '"></span>Footprint (polygon)</span>';
      if (hasPoint) legend += '<span class="lg-it"><span class="lg-pt" style="background:' + col + '"></span>Location (point)</span>';
      if (hasLine) legend += '<span class="lg-it"><span class="lg-line" style="background:' + col + '"></span>Line</span>';
      var legendHTML = legend ? '<div class="snip-legend">' + legend + '</div>' : '';

      // Absolute logo URL so the image resolves inside the popup document.
      var logoUrl = '';
      try { logoUrl = new URL('assets/kukl-logo.png', window.location.href).href; } catch (_) { logoUrl = 'assets/kukl-logo.png'; }

      var now = new Date();
      var stamp = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2) + '-' +
        ('0' + now.getDate()).slice(-2) + ' ' + ('0' + now.getHours()).slice(-2) + ':' +
        ('0' + now.getMinutes()).slice(-2);

      var doc =
        '<!doctype html><html><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>Building Report ' + esc(bid || title) + '</title>' +
        '<style>' +
        '*{box-sizing:border-box}' +
        'body{font-family:"Times New Roman",Times,Georgia,serif;color:#111;margin:0;padding:24px;}' +
        // No-print toolbar: Back + Print (essential on mobile, where the popup has no chrome).
        '.rep-bar{position:sticky;top:0;z-index:10;display:flex;gap:10px;align-items:center;justify-content:space-between;background:#13294b;color:#fff;margin:-24px -24px 18px;padding:10px 16px;}' +
        '.rep-bar .ttl{font-size:13px;font-weight:700;letter-spacing:.5px;}' +
        '.rep-bar .acts{display:flex;gap:8px;}' +
        '.rep-bar button{font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;border:none;border-radius:6px;padding:8px 14px;}' +
        '.rep-bar .b-back{background:#fff;color:#13294b;}' +
        '.rep-bar .b-print{background:#1b6fd6;color:#fff;}' +
        '.rep-head{display:flex;justify-content:space-between;align-items:center;gap:14px;border-bottom:3px solid #13294b;padding-bottom:10px;margin-bottom:14px;}' +
        '.rep-head .brand{display:flex;align-items:center;gap:12px;}' +
        '.rep-head .logo{width:54px;height:54px;object-fit:contain;flex:0 0 auto;}' +
        '.rep-head h1{font-size:20px;margin:0 0 3px;color:#13294b;}' +
        '.rep-head .sub{font-size:12px;color:#555;}' +
        '.rep-head .org{text-align:right;font-size:11px;color:#555;}' +
        '.rep-head .org b{display:block;font-size:13px;color:#13294b;}' +
        '.rep-id{display:inline-block;background:#13294b;color:#fff;font-weight:700;font-size:13px;padding:3px 10px;border-radius:5px;margin-bottom:12px;}' +
        '.rep-grid{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap;}' +
        '.rep-col{flex:1;min-width:280px;}' +
        'table.rep-attr{border-collapse:collapse;width:100%;font-size:13px;}' +
        'table.rep-attr th,table.rep-attr td{border:1px solid #ccc;padding:5px 8px;text-align:left;vertical-align:top;}' +
        'table.rep-attr th{background:#eef3fb;width:42%;color:#222;font-weight:700;}' +
        'h2{font-size:14px;color:#13294b;margin:16px 0 7px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #ccc;padding-bottom:3px;}' +
        '.snip-frame{overflow:hidden;border:2px solid #13294b;border-radius:6px;position:relative;background:#e8eef5;}' +
        '.snip-mosaic{position:absolute;inset:0;}' +
        '.snip-tile{position:absolute;width:256px;height:256px;}' +
        '.snip-svg{position:absolute;left:0;top:0;}' +
        '.snip-legend{display:flex;flex-wrap:wrap;gap:14px;margin-top:7px;font-size:11px;color:#333;}' +
        '.snip-legend .lg-it{display:inline-flex;align-items:center;gap:5px;}' +
        '.snip-legend .lg-poly{width:16px;height:12px;border:2px solid;display:inline-block;border-radius:2px;}' +
        '.snip-legend .lg-pt{width:12px;height:12px;border:2px solid #fff;box-shadow:0 0 0 1px #999;border-radius:50%;display:inline-block;}' +
        '.snip-legend .lg-line{width:18px;height:4px;border-radius:2px;display:inline-block;}' +
        '.rep-photos{display:flex;flex-wrap:wrap;gap:10px;}' +
        '.rep-photo{margin:0;width:200px;border:1px solid #ccc;border-radius:5px;overflow:hidden;}' +
        '.rep-photo img{width:100%;height:150px;object-fit:cover;display:block;}' +
        '.rep-photo figcaption{font-size:10px;padding:4px 6px;color:#444;background:#f7f7f7;}' +
        '.rep-meter{background:#0a8f8f;color:#fff;font-weight:700;font-size:9px;padding:1px 4px;border-radius:3px;}' +
        '.rep-none{font-size:12px;color:#888;font-style:italic;}' +
        '.rep-foot{margin-top:22px;border-top:1px solid #ccc;padding-top:8px;font-size:10px;color:#777;display:flex;justify-content:space-between;}' +
        '@media print{body{padding:0;}.rep-bar{display:none;}.rep-photo{break-inside:avoid;}}' +
        '</style></head><body>' +
        '<div class="rep-bar"><span class="ttl">Building Report</span><span class="acts">' +
        '<button type="button" class="b-back" onclick="(window.opener?window.close():history.back())">← Back</button>' +
        '<button type="button" class="b-print" onclick="window.print()">🖨 Print</button>' +
        '</span></div>' +
        '<div class="rep-head"><div class="brand">' +
        (logoUrl ? '<img class="logo" src="' + esc(logoUrl) + '" alt="KUKL">' : '') +
        '<div><h1>Building Survey Report</h1>' +
        '<div class="sub">Integration of Water Supply Connections &amp; Building Numbering &mdash; Singhadurbar</div></div></div>' +
        '<div class="org"><b>KUKL</b>Kathmandu Upatyaka Khanepani Limited<br>Site Survey System</div></div>' +
        (bid ? '<span class="rep-id">' + esc(bid) + '</span>' : '') +
        '<div class="rep-grid">' +
        '<div class="rep-col"><h2>Attributes</h2><table class="rep-attr"><tbody>' +
        (rows || '<tr><td colspan="2" class="rep-none">No attributes.</td></tr>') +
        '</tbody></table></div>' +
        '<div class="rep-col" style="flex:0 0 auto"><h2>Location</h2>' + snippet + legendHTML +
        (ll ? '<div style="font-size:11px;color:#555;margin-top:5px;">' + ll.lat.toFixed(6) + ', ' + ll.lng.toFixed(6) + '</div>' : '') +
        '</div></div>' +
        '<h2>Photos (' + photos.length + ')</h2><div class="rep-photos">' + photoHTML + '</div>' +
        '<div class="rep-foot"><span>Generated ' + stamp + '</span><span>KUKL Field GIS</span></div>' +
        // Wait for the basemap tiles + photos to finish loading before opening
        // the print dialog, so the map figure is never blank on the printout.
        // On touch devices we skip auto-print (the Back/Print toolbar drives it)
        // so the user is never trapped in a print sheet with no way back.
        '<script>(function(){' +
        'function go(){try{window.focus();window.print();}catch(e){}}' +
        'var coarse=window.matchMedia&&window.matchMedia("(pointer:coarse)").matches;' +
        'var imgs=[].slice.call(document.images),left=imgs.length,done=false;' +
        'function fin(){if(done)return;done=true;if(!coarse)setTimeout(go,200);}' +
        'if(!left){fin();}else{imgs.forEach(function(im){' +
        'if(im.complete){if(--left<=0)fin();}' +
        'else{im.addEventListener("load",function(){if(--left<=0)fin();});' +
        'im.addEventListener("error",function(){if(--left<=0)fin();});}});}' +
        'setTimeout(fin,5000);' +
        '})();<\/script>' +
        '</body></html>';

      var w = window.open('', '_blank');
      if (!w) { toast('Allow pop-ups to print the report'); return; }
      w.document.open();
      w.document.write(doc);
      w.document.close();
    }

    function reportFromEditor() {
      if (!editorTarget) return;
      printFeatureReport(editorTarget.meta, editorTarget.lyr);
    }

    // ---- QGIS-style attribute table (all features of a layer) ----
    function zoomToLayerFeature(lyr) {
      try {
        if (lyr.getBounds) map.fitBounds(lyr.getBounds().pad(0.4), { maxZoom: 20 });
        else if (lyr.getLatLng) map.setView(lyr.getLatLng(), 20);
      } catch (_) {}
    }

    function openAttributeTable(meta) {
      var schema = SCHEMAS[meta.category] || SCHEMAS.generic;
      var feats = meta.group.getLayers();
      currentTableMeta = meta;
      if (tableTitle) {
        var ftLabel = feats.length + ' feature' + (feats.length === 1 ? '' : 's');
        if (meta.category === 'building') {
          var bn = distinctBuildingCount(feats);
          ftLabel = bn + ' building' + (bn === 1 ? '' : 's') + ' \u00b7 ' + ftLabel;
        }
        tableTitle.textContent = meta.name + ' \u2014 ' + ftLabel;
      }
      tableWrap.innerHTML = '';

      if (!feats.length) {
        tableWrap.innerHTML = '<p class="gis-table-empty">No features yet. Draw on the map to add some.</p>';
        tablePanel.hidden = false;
        return;
      }

      // Columns = schema fields + any extra properties found on features
      // (so imported Excel/Shapefile/GeoJSON columns are visible too).
      var cols = schema.fields.map(function (f) { return { key: f.key, label: f.label }; });
      var seen = {};
      cols.forEach(function (c) { seen[c.key] = true; });
      feats.forEach(function (lyr) {
        var p = (lyr.feature && lyr.feature.properties) || {};
        Object.keys(p).forEach(function (k) {
          if (k.charAt(0) === '_') return;
          if (!seen[k]) { seen[k] = true; cols.push({ key: k, label: k }); }
        });
      });
      // Lat/Lng shown for every layer (lines/polygons use their centre point).
      cols.push({ key: '__lat', label: 'Latitude' });
      cols.push({ key: '__lng', label: 'Longitude' });

      var table = document.createElement('table');
      table.className = 'gis-attr-table';
      var thead = document.createElement('thead');
      var htr = document.createElement('tr');
      htr.innerHTML = '<th>#</th>' +
        cols.map(function (c) { return '<th>' + esc(c.label) + '</th>'; }).join('') +
        '<th></th>';
      thead.appendChild(htr);
      table.appendChild(thead);

      var tbody = document.createElement('tbody');
      feats.forEach(function (lyr, i) {
        ensureFeatureProps(meta, lyr, false);
        var p = lyr.feature.properties || {};
        var ll = featureLatLng(lyr);
        var tr = document.createElement('tr');
        var cells = '<td class="gis-tcell-n">' + (i + 1) + '</td>';
        cols.forEach(function (c) {
          var v;
          if (c.key === '__lat') v = ll ? ll.lat.toFixed(6) : '';
          else if (c.key === '__lng') v = ll ? ll.lng.toFixed(6) : '';
          else v = p[c.key] != null ? p[c.key] : '';
          cells += '<td>' + esc(v) + '</td>';
        });
        cells += '<td class="gis-tcell-act">' +
          '<button type="button" class="gis-trow-btn" data-tact="edit" title="Edit / view">\u270e</button>' +
          '<button type="button" class="gis-trow-btn" data-tact="zoom" title="Zoom to feature">\u2922</button>' +
          '<button type="button" class="gis-trow-btn gis-trow-del" data-tact="del" title="Delete feature">\u2715</button>' +
          '</td>';
        tr.innerHTML = cells;
        tr.querySelector('[data-tact="edit"]').addEventListener('click', function () {
          tablePanel.hidden = true;
          openAttributeEditor(meta, lyr);
        });
        tr.querySelector('[data-tact="zoom"]').addEventListener('click', function () {
          zoomToLayerFeature(lyr);
        });
        tr.querySelector('[data-tact="del"]').addEventListener('click', function () {
          if (!confirm('Delete this feature? This cannot be undone.')) return;
          try { meta.group.removeLayer(lyr); } catch (_) {}
          persist(meta.id); updateCount(meta);
          openAttributeTable(meta); // refresh table
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      tableWrap.appendChild(table);
      tablePanel.hidden = false;
    }

    // ---- Active layer handling ----
    function setActive(id) {
      activeId = id;
      Object.keys(layers).forEach(function (k) {
        var r = layers[k].row;
        if (r) r.classList.toggle('active', k === id);
      });
      var meta = layers[id];
      if (meta) applyToolsForCategory(meta.category);
      updateBwizRow();
    }

    // ---- Auto building numbering (sequential IDs, restarting per block) ----
    // Sequentially auto-number a layer's features by their map position.
    // Buildings: one ID per physical building (point + footprint sharing a
    // building_uuid stay together) and the Block is folded into the ID.
    // Connections / valves / pipes: one ID per feature.
    function autoNumberLayer(meta) {
      var info = ID_DEFAULTS[meta.category];
      if (!info) { toast('This layer type has no auto-ID'); return; }
      var idKey = info.key, isBuilding = meta.category === 'building';
      var feats = meta.group.getLayers();
      if (!feats.length) { toast('No features to number yet'); return; }
      var count = isBuilding ? distinctBuildingCount(feats) : feats.length;
      var prefix = prompt(info.noun.charAt(0).toUpperCase() + info.noun.slice(1) + ' ID prefix?', categoryPrefix(meta.category));
      if (prefix == null) return;
      prefix = prefix.trim() || info.prefix;
      try { localStorage.setItem('kukl_gis_prefix_' + meta.category, prefix); } catch (_) {}
      if (!confirm('Assign sequential IDs to all ' + count + ' ' + info.noun +
        (count === 1 ? '' : 's') + '? Existing IDs will be overwritten.')) return;
      // Stable order: north→south, then west→east, so numbering follows the map.
      feats.sort(function (a, b) {
        var la = featureLatLng(a), lb = featureLatLng(b);
        if (!la || !lb) return 0;
        return (lb.lat - la.lat) || (la.lng - lb.lng);
      });
      var counters = {}, idByUuid = {};
      feats.forEach(function (lyr) {
        ensureFeatureProps(meta, lyr, false);
        var p = lyr.feature.properties;
        if (isBuilding) {
          var u = p.building_uuid;
          if (u && idByUuid[u]) { p[idKey] = idByUuid[u]; updateTooltip(meta, lyr); return; }
          var block = (p.block || '').toString().trim();
          counters[block] = (counters[block] || 0) + 1;
          var id = (block ? prefix + '-' + block : prefix) + '-' + ('000' + counters[block]).slice(-3);
          p[idKey] = id;
          if (u) idByUuid[u] = id;
        } else {
          counters[''] = (counters[''] || 0) + 1;
          p[idKey] = prefix + '-' + ('000' + counters['']).slice(-3);
        }
        updateTooltip(meta, lyr);
      });
      persist(meta.id);
      rebuildLegend();
      if (currentTableMeta && currentTableMeta.id === meta.id && !tablePanel.hidden) {
        openAttributeTable(meta);
      }
      toast('Numbered ' + count + ' ' + info.noun + (count === 1 ? '' : 's'));
    }

    // ---- Sidebar row ----
    function buildRow(meta) {
      var list = $('layers');
      var row = document.createElement('div');
      row.className = 'gis-layer-row';
      row.dataset.id = meta.id;
      var isBuilding = meta.category === 'building';
      row.innerHTML =
        '<div class="gis-row-main">' +
          '<input type="checkbox" class="gis-vis" ' + (meta.visible ? 'checked' : '') + ' title="Toggle visibility">' +
          '<span class="gis-swatch" style="background:' + meta.color + '"></span>' +
          '<input type="color" class="gis-color" value="' + meta.color + '" title="Layer colour">' +
          '<span class="gis-name" tabindex="0" title="Click to make active; double-click to rename">' + esc(meta.name) + '</span>' +
          '<span class="gis-count" data-role="count" title="Feature count">0</span>' +
        '</div>' +
        '<div class="gis-row-actions">' +
          '<span class="gis-cat" title="Feature type">' + esc((SCHEMAS[meta.category] || SCHEMAS.generic).label) + '</span>' +
          '<span class="gis-row-tools">' +
            (canAutoNumber(meta.category) ? '<button type="button" class="gis-ic" data-act="autonum" title="Auto-number features">\u0023</button>' : '') +
            '<button type="button" class="gis-ic" data-act="table" title="Open attribute table">\u2637</button>' +
            '<button type="button" class="gis-ic" data-act="zoom" title="Zoom to layer">⤢</button>' +
            '<button type="button" class="gis-ic" data-act="export" title="Export GeoJSON">⤓</button>' +
            '<button type="button" class="gis-ic" data-act="export-kml" title="Export KML (Google Earth / QGIS / QField)">K</button>' +
            '<button type="button" class="gis-ic gis-ic-del" data-act="del" title="Delete layer">✕</button>' +
          '</span>' +
        '</div>';
      list.appendChild(row);
      meta.row = row;

      var visCb = row.querySelector('.gis-vis');
      var colorIn = row.querySelector('.gis-color');
      var swatch = row.querySelector('.gis-swatch');
      var nameEl = row.querySelector('.gis-name');

      visCb.addEventListener('change', function () {
        meta.visible = visCb.checked;
        if (meta.visible) meta.group.addTo(map); else map.removeLayer(meta.group);
        rebuildLegend();
        persist(meta.id);
      });
      colorIn.addEventListener('input', function () {
        meta.color = colorIn.value;
        swatch.style.background = meta.color;
        applyStyleToGroup(meta, meta.color);
        rebuildLegend();
        persist(meta.id);
      });
      nameEl.addEventListener('click', function () { setActive(meta.id); });
      nameEl.addEventListener('dblclick', function () { renameLayer(meta, nameEl); });
      nameEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActive(meta.id); }
      });

      // Clicking anywhere on the row (except its controls/buttons) selects the layer.
      row.addEventListener('click', function (e) {
        if (e.target.closest('button, input, .gis-name')) return;
        setActive(meta.id);
      });

      row.querySelector('[data-act="zoom"]').addEventListener('click', function () { zoomTo(meta); });
      row.querySelector('[data-act="export"]').addEventListener('click', function () { exportLayer(meta); });
      row.querySelector('[data-act="export-kml"]').addEventListener('click', function () { exportLayerKml(meta); });
      row.querySelector('[data-act="table"]').addEventListener('click', function () { openAttributeTable(meta); });
      row.querySelector('[data-act="del"]').addEventListener('click', function () { deleteLayer(meta); });
      var autonumBtn = row.querySelector('[data-act="autonum"]');
      if (autonumBtn) autonumBtn.addEventListener('click', function () { autoNumberLayer(meta); });

      updateCount(meta);
    }

    // Count distinct buildings in a list of feature-layers. A building's point
    // (centroid) and footprint (polygon) share a building_uuid and must count
    // as ONE building. Features without a uuid (legacy / single-geometry) each
    // count once.
    function distinctBuildingCount(feats) {
      var seen = {}, n = 0;
      feats.forEach(function (lyr) {
        var p = (lyr.feature && lyr.feature.properties) || {};
        var u = p.building_uuid;
        if (u) { if (!seen[u]) { seen[u] = true; n += 1; } }
        else { n += 1; }
      });
      return n;
    }

    function updateCount(meta) {
      if (!meta.row) return;
      var feats = meta.group.getLayers();
      // Building layers count physical buildings, not point+footprint features.
      var n = meta.category === 'building' ? distinctBuildingCount(feats) : feats.length;
      var el = meta.row.querySelector('[data-role="count"]');
      if (el) {
        el.textContent = n;
        el.title = meta.category === 'building' ? 'Building count' : 'Feature count';
      }
    }

    function renameLayer(meta, nameEl) {
      var current = meta.name;
      var input = document.createElement('input');
      input.type = 'text'; input.value = current; input.className = 'gis-name-edit';
      nameEl.replaceWith(input);
      input.focus(); input.select();
      function commit() {
        meta.name = input.value.trim() || current;
        var span = document.createElement('span');
        span.className = 'gis-name'; span.tabIndex = 0; span.textContent = meta.name;
        span.title = 'Click to make active; double-click to rename';
        span.addEventListener('click', function () { setActive(meta.id); });
        span.addEventListener('dblclick', function () { renameLayer(meta, span); });
        input.replaceWith(span);
        rebuildLegend();
        persist(meta.id);
      }
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.value = current; input.blur(); }
      });
    }

    function zoomTo(meta) {
      var b = meta.group.getBounds && meta.group.getBounds();
      if (b && b.isValid && b.isValid()) map.fitBounds(b.pad(0.2), { maxZoom: 19 });
      else toast('Layer is empty');
    }

    // Validate a FeatureCollection before download so a malformed geometry or
    // a non-serialisable property can't silently corrupt the export. Returns
    // { ok, count, message } and never throws.
    function validateExportFC(fc) {
      try {
        if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
          return { ok: false, count: 0, message: 'No feature collection to export' };
        }
        var bad = 0;
        fc.features.forEach(function (f) {
          var g = f && f.geometry;
          if (!f || f.type !== 'Feature' || !g || !g.type || g.coordinates == null) bad += 1;
          if (!f.properties || typeof f.properties !== 'object') { if (f) f.properties = {}; }
        });
        // Round-trip through JSON to catch circular refs / non-finite numbers.
        JSON.stringify(fc);
        if (bad) return { ok: false, count: fc.features.length, message: bad + ' feature(s) have invalid geometry' };
        return { ok: true, count: fc.features.length, message: '' };
      } catch (err) {
        return { ok: false, count: 0, message: (err && err.message) || 'Serialization error' };
      }
    }

    // Build a clean FeatureCollection for one layer (schema defaults + computed
    // fields filled in, heavy/private _keys stripped, source layer tagged).
    // building_uuid / geometry_role are kept so the point+footprint link
    // survives into GeoJSON, KML and downstream GIS.
    function buildLayerFC(meta) {
      var schema = SCHEMAS[meta.category] || SCHEMAS.generic;
      var features = [];
      meta.group.eachLayer(function (lyr) {
        if (typeof lyr.toGeoJSON !== 'function') return;
        ensureFeatureProps(meta, lyr, false);
        var gj = lyr.toGeoJSON();
        // toGeoJSON() shares the live feature's properties object, so build a
        // fresh bag instead of mutating it. Keep public fields and _photos so
        // captured field photos survive the GeoJSON round-trip to another
        // device; drop other internal/transient _keys. (KML export skips all
        // _keys separately, so embedded photo data never bloats a .kml.)
        var src = gj.properties || {};
        var clean = {};
        Object.keys(src).forEach(function (key) {
          if (key.charAt(0) === '_' && key !== '_photos') return;
          clean[key] = src[key];
        });
        clean._layer = meta.name;
        clean._category = schema.label;
        gj.properties = clean;
        features.push(gj);
      });
      return { type: 'FeatureCollection', features: features };
    }

    function exportLayer(meta) {
      var fc = buildLayerFC(meta);
      if (!fc.features.length) { toast('Nothing to export'); return; }
      var check = validateExportFC(fc);
      if (!check.ok) { toast('Export blocked: ' + check.message); return; }
      try {
        var base = (meta.name || 'layer').replace(/[^\w.-]+/g, '_');
        download(base + '.geojson', JSON.stringify(fc, null, 2), 'application/geo+json');
        toast('Exported ' + fc.features.length + ' feature' + (fc.features.length === 1 ? '' : 's'));
      } catch (err) {
        console.error('[GIS] export failed', err);
        toast('Export failed: ' + ((err && err.message) || 'unknown error'));
      }
    }

    // Per-layer KML export (Google Earth / QGIS / QField). Attributes ride
    // along as <ExtendedData>; building point + footprint stay linked by uuid.
    function exportLayerKml(meta) {
      var fc = buildLayerFC(meta);
      if (!fc.features.length) { toast('Nothing to export'); return; }
      var check = validateExportFC(fc);
      if (!check.ok) { toast('Export blocked: ' + check.message); return; }
      try {
        var base = (meta.name || 'layer').replace(/[^\w.-]+/g, '_');
        download(base + '.kml', geojsonToKml(fc, meta.name), 'application/vnd.google-earth.kml+xml');
        toast('Exported ' + fc.features.length + ' feature' + (fc.features.length === 1 ? '' : 's') + ' to KML');
      } catch (err) {
        console.error('[GIS] KML export failed', err);
        toast('Export failed: ' + ((err && err.message) || 'unknown error'));
      }
    }

    // Build tabular rows (schema fields + extra props + lat/lng) for a layer.
    function layerToRows(meta) {
      var schema = SCHEMAS[meta.category] || SCHEMAS.generic;
      var feats = meta.group.getLayers();
      var cols = schema.fields.map(function (f) { return f.key; });
      var seen = {};
      cols.forEach(function (k) { seen[k] = true; });
      feats.forEach(function (lyr) {
        var p = (lyr.feature && lyr.feature.properties) || {};
        Object.keys(p).forEach(function (k) {
          if (k.charAt(0) === '_') return;
          if (!seen[k]) { seen[k] = true; cols.push(k); }
        });
      });
      return feats.map(function (lyr) {
        ensureFeatureProps(meta, lyr, false);
        var p = lyr.feature.properties || {};
        var row = {};
        cols.forEach(function (k) { row[k] = p[k] != null ? p[k] : ''; });
        var ll = featureLatLng(lyr);
        row.lat = ll ? ll.lat : '';
        row.lng = ll ? ll.lng : '';
        return row;
      });
    }

    function exportTableSpreadsheet(meta, kind) {
      if (!meta) { toast('Open a layer table first'); return; }
      if (!window.XLSX) { toast('Excel library not loaded'); return; }
      var rows = layerToRows(meta);
      if (!rows.length) { toast('Nothing to export'); return; }
      var base = (meta.name || 'layer').replace(/[^\w.-]+/g, '_');
      var ws = window.XLSX.utils.json_to_sheet(rows);
      if (kind === 'csv') {
        var csv = window.XLSX.utils.sheet_to_csv(ws);
        download(base + '.csv', csv, 'text/csv');
      } else {
        var wb = window.XLSX.utils.book_new();
        window.XLSX.utils.book_append_sheet(wb, ws, 'Data');
        var buf = window.XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
        download(base + '.xlsx', buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      }
      toast('Exported ' + rows.length + ' row' + (rows.length === 1 ? '' : 's'));
    }

    // ---- Project summary (counts for buildings / connections) ----
    function computeSummary() {
      var s = {
        buildings: 0, connections: 0,
        hydrants: 0, meters: 0,
        metered: 0, unmetered: 0,
        byType: {}, byStatus: {}, byBlock: {}, linked: 0, unlinked: 0,
        builtupTotal: 0,
        layers: 0, features: 0,
      };
      var seenBld = {}; // building_uuid → true, so point+footprint count once
      Object.keys(layers).forEach(function (k) {
        var m = layers[k];
        s.layers += 1;
        var feats = m.group.getLayers();
        s.features += feats.length;
        feats.forEach(function (lyr) {
          var p = (lyr.feature && lyr.feature.properties) || {};
          if (m.category === 'building') {
            // One physical building may have a centroid + a footprint feature
            // sharing a building_uuid — count it (and its block/area) once.
            var u = p.building_uuid;
            if (u && seenBld[u]) return;
            if (u) seenBld[u] = true;
            s.buildings += 1;
            var blk = (p.block || '').toString().trim() || '(no block)';
            s.byBlock[blk] = (s.byBlock[blk] || 0) + 1;
            s.builtupTotal += parseFloat(p.builtup_m2) || 0;
          }
          if (m.category === 'connection') {
            s.connections += 1;
            if ((p.meter_no || '').toString().trim()) s.metered += 1; else s.unmetered += 1;
            if ((p.building_id || '').toString().trim()) s.linked += 1; else s.unlinked += 1;
            var ty = (p.conn_type || '').toString().trim() || '(unspecified)';
            s.byType[ty] = (s.byType[ty] || 0) + 1;
            var st = (p.status || '').toString().trim() || '(unspecified)';
            s.byStatus[st] = (s.byStatus[st] || 0) + 1;
          }
          if (m.category === 'hydrant') s.hydrants += 1;
          if (m.category === 'meter') s.meters += 1;
        });
      });
      return s;
    }

    function openDashboard() {
      var s = computeSummary();
      function kvRows(obj) {
        var keys = Object.keys(obj);
        if (!keys.length) return '<tr><td colspan="2" class="gis-dash-none">\u2014</td></tr>';
        return keys.sort().map(function (k) {
          return '<tr><td>' + esc(k) + '</td><td class="gis-dash-num">' + obj[k] + '</td></tr>';
        }).join('');
      }
      function numFmt(n) { return Math.round(n).toLocaleString('en-US'); }
      dashBody.innerHTML =
        '<div class="gis-dash-cards">' +
          '<div class="gis-dash-kpi"><b>' + s.buildings + '</b><span>Buildings</span></div>' +
          '<div class="gis-dash-kpi"><b>' + s.connections + '</b><span>Connections</span></div>' +
          '<div class="gis-dash-kpi"><b>' + s.hydrants + '</b><span>Fire Hydrants</span></div>' +
          '<div class="gis-dash-kpi"><b>' + s.meters + '</b><span>Meters (mapped)</span></div>' +
          '<div class="gis-dash-kpi"><b>' + s.metered + '</b><span>Metered</span></div>' +
          '<div class="gis-dash-kpi gis-dash-warn"><b>' + s.unmetered + '</b><span>Unmetered</span></div>' +
          '<div class="gis-dash-kpi"><b>' + s.linked + '</b><span>Linked to bldg</span></div>' +
          '<div class="gis-dash-kpi gis-dash-warn"><b>' + s.unlinked + '</b><span>Unlinked</span></div>' +
          '<div class="gis-dash-kpi gis-dash-accent"><b>' + numFmt(s.builtupTotal) + '</b><span>Built-up m\u00b2</span></div>' +
        '</div>' +
        '<div class="gis-dash-grid">' +
          '<div class="gis-dash-tbl"><h4>Connections by type</h4><table class="gis-attr-table"><tbody>' + kvRows(s.byType) + '</tbody></table></div>' +
          '<div class="gis-dash-tbl"><h4>Connections by status</h4><table class="gis-attr-table"><tbody>' + kvRows(s.byStatus) + '</tbody></table></div>' +
          '<div class="gis-dash-tbl"><h4>Buildings by block</h4><table class="gis-attr-table"><tbody>' + kvRows(s.byBlock) + '</tbody></table></div>' +
        '</div>' +
        '<p class="gis-dash-foot">' + s.layers + ' layers \u00b7 ' + s.features + ' features total</p>';
      attrPanel.hidden = true;
      tablePanel.hidden = true;
      dashPanel.hidden = false;
    }

    // ---- Whole-project export (all layers in one file) ----
    // Returns { fc, perLayer } — a flat FeatureCollection for GeoJSON and a
    // per-layer list for KML folders. One pass, so both stay in sync.
    function buildProjectExport() {
      var fc = { type: 'FeatureCollection', features: [] };
      var perLayer = [];
      Object.keys(layers).forEach(function (k) {
        var m = layers[k];
        var lfc = buildLayerFC(m);
        perLayer.push({ name: m.name, fc: lfc });
        lfc.features.forEach(function (f) { fc.features.push(f); });
      });
      return { fc: fc, perLayer: perLayer };
    }

    function exportProjectGeoJSON() {
      var fc = buildProjectExport().fc;
      if (!fc.features.length) { toast('Nothing to export'); return; }
      var check = validateExportFC(fc);
      if (!check.ok) { toast('Export blocked: ' + check.message); return; }
      try {
        download('singhadurbar_gis_project.geojson', JSON.stringify(fc, null, 2), 'application/geo+json');
        toast('Exported ' + fc.features.length + ' features');
      } catch (err) {
        console.error('[GIS] project export failed', err);
        toast('Export failed: ' + ((err && err.message) || 'unknown error'));
      }
    }

    // Whole-project KML — one <Folder> per layer, attributes as <ExtendedData>.
    // Imports directly into Google Earth, QGIS and QField.
    function exportProjectKml() {
      var ex = buildProjectExport();
      if (!ex.fc.features.length) { toast('Nothing to export'); return; }
      var check = validateExportFC(ex.fc);
      if (!check.ok) { toast('Export blocked: ' + check.message); return; }
      try {
        download('singhadurbar_gis_project.kml', layersToKml(ex.perLayer, 'Singhadurbar GIS'), 'application/vnd.google-earth.kml+xml');
        toast('Exported ' + ex.fc.features.length + ' features to KML');
      } catch (err) {
        console.error('[GIS] project KML export failed', err);
        toast('Export failed: ' + ((err && err.message) || 'unknown error'));
      }
    }

    function exportProjectXLSX() {
      if (!window.XLSX) { toast('Excel library not loaded'); return; }
      var ids = Object.keys(layers);
      if (!ids.length) { toast('No layers to export'); return; }
      var wb = window.XLSX.utils.book_new();
      var used = {};
      // Summary sheet first.
      var s = computeSummary();
      var sumRows = [
        { Metric: 'Buildings', Value: s.buildings },
        { Metric: 'Connections', Value: s.connections },
        { Metric: 'Fire hydrants', Value: s.hydrants },
        { Metric: 'Meters (mapped)', Value: s.meters },
        { Metric: 'Metered connections', Value: s.metered },
        { Metric: 'Unmetered connections', Value: s.unmetered },
        { Metric: 'Connections linked to a building', Value: s.linked },
        { Metric: 'Connections not linked', Value: s.unlinked },
        { Metric: 'Total built-up area (m\u00b2)', Value: Math.round(s.builtupTotal) },
      ];
      Object.keys(s.byType).sort().forEach(function (t) { sumRows.push({ Metric: 'Type: ' + t, Value: s.byType[t] }); });
      Object.keys(s.byStatus).sort().forEach(function (t) { sumRows.push({ Metric: 'Status: ' + t, Value: s.byStatus[t] }); });
      Object.keys(s.byBlock).sort().forEach(function (t) { sumRows.push({ Metric: 'Block: ' + t, Value: s.byBlock[t] }); });
      window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.json_to_sheet(sumRows), 'Summary');
      // One sheet per layer.
      var total = 0;
      ids.forEach(function (k) {
        var m = layers[k];
        var rows = layerToRows(m);
        total += rows.length;
        var nm = (m.name || 'Layer').replace(/[^\w ]+/g, '').slice(0, 28) || 'Layer';
        var base = nm, n = 2;
        while (used[nm.toLowerCase()]) { nm = (base.slice(0, 25) + ' ' + n); n += 1; }
        used[nm.toLowerCase()] = true;
        var ws = window.XLSX.utils.json_to_sheet(rows.length ? rows : [{ note: 'no features' }]);
        window.XLSX.utils.book_append_sheet(wb, ws, nm);
      });
      var buf = window.XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      download('singhadurbar_gis_project.xlsx', buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      toast('Exported ' + ids.length + ' layers / ' + total + ' rows');
    }

    function deleteLayer(meta) {
      if (!confirm('Delete layer "' + meta.name + '" and all its features? This cannot be undone.')) return;
      try { map.removeLayer(meta.group); } catch (_) {}
      if (meta.row) meta.row.remove();
      delete layers[meta.id];
      dbDelLayer(meta.id);
      rebuildLegend();
      if (activeId === meta.id) {
        activeId = null;
        var first = Object.keys(layers)[0];
        if (first) setActive(first);
      }
    }

    // ---- Draw handler: route new shapes into the active layer ----
    map.on('pm:create', function (e) {
      // Building wizard owns the draw while it is capturing geometry.
      if (bwiz.open && bwiz.drawing) { bwizCapture(e); return; }
      // Redrawing an existing feature's geometry (keeps its attributes/photos).
      if (redrawTarget) { redrawCapture(e); return; }
      var lyr = e.layer;
      var meta = layers[activeId];
      if (!meta) {
        meta = createLayer({ category: catSelectValue() });
        setActive(meta.id);
      }
      // Remove from map's default placement, add to the active group + style it.
      try { map.removeLayer(lyr); } catch (_) {}
      if (isIconMarker(lyr)) {
        try { lyr.setIcon(makePointIcon(meta.category, meta.color)); } catch (_) {}
      } else if (lyr.setStyle) {
        try { lyr.setStyle(styleFor(meta.color)); } catch (_) {}
        if (lyr instanceof L.CircleMarker) {
          try { lyr.setStyle({ color: meta.color, fillColor: meta.color, fillOpacity: 0.9 }); } catch (_) {}
        }
      }
      lyr.feature = lyr.feature || { type: 'Feature', properties: {}, geometry: null };
      meta.group.addLayer(lyr);
      attachFeatureBehavior(meta, lyr, true);
      updateCount(meta);
      persist(meta.id);
      openAttributeEditor(meta, lyr);
    });

    // Global remove (toolbar trash) → recount/persist everything.
    map.on('pm:remove', function () {
      Object.keys(layers).forEach(function (k) { updateCount(layers[k]); persist(k); });
    });

    // If a wizard draw is cancelled (Esc) with nothing captured, reset the chip.
    map.on('pm:drawend', function () {
      if (bwiz.open) { bwiz.drawing = null; updateBwizGeomStatus(); }
      // A redraw that ends without producing a shape (Esc) → restore the feature.
      if (redrawTarget) { setTimeout(function () { if (redrawTarget) cancelRedraw(); }, 0); }
    });

    // ---- New-layer button ----
    host.querySelector('[data-act="new-layer"]').addEventListener('click', function () {
      var meta = createLayer({ category: catSelectValue() });
      setActive(meta.id);
      persist(meta.id);
    });

    // ---- Building wizard (point + footprint sharing one attribute record) ----
    var addBuildingBtn = host.querySelector('[data-act="add-building"]');
    if (addBuildingBtn) addBuildingBtn.addEventListener('click', openBuildingWizard);
    var bwizDrawPt = bwizPanel.querySelector('[data-act="bwiz-draw-point"]');
    var bwizDrawPg = bwizPanel.querySelector('[data-act="bwiz-draw-polygon"]');
    if (bwizDrawPt) bwizDrawPt.addEventListener('click', function () { bwizDraw('point'); });
    if (bwizDrawPg) bwizDrawPg.addEventListener('click', function () { bwizDraw('polygon'); });
    var bwizFloors = bwizPanel.querySelector('[data-bkey="floors"]');
    if (bwizFloors) bwizFloors.addEventListener('input', recomputeBwizBuiltup);
    host.querySelector('[data-act="bwiz-close"]').addEventListener('click', closeBuildingWizard);
    host.querySelector('[data-act="bwiz-cancel"]').addEventListener('click', closeBuildingWizard);
    host.querySelector('[data-act="bwiz-save"]').addEventListener('click', saveBuilding);

    // ---- Mobile panel drawer toggle ----
    var sidebarEl = $('sidebar');
    function setPanelOpen(open) {
      if (sidebarEl) sidebarEl.classList.toggle('open', open);
      host.classList.toggle('panel-open', open);
      setTimeout(function () { try { map.invalidateSize(); } catch (_) {} }, 220);
    }
    var pToggle = host.querySelector('[data-act="panel-toggle"]');
    var pClose = host.querySelector('[data-act="panel-close"]');
    var pBackdrop = host.querySelector('[data-act="sidebar-backdrop"]');
    if (pToggle) pToggle.addEventListener('click', function () { setPanelOpen(true); });
    if (pClose) pClose.addEventListener('click', function () { setPanelOpen(false); });
    if (pBackdrop) pBackdrop.addEventListener('click', function () { setPanelOpen(false); });

    // ---- Sidebar tab switching ----
    var tabBtns = host.querySelectorAll('.gis-tab[data-tab]');
    var tabContents = host.querySelectorAll('.gis-tab-content[data-content]');
    function switchTab(tabId) {
      tabBtns.forEach(function (btn) {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
      });
      tabContents.forEach(function (c) {
        c.classList.toggle('active', c.dataset.content === tabId);
      });
    }
    tabBtns.forEach(function (btn) {
      btn.addEventListener('click', function () { switchTab(btn.dataset.tab); });
    });

    // ---- Attribute editor wiring ----
    host.querySelector('[data-act="attr-close"]').addEventListener('click', function () { attrPanel.hidden = true; });
    host.querySelector('[data-act="attr-save"]').addEventListener('click', saveAttrFromEditor);
    host.querySelector('[data-act="attr-del"]').addEventListener('click', deleteFeatureFromEditor);
    host.querySelector('[data-act="attr-zoom"]').addEventListener('click', zoomFeatureFromEditor);
    if (redrawBtn) redrawBtn.addEventListener('click', redrawFeatureFromEditor);
    if (reportBtn) reportBtn.addEventListener('click', reportFromEditor);
    host.querySelector('[data-act="table-close"]').addEventListener('click', function () { tablePanel.hidden = true; });
    host.querySelector('[data-act="table-csv"]').addEventListener('click', function () { exportTableSpreadsheet(currentTableMeta, 'csv'); });
    host.querySelector('[data-act="table-xlsx"]').addEventListener('click', function () { exportTableSpreadsheet(currentTableMeta, 'xlsx'); });

    // ---- Project: dashboard + whole-project export ----
    host.querySelector('[data-act="dashboard"]').addEventListener('click', openDashboard);
    host.querySelector('[data-act="dash-close"]').addEventListener('click', function () { dashPanel.hidden = true; });
    host.querySelector('[data-act="proj-geojson"]').addEventListener('click', exportProjectGeoJSON);
    host.querySelector('[data-act="proj-kml"]').addEventListener('click', exportProjectKml);
    host.querySelector('[data-act="proj-xlsx"]').addEventListener('click', exportProjectXLSX);

    // ---- DMA reference overlay ----
    $('dma-toggle').addEventListener('change', function (e) {
      if (e.target.checked) {
        if (!dmaCtl && window.KUKLDma) {
          try { dmaCtl = window.KUKLDma.attach(map); } catch (err) { console.warn('[GIS] DMA attach failed', err); }
        }
      } else if (dmaCtl && dmaCtl.destroy) {
        try { dmaCtl.destroy(); } catch (_) {}
        dmaCtl = null;
      }
    });

    // ---- GNSS receiver (external BLE / Serial GPS, SW Maps style) ----
    var gnss = null, gnssMarker = null, gnssAcc = null, gnssLastFix = null, gnssCentered = false;
    var gnssStatusEl = $('gnss-status');
    var gnssReadout = $('gnss-readout');
    var gnssBleBtn = host.querySelector('[data-act="gnss-ble"]');
    var gnssSerialBtn = host.querySelector('[data-act="gnss-serial"]');
    var gnssDisconnectBtn = host.querySelector('[data-act="gnss-disconnect"]');
    var gnssDropBtn = host.querySelector('[data-act="gnss-drop"]');

    function gnssSetText(role, v) { var el = $(role); if (el) el.textContent = (v == null || v === '') ? '\u2014' : v; }

    function gnssShowFix(fix) {
      gnssLastFix = fix;
      gnssReadout.hidden = false;
      gnssSetText('gnss-fix', fix.fixLabel + (fix.fixType ? '' : ''));
      gnssSetText('gnss-sats', fix.sats);
      gnssSetText('gnss-acc', fix.acc != null ? fix.acc.toFixed(1) : null);
      gnssSetText('gnss-lat', fix.lat.toFixed(7));
      gnssSetText('gnss-lng', fix.lng.toFixed(7));
      gnssDropBtn.hidden = false;
      var ll = [fix.lat, fix.lng];
      if (!gnssMarker) {
        gnssMarker = L.circleMarker(ll, {
          radius: 7, color: '#0a8f8f', weight: 3, fillColor: '#19e6d6', fillOpacity: 0.95,
        }).addTo(map);
        gnssMarker.bindTooltip('GNSS receiver', { direction: 'top' });
      } else { gnssMarker.setLatLng(ll); }
      if (fix.acc != null && fix.acc > 0) {
        if (!gnssAcc) {
          gnssAcc = L.circle(ll, { radius: fix.acc, color: '#0a8f8f', weight: 1, fillColor: '#0a8f8f', fillOpacity: 0.08, interactive: false }).addTo(map);
        } else { gnssAcc.setLatLng(ll); gnssAcc.setRadius(fix.acc); }
      }
      if (!gnssCentered) { gnssCentered = true; try { map.setView(ll, Math.max(map.getZoom(), 18)); } catch (_) {} }
    }

    function gnssOnStatus(s) {
      gnssStatusEl.textContent = s.message || s.state;
      gnssStatusEl.dataset.state = s.state;
      var connected = s.state === 'connected';
      var busy = s.state === 'connecting';
      gnssBleBtn.hidden = connected;
      gnssSerialBtn.hidden = connected;
      gnssDisconnectBtn.hidden = !connected;
      gnssBleBtn.disabled = busy;
      gnssSerialBtn.disabled = busy;
      if (s.state === 'disconnected' || s.state === 'error' || s.state === 'idle') {
        gnssCentered = false;
        if (s.state !== 'idle') {
          gnssDropBtn.hidden = true;
          if (gnssMarker) { try { map.removeLayer(gnssMarker); } catch (_) {} gnssMarker = null; }
          if (gnssAcc) { try { map.removeLayer(gnssAcc); } catch (_) {} gnssAcc = null; }
        }
        if (s.state !== 'connecting') gnssReadout.hidden = (s.state === 'disconnected');
      }
      if (s.message) toast(s.message);
    }

    function gnssEnsure() {
      if (gnss) return gnss;
      if (!window.KUKLGnss) { toast('GNSS module not loaded'); return null; }
      gnss = window.KUKLGnss.create({ onFix: gnssShowFix, onStatus: gnssOnStatus });
      return gnss;
    }

    function gnssDropPoint() {
      if (!gnssLastFix) { toast('No GNSS fix yet'); return; }
      var meta = layers[activeId];
      if (!meta) { meta = createLayer({ category: catSelectValue() }); setActive(meta.id); }
      var schema = SCHEMAS[meta.category] || SCHEMAS.generic;
      if (schema.geom !== 'point' && schema.geom !== 'any') { toast('Active layer is not a point layer — pick a point layer to drop a GNSS point'); return; }
      var lyr = makePointMarker(meta, [gnssLastFix.lat, gnssLastFix.lng]);
      lyr.feature = { type: 'Feature', properties: {}, geometry: null };
      meta.group.addLayer(lyr);
      attachFeatureBehavior(meta, lyr, true);
      // Record the capture accuracy where the schema has a remarks-style field.
      if (gnssLastFix.acc != null && lyr.feature.properties.remarks === '') {
        lyr.feature.properties.remarks = 'GNSS ' + gnssLastFix.fixLabel + ', \u00b1' + gnssLastFix.acc.toFixed(1) + ' m';
      }
      updateCount(meta);
      persist(meta.id);
      openAttributeEditor(meta, lyr);
    }

    if (gnssBleBtn) {
      if (!window.KUKLGnss || !window.KUKLGnss.supported.ble) { gnssBleBtn.disabled = true; gnssBleBtn.title = 'Web Bluetooth not available in this browser'; }
      gnssBleBtn.addEventListener('click', function () { var g = gnssEnsure(); if (g) g.connectBLE(); });
    }
    if (gnssSerialBtn) {
      if (!window.KUKLGnss || !window.KUKLGnss.supported.serial) { gnssSerialBtn.disabled = true; gnssSerialBtn.title = 'Web Serial not available in this browser'; }
      gnssSerialBtn.addEventListener('click', function () { var g = gnssEnsure(); if (g) g.connectSerial({ baudRate: 9600 }); });
    }
    if (gnssDisconnectBtn) gnssDisconnectBtn.addEventListener('click', function () { if (gnss) gnss.disconnect(); });
    if (gnssDropBtn) gnssDropBtn.addEventListener('click', gnssDropPoint);

    // ---- Import handlers ----
    $('imp-shp').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      if (!window.shp) { toast('Shapefile library not loaded'); return; }
      toast('Reading shapefile…');
      file.arrayBuffer().then(function (buf) {
        return window.shp(buf);
      }).then(function (geo) {
        // shpjs may return a single FC or an array of FCs (multi-layer zip).
        var collections = Array.isArray(geo) ? geo : [geo];
        collections.forEach(function (fc, i) {
          var nm = (fc && fc.fileName) || (file.name.replace(/\.zip$/i, '') + (collections.length > 1 ? ' ' + (i + 1) : ''));
          importCollection(fc, nm);
        });
        toast('Shapefile imported');
      }).catch(function (err) {
        console.error('[GIS] shp import failed', err);
        toast('Could not read shapefile');
      });
    });

    $('imp-geojson').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      file.text().then(function (txt) {
        var fc = JSON.parse(txt);
        importCollection(fc, file.name.replace(/\.(geo)?json$/i, ''));
        toast('GeoJSON imported');
      }).catch(function (err) {
        console.error('[GIS] geojson import failed', err);
        toast('Invalid GeoJSON file');
      });
    });

    $('imp-kmlgpx').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      if (!window.toGeoJSON) { toast('KML/GPX library not loaded'); return; }
      file.text().then(function (txt) {
        var xml = new DOMParser().parseFromString(txt, 'text/xml');
        var isGpx = /\.gpx$/i.test(file.name);
        var fc = isGpx ? window.toGeoJSON.gpx(xml) : window.toGeoJSON.kml(xml);
        importCollection(fc, file.name.replace(/\.(kml|gpx)$/i, ''));
        toast((isGpx ? 'GPX' : 'KML') + ' imported');
      }).catch(function (err) {
        console.error('[GIS] kml/gpx import failed', err);
        toast('Could not read file');
      });
    });

    // Map a schema label (e.g. "Pipe") back to its category key (e.g. "pipe").
    function categoryFromLabel(label) {
      if (!label) return null;
      var want = String(label).trim().toLowerCase();
      // Legacy alias: the old split "Building Polygon" layer is now "Building".
      if (want === 'building polygon') return 'building';
      var found = null;
      Object.keys(SCHEMAS).forEach(function (cat) {
        if (SCHEMAS[cat].label.toLowerCase() === want) found = cat;
      });
      return found;
    }

    // Best-effort category for a feature: explicit tag first, then geometry.
    function categoryForFeature(f) {
      var p = (f && f.properties) || {};
      var byLabel = categoryFromLabel(p._category);
      if (byLabel) return byLabel;
      var g = f && f.geometry;
      var t = g && g.type;
      if (t === 'LineString' || t === 'MultiLineString') return 'pipe';
      if (t === 'Polygon' || t === 'MultiPolygon') return 'building';
      return null; // point / unknown → ambiguous, handled by caller
    }

    function findLayerByName(name) {
      if (!name) return null;
      var hit = null;
      Object.keys(layers).forEach(function (k) {
        if (!hit && layers[k].name === name) hit = layers[k];
      });
      return hit;
    }

    function findLayerByCategory(cat) {
      if (!cat) return null;
      var hit = null;
      Object.keys(layers).forEach(function (k) {
        if (!hit && layers[k].category === cat) hit = layers[k];
      });
      return hit;
    }

    function defaultLayerName(cat) {
      var s = SCHEMAS[cat];
      return s ? s.label + 's' : 'Imported';
    }

    // Route imported features into matching EXISTING layers (by source layer
    // name, then by category). Only creates a layer when no match exists, so
    // e.g. all pipe features land inside the current "Pipes" layer.
    function importCollection(fc, name) {
      if (!fc || !fc.type) { toast('Empty / unsupported file'); return; }
      var feats = fc.type === 'FeatureCollection' ? (fc.features || [])
                : (fc.type === 'Feature' ? [fc] : []);
      if (!feats.length) { toast('No features in file'); return; }

      // Bucket features by their target layer.
      var buckets = {}; // key -> { meta?, cat, name, features:[] }
      var order = [];
      function bucketKey(cat, layerName) { return (cat || 'generic') + '::' + (layerName || ''); }

      feats.forEach(function (f) {
        if (!f || f.type !== 'Feature') return;
        var p = f.properties || {};
        var srcName = p._layer;
        var cat = categoryForFeature(f);
        // Resolve the destination layer.
        var dest = findLayerByName(srcName);
        if (!dest && cat) dest = findLayerByCategory(cat);
        if (dest && !cat) cat = dest.category;
        // Strip our internal tags so they don't pollute the attribute table.
        delete p._layer; delete p._category;
        f.properties = p;

        var key = dest ? ('meta:' + dest.id) : bucketKey(cat, srcName || name);
        if (!buckets[key]) {
          buckets[key] = {
            meta: dest || null,
            cat: cat || 'generic',
            name: srcName || name || defaultLayerName(cat),
            features: [],
          };
          order.push(key);
        }
        buckets[key].features.push(f);
      });

      if (!order.length) { toast('No importable features'); return; }

      var lastMeta = null, totalAdded = 0;
      order.forEach(function (key) {
        var b = buckets[key];
        var meta = b.meta;
        if (!meta) {
          // No existing layer matched → create one (named after its source).
          meta = createLayer({ category: b.cat, name: b.name });
        }
        loadGeoJSONInto(meta, { type: 'FeatureCollection', features: b.features });
        updateCount(meta);
        persist(meta.id);
        lastMeta = meta;
        totalAdded += b.features.length;
      });

      if (lastMeta) { zoomTo(lastMeta); setActive(lastMeta.id); }
      toast('Imported ' + totalAdded + ' feature' + (totalAdded === 1 ? '' : 's')
        + ' into ' + order.length + ' layer' + (order.length === 1 ? '' : 's'));
    }

    // ---- Excel / CSV import (rows with lat/lng columns → point features) ----
    var LAT_KEYS = ['lat', 'latitude', 'y', 'latdd', 'ycoord', 'northing'];
    var LNG_KEYS = ['lng', 'lon', 'long', 'longitude', 'x', 'lngdd', 'xcoord', 'easting'];

    function pickKey(row, candidates) {
      var keys = Object.keys(row);
      for (var i = 0; i < keys.length; i++) {
        var norm = keys[i].toLowerCase().replace(/[^a-z]/g, '');
        if (candidates.indexOf(norm) !== -1) return keys[i];
      }
      return null;
    }

    function rowsToGeoJSON(rows) {
      if (!rows || !rows.length) return null;
      var latK = pickKey(rows[0], LAT_KEYS);
      var lngK = pickKey(rows[0], LNG_KEYS);
      if (!latK || !lngK) return { error: 'no-coords' };
      var features = [];
      rows.forEach(function (row) {
        var lat = parseFloat(row[latK]);
        var lng = parseFloat(row[lngK]);
        if (!isFinite(lat) || !isFinite(lng)) return;
        var props = {};
        Object.keys(row).forEach(function (k) {
          if (k === latK || k === lngK) return;
          props[k] = row[k];
        });
        features.push({
          type: 'Feature',
          properties: props,
          geometry: { type: 'Point', coordinates: [lng, lat] },
        });
      });
      return { type: 'FeatureCollection', features: features };
    }

    $('imp-excel').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      if (!window.XLSX) { toast('Excel library not loaded'); return; }
      toast('Reading spreadsheet\u2026');
      file.arrayBuffer().then(function (buf) {
        var wb = window.XLSX.read(buf, { type: 'array' });
        var firstSheet = wb.SheetNames[0];
        var rows = window.XLSX.utils.sheet_to_json(wb.Sheets[firstSheet], { defval: '' });
        var fc = rowsToGeoJSON(rows);
        if (!fc) { toast('Spreadsheet is empty'); return; }
        if (fc.error === 'no-coords') {
          toast('No latitude/longitude columns found (need e.g. "lat" & "lng")');
          return;
        }
        if (!fc.features.length) { toast('No valid coordinate rows found'); return; }
        importCollection(fc, file.name.replace(/\.(xlsx|xls|csv)$/i, ''));
        toast('Imported ' + fc.features.length + ' point' + (fc.features.length === 1 ? '' : 's') + ' from spreadsheet');
      }).catch(function (err) {
        console.error('[GIS] excel import failed', err);
        toast('Could not read spreadsheet');
      });
    });

    // ---- Restore persisted layers ----
    dbAllLayers().then(function (recs) {
      recs.sort(function (a, b) { return (a.updatedAt || 0) - (b.updatedAt || 0); });
      recs.forEach(function (rec) {
        // Migrate legacy split building layers into the unified Building layer.
        var cat = rec.category === 'building_poly' ? 'building' : rec.category;
        var meta = createLayer({
          id: rec.id, name: rec.name, category: cat,
          color: rec.color, visible: rec.visible !== false,
        });
        if (rec.geojson) loadGeoJSONInto(meta, rec.geojson);
        updateCount(meta);
        if (cat !== rec.category) persist(meta.id); // save the migrated category
      });
      if (!recs.length) {
        // Seed with the standard KUKL field-survey layers.
        ['building', 'connection', 'pipe', 'valve'].forEach(function (cat) {
          var m = createLayer({ category: cat, name: SCHEMAS[cat].label + 's' });
          persist(m.id);
        });
        setActive(Object.keys(layers)[0]);
      } else {
        setActive(recs[recs.length - 1].id);
      }
      // Fit to all visible features if any.
      var all = L.featureGroup();
      Object.keys(layers).forEach(function (k) {
        if (layers[k].visible) layers[k].group.eachLayer(function (l) { all.addLayer(l); });
      });
      var b = all.getBounds && all.getBounds();
      if (b && b.isValid && b.isValid()) {
        try { map.fitBounds(b.pad(0.2), { maxZoom: 18 }); } catch (_) {}
      }
    }).catch(function (e) {
      console.warn('[GIS] restore failed', e);
      createLayer({ name: 'My Survey Layer' });
    });

    function refresh() {
      setTimeout(function () { try { map.invalidateSize(); } catch (_) {} }, 60);
    }
    function destroy() {
      try { if (gnss) gnss.disconnect(); } catch (_) {}
      try { stopLocate(); } catch (_) {}
      try { map.remove(); } catch (_) {}
      host._kuklGis = null;
      host.innerHTML = '';
    }

    window.addEventListener('resize', refresh);

    var api = { map: map, refresh: refresh, destroy: destroy };
    host._kuklGis = api;
    refresh();
    return api;
  }

  window.KUKLGis = { mount: mount };
})();
