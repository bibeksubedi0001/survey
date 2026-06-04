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
  var CATEGORY_COLOR = { building: '#1b6fd6', building_poly: '#d98300', valve: '#c1001f', pipe: '#1a7f1a', generic: '#7d3cb5' };

  // ---- Feature schemas (QField-style typed layers) ----
  var SCHEMAS = {
    building: {
      label: 'Building', geom: 'point', titleKey: 'building_name', fallbackKey: 'building_id',
      fields: [
        { key: 'surveyor', label: 'Surveyor', type: 'text' },
        { key: 'date', label: 'Date', type: 'date' },
        { key: 'building_id', label: 'Building ID', type: 'text' },
        { key: 'block', label: 'Block', type: 'text' },
        { key: 'building_name', label: 'Building Name', type: 'text' },
      ],
    },
    building_poly: {
      label: 'Building Polygon', geom: 'polygon', titleKey: 'building_name', fallbackKey: 'building_id',
      fields: [
        { key: 'surveyor', label: 'Surveyor', type: 'text' },
        { key: 'date', label: 'Date', type: 'date' },
        { key: 'building_id', label: 'Building ID', type: 'text' },
        { key: 'block', label: 'Block', type: 'text' },
        { key: 'building_name', label: 'Building Name', type: 'text' },
        { key: 'floors', label: 'Floors', type: 'number' },
        { key: 'area_m2', label: 'Area (m\u00b2) \u2014 auto', type: 'number', readonly: true },
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
        { key: 'material', label: 'Material', type: 'select', options: ['HDPE', 'PVC', 'DI', 'GI', 'MS', 'PE', 'AC', 'Concrete'] },
        { key: 'diameter_mm', label: 'Diameter (mm)', type: 'number' },
        { key: 'length_m', label: 'Length (m) \u2014 auto', type: 'number', readonly: true },
        { key: 'status', label: 'Status', type: 'select', options: ['In Service', 'Abandoned', 'Proposed', 'Under Construction'] },
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

  // Minimal GeoJSON → KML (points, lines, polygons) for export.
  function geojsonToKml(fc, layerName) {
    var feats = (fc && fc.features) || [];
    var out = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
      '<name>' + esc(layerName || 'layer') + '</name>';
    function coordStr(c) { return c[0] + ',' + c[1] + (c.length > 2 ? ',' + c[2] : ''); }
    function ring(r) { return r.map(coordStr).join(' '); }
    feats.forEach(function (f) {
      var g = f.geometry; if (!g) return;
      var props = f.properties || {};
      var nm = props.name || props.Name || '';
      out += '<Placemark>';
      if (nm) out += '<name>' + esc(nm) + '</name>';
      if (g.type === 'Point') {
        out += '<Point><coordinates>' + coordStr(g.coordinates) + '</coordinates></Point>';
      } else if (g.type === 'LineString') {
        out += '<LineString><coordinates>' + g.coordinates.map(coordStr).join(' ') + '</coordinates></LineString>';
      } else if (g.type === 'Polygon') {
        out += '<Polygon><outerBoundaryIs><LinearRing><coordinates>' +
          ring(g.coordinates[0] || []) + '</coordinates></LinearRing></outerBoundaryIs></Polygon>';
      } else if (g.type === 'MultiPolygon') {
        (g.coordinates || []).forEach(function (poly) {
          out += '<Polygon><outerBoundaryIs><LinearRing><coordinates>' +
            ring(poly[0] || []) + '</coordinates></LinearRing></outerBoundaryIs></Polygon>';
        });
      }
      out += '</Placemark>';
    });
    out += '</Document></kml>';
    return out;
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
      '  <div class="gis-side-head gis-side-top"><strong>Layers</strong>' +
      '    <button type="button" class="gis-panel-close" data-act="panel-close" title="Hide panel">\u00d7</button></div>' +
      '  <div class="gis-new-row">' +
      '    <select class="gis-cat-select" data-role="cat-select" title="Feature type for the next new layer">' +
      '      <option value="building">Buildings (point)</option>' +
      '      <option value="building_poly">Building Polygon (area)</option>' +
      '      <option value="valve">Valves (point)</option>' +
      '      <option value="pipe">Pipes (line)</option>' +
      '      <option value="generic">Generic</option>' +
      '    </select>' +
      '    <button type="button" class="btn btn-mini btn-primary" data-act="new-layer">+ NEW</button>' +
      '  </div>' +
      '  <div class="gis-layer-list" data-role="layers"></div>' +
      '  <div class="gis-side-head"><strong>Import</strong></div>' +
      '  <div class="gis-import">' +
      '    <label class="btn btn-outline btn-mini gis-file">' +
      '      SHAPEFILE (.zip)<input type="file" accept=".zip" data-role="imp-shp" hidden>' +
      '    </label>' +
      '    <label class="btn btn-outline btn-mini gis-file">' +
      '      GEOJSON<input type="file" accept=".geojson,.json" data-role="imp-geojson" hidden>' +
      '    </label>' +
      '    <label class="btn btn-outline btn-mini gis-file">' +
      '      KML / GPX<input type="file" accept=".kml,.gpx" data-role="imp-kmlgpx" hidden>' +
      '    </label>' +
      '    <label class="btn btn-outline btn-mini gis-file">' +
      '      EXCEL / CSV<input type="file" accept=".xlsx,.xls,.csv" data-role="imp-excel" hidden>' +
      '    </label>' +
      '  </div>' +
      '  <div class="gis-side-head"><strong>GNSS Receiver</strong></div>' +
      '  <div class="gis-gnss">' +
      '    <div class="gis-gnss-status" data-role="gnss-status">Internal device GPS</div>' +
      '    <div class="gis-gnss-readout" data-role="gnss-readout" hidden>' +
      '      <div><span>Fix</span><b data-role="gnss-fix">\u2014</b></div>' +
      '      <div><span>Sats</span><b data-role="gnss-sats">\u2014</b></div>' +
      '      <div><span>\u00b1 m</span><b data-role="gnss-acc">\u2014</b></div>' +
      '      <div class="wide"><span>Lat</span><b data-role="gnss-lat">\u2014</b></div>' +
      '      <div class="wide"><span>Lng</span><b data-role="gnss-lng">\u2014</b></div>' +
      '    </div>' +
      '    <div class="gis-gnss-btns">' +
      '      <button type="button" class="btn btn-mini btn-outline" data-act="gnss-ble">BLUETOOTH</button>' +
      '      <button type="button" class="btn btn-mini btn-outline" data-act="gnss-serial">SERIAL / USB</button>' +
      '      <button type="button" class="btn btn-mini btn-danger" data-act="gnss-disconnect" hidden>DISCONNECT</button>' +
      '    </div>' +
      '    <button type="button" class="btn btn-mini btn-primary gis-gnss-drop" data-act="gnss-drop" hidden>DROP POINT AT GNSS</button>' +
      '  </div>' +
      '  <div class="gis-side-head"><strong>Reference</strong></div>' +
      '  <label class="gis-ref-toggle"><input type="checkbox" data-role="dma-toggle"> Show DMA network</label>' +
      '  <p class="gis-tip">Pick a layer type, tap <strong>+ NEW</strong>, then use the map toolbar to draw. Each feature opens an attribute form (buildings, valves and pipes have ready-made fields). Tap any feature later to edit it. Pipe length is measured automatically. Everything saves offline.</p>' +
      '</div>' +
      '<div class="gis-map-wrap"><div class="gis-map" data-role="map"></div>' +
      '  <button type="button" class="gis-panel-toggle" data-act="panel-toggle" title="Show tools">\u2630 Tools</button>' +
      '  <div class="gis-attr" data-role="attr" hidden>' +
      '    <div class="gis-attr-card">' +
      '      <div class="gis-attr-head"><strong data-role="attr-title">Attributes</strong>' +
      '        <button type="button" class="gis-attr-x" data-act="attr-close" title="Close">\u00d7</button></div>' +
      '      <div class="gis-attr-body" data-role="attr-body"></div>' +
      '      <div class="gis-attr-foot">' +
      '        <button type="button" class="btn btn-mini btn-outline" data-act="attr-zoom">ZOOM</button>' +
      '        <button type="button" class="btn btn-mini btn-danger" data-act="attr-del">DELETE</button>' +
      '        <button type="button" class="btn btn-mini btn-primary" data-act="attr-save">SAVE</button>' +
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
      '</div>';

    var $ = function (r) { return host.querySelector('[data-role="' + r + '"]'); };
    var mapEl = $('map');
    var attrPanel = $('attr');
    var attrTitle = $('attr-title');
    var attrBody = $('attr-body');
    var tablePanel = $('table');
    var tableTitle = $('table-title');
    var tableWrap = $('table-wrap');
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

    // Show only the draw tools that match the active layer's geometry.
    function applyToolsForCategory(category) {
      if (!map.pm || !map.pm.Toolbar || !map.pm.Toolbar.getButtons) return;
      var schema = SCHEMAS[category] || SCHEMAS.generic;
      var geom = schema.geom; // 'point' | 'line' | 'polygon' | 'any'
      var isPoint = geom === 'point';
      var isLine = geom === 'line';
      var isPolygon = geom === 'polygon';
      var anyGeom = !isPoint && !isLine && !isPolygon;
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

    function applyStyleToGroup(meta, color) {
      meta.group.eachLayer(function (lyr) {
        if (isIconMarker(lyr)) {
          try { lyr.setIcon(makePointIcon(meta.category, color)); } catch (_) {}
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
      var ids = Object.keys(layers);
      if (!ids.length) { legendBody.innerHTML = '<div class="gis-leg-empty">No layers</div>'; return; }
      legendBody.innerHTML = ids.map(function (k) {
        var m = layers[k];
        var schema = SCHEMAS[m.category] || SCHEMAS.generic;
        return '<div class="gis-leg-row' + (m.visible ? '' : ' off') + '">' +
          legendSwatch(m.category, m.color) +
          '<span class="gis-leg-name">' + esc(m.name) + '</span>' +
          '<span class="gis-leg-cat">' + esc(schema.label) + '</span></div>';
      }).join('');
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
      if (schema.geom === 'line') {
        var len = lineLength(lyr);
        if (len != null && (isNew || !p.length_m)) p.length_m = len;
      }
      if (schema.geom === 'polygon') {
        var a = polygonArea(lyr);
        if (a != null && (isNew || !p.area_m2)) p.area_m2 = a;
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
        var id = p.building_id || p.building_name || '';
        var blk = p.block || '';
        var s = [id, blk].filter(Boolean).join(' \u00b7 ');
        return s || '';
      }
      if (meta.category === 'building_poly') {
        var pid = p.building_id || p.building_name || '';
        var pblk = p.block || '';
        var ps = [pid, pblk].filter(Boolean).join(' \u00b7 ');
        return ps || '';
      }
      if (meta.category === 'valve') return p.valve_id || '';
      if (meta.category === 'pipe') return p.pipe_id || '';
      return featureTitle(meta, p) === (SCHEMAS[meta.category] || SCHEMAS.generic).label ? '' : featureTitle(meta, p);
    }

    function isPointLayer(lyr) {
      return (lyr instanceof L.CircleMarker) || (lyr instanceof L.Marker);
    }

    function updateTooltip(meta, lyr) {
      var props = lyr.feature && lyr.feature.properties;
      var point = isPointLayer(lyr);
      // Building polygons also get a permanent label (centered), like building points.
      var permLabel = point || meta.category === 'building_poly';
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
      lyr.on('click', function () {
        if (inEditMode()) return;
        openAttributeEditor(meta, lyr);
      });
      lyr.on('pm:edit pm:update pm:dragend', function () {
        var schema = SCHEMAS[meta.category] || SCHEMAS.generic;
        if (schema.geom === 'line' && lyr.feature && lyr.feature.properties) {
          var len = lineLength(lyr);
          if (len != null) lyr.feature.properties.length_m = len;
        }
        if (schema.geom === 'polygon' && lyr.feature && lyr.feature.properties) {
          var ar = polygonArea(lyr);
          if (ar != null) lyr.feature.properties.area_m2 = ar;
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
      attrBody.innerHTML = '';
      // Schema fields first, then any extra imported properties as text inputs.
      var fields = schema.fields.slice();
      var known = {};
      fields.forEach(function (f) { known[f.key] = true; });
      Object.keys(props).forEach(function (k) {
        if (k.charAt(0) === '_') return;
        if (!known[k]) { known[k] = true; fields.push({ key: k, label: k, type: 'text' }); }
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
        }
        if (fld.readonly) input.readOnly = true;
        input.dataset.key = fld.key;
        wrap.appendChild(input);
        attrBody.appendChild(wrap);
      });
      buildPhotoSection(lyr);
      attrPanel.hidden = false;
    }

    // ---- Field photos per feature (stored as dataURLs in props._photos) ----
    function buildPhotoSection(lyr) {
      var props = lyr.feature.properties;
      if (!Array.isArray(props._photos)) props._photos = [];
      var sec = document.createElement('div');
      sec.className = 'gis-photo-sec';
      var head = document.createElement('div');
      head.className = 'gis-photo-head';
      head.innerHTML = '<span>Photos</span>';
      var addLbl = document.createElement('label');
      addLbl.className = 'gis-photo-add';
      addLbl.textContent = '\uff0b Add';
      var fileIn = document.createElement('input');
      fileIn.type = 'file'; fileIn.accept = 'image/*';
      fileIn.setAttribute('capture', 'environment');
      fileIn.multiple = true; fileIn.hidden = true;
      addLbl.appendChild(fileIn);
      head.appendChild(addLbl);
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
          var t = document.createElement('div');
          t.className = 'gis-photo-thumb';
          var img = document.createElement('img');
          img.src = ph.dataUrl; img.alt = ph.name || ('photo ' + (idx + 1));
          img.addEventListener('click', function () { openPhotoLightbox(ph.dataUrl); });
          var rm = document.createElement('button');
          rm.type = 'button'; rm.className = 'gis-photo-rm'; rm.textContent = '\u00d7';
          rm.title = 'Remove photo';
          rm.addEventListener('click', function () {
            props._photos.splice(idx, 1);
            renderStrip();
          });
          t.appendChild(img); t.appendChild(rm);
          strip.appendChild(t);
        });
      }
      renderStrip();

      fileIn.addEventListener('change', function () {
        var files = Array.prototype.slice.call(fileIn.files || []);
        fileIn.value = '';
        if (!files.length) return;
        var pending = files.length;
        files.forEach(function (file) {
          var reader = new FileReader();
          reader.onload = function () {
            props._photos.push({
              dataUrl: reader.result,
              name: file.name,
              time: Date.now(),
            });
            pending -= 1;
            if (pending === 0) renderStrip();
          };
          reader.onerror = function () { pending -= 1; if (pending === 0) renderStrip(); };
          reader.readAsDataURL(file);
        });
      });
    }

    function openPhotoLightbox(src) {
      var ov = document.createElement('div');
      ov.className = 'gis-photo-lightbox';
      var img = document.createElement('img');
      img.src = src;
      ov.appendChild(img);
      ov.addEventListener('click', function () { ov.remove(); });
      host.appendChild(ov);
    }

    function saveAttrFromEditor() {
      if (!editorTarget) return;
      var meta = editorTarget.meta, lyr = editorTarget.lyr;
      var props = (lyr.feature && lyr.feature.properties) || {};
      attrBody.querySelectorAll('[data-key]').forEach(function (inp) {
        props[inp.dataset.key] = inp.value;
      });
      lyr.feature.properties = props;
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
      if (tableTitle) tableTitle.textContent = meta.name + ' \u2014 ' + feats.length + ' feature' + (feats.length === 1 ? '' : 's');
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
    }

    // ---- Sidebar row ----
    function buildRow(meta) {
      var list = $('layers');
      var row = document.createElement('div');
      row.className = 'gis-layer-row';
      row.dataset.id = meta.id;
      row.innerHTML =
        '<input type="checkbox" class="gis-vis" ' + (meta.visible ? 'checked' : '') + ' title="Toggle visibility">' +
        '<span class="gis-swatch" style="background:' + meta.color + '"></span>' +
        '<input type="color" class="gis-color" value="' + meta.color + '" title="Layer colour">' +
        '<span class="gis-name" tabindex="0" title="Click to make active; double-click to rename">' + esc(meta.name) + '</span>' +
        '<span class="gis-cat" title="Feature type">' + esc((SCHEMAS[meta.category] || SCHEMAS.generic).label) + '</span>' +
        '<span class="gis-count" data-role="count">0</span>' +
        '<button type="button" class="gis-ic" data-act="table" title="Open attribute table">\u2637</button>' +
        '<button type="button" class="gis-ic" data-act="zoom" title="Zoom to layer">⤢</button>' +
        '<button type="button" class="gis-ic" data-act="export" title="Export GeoJSON">⤓</button>' +
        '<button type="button" class="gis-ic gis-ic-del" data-act="del" title="Delete layer">✕</button>';
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
      row.querySelector('[data-act="table"]').addEventListener('click', function () { openAttributeTable(meta); });
      row.querySelector('[data-act="del"]').addEventListener('click', function () { deleteLayer(meta); });

      updateCount(meta);
    }

    function updateCount(meta) {
      if (!meta.row) return;
      var n = meta.group.getLayers().length;
      var el = meta.row.querySelector('[data-role="count"]');
      if (el) el.textContent = n;
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

    function exportLayer(meta) {
      var fc = groupToGeoJSON(meta.group);
      if (!fc.features.length) { toast('Nothing to export'); return; }
      var base = (meta.name || 'layer').replace(/[^\w.-]+/g, '_');
      download(base + '.geojson', JSON.stringify(fc, null, 2), 'application/geo+json');
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

    // ---- New-layer button ----
    host.querySelector('[data-act="new-layer"]').addEventListener('click', function () {
      var meta = createLayer({ category: catSelectValue() });
      setActive(meta.id);
      persist(meta.id);
    });

    // ---- Mobile panel drawer toggle ----
    var sidebarEl = $('sidebar');
    function setPanelOpen(open) {
      if (sidebarEl) sidebarEl.classList.toggle('open', open);
      host.classList.toggle('panel-open', open);
      setTimeout(function () { try { map.invalidateSize(); } catch (_) {} }, 220);
    }
    var pToggle = host.querySelector('[data-act="panel-toggle"]');
    var pClose = host.querySelector('[data-act="panel-close"]');
    if (pToggle) pToggle.addEventListener('click', function () { setPanelOpen(true); });
    if (pClose) pClose.addEventListener('click', function () { setPanelOpen(false); });

    // ---- Attribute editor wiring ----
    host.querySelector('[data-act="attr-close"]').addEventListener('click', function () { attrPanel.hidden = true; });
    host.querySelector('[data-act="attr-save"]').addEventListener('click', saveAttrFromEditor);
    host.querySelector('[data-act="attr-del"]').addEventListener('click', deleteFeatureFromEditor);
    host.querySelector('[data-act="attr-zoom"]').addEventListener('click', zoomFeatureFromEditor);
    host.querySelector('[data-act="table-close"]').addEventListener('click', function () { tablePanel.hidden = true; });
    host.querySelector('[data-act="table-csv"]').addEventListener('click', function () { exportTableSpreadsheet(currentTableMeta, 'csv'); });
    host.querySelector('[data-act="table-xlsx"]').addEventListener('click', function () { exportTableSpreadsheet(currentTableMeta, 'xlsx'); });

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

    function importCollection(fc, name) {
      if (!fc || !fc.type) { toast('Empty / unsupported file'); return; }
      var meta = createLayer({ name: name || 'Imported' });
      loadGeoJSONInto(meta, fc);
      updateCount(meta);
      persist(meta.id);
      zoomTo(meta);
      setActive(meta.id);
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
        var meta = createLayer({
          id: rec.id, name: rec.name, category: rec.category,
          color: rec.color, visible: rec.visible !== false,
        });
        if (rec.geojson) loadGeoJSONInto(meta, rec.geojson);
        updateCount(meta);
      });
      if (!recs.length) {
        // Seed with the standard KUKL field-survey layers.
        ['building', 'building_poly', 'pipe', 'valve'].forEach(function (cat) {
          var nm = cat === 'building_poly' ? 'Building Polygons' : SCHEMAS[cat].label + 's';
          var m = createLayer({ category: cat, name: nm });
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
