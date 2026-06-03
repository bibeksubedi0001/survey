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
      '  <div class="gis-side-head">' +
      '    <strong>Layers</strong>' +
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
      '  </div>' +
      '  <div class="gis-side-head"><strong>Reference</strong></div>' +
      '  <label class="gis-ref-toggle"><input type="checkbox" data-role="dma-toggle"> Show DMA network</label>' +
      '  <p class="gis-tip">Use the toolbar (top-left of the map) to draw points, lines and polygons into the <em>active</em> layer. Tap a feature to edit or delete it. Everything is saved offline automatically.</p>' +
      '</div>' +
      '<div class="gis-map-wrap"><div class="gis-map" data-role="map"></div></div>';

    var $ = function (r) { return host.querySelector('[data-role="' + r + '"]'); };
    var mapEl = $('map');

    // ---- Init map ----
    var map = L.map(mapEl, { zoomControl: true }).setView(KTM_DEFAULT, 14);
    var osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap',
    }).addTo(map);
    var sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, attribution: 'Esri',
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

    // ---- Layer model ----
    // layers: id → { id, name, color, visible, group:L.FeatureGroup, row:DOM }
    var layers = Object.create(null);
    var activeId = null;
    var colorIdx = 0;
    var dmaCtl = null;

    function nextColor() { var c = PALETTE[colorIdx % PALETTE.length]; colorIdx++; return c; }

    function styleFor(color) {
      return { color: color, weight: 3, fillColor: color, fillOpacity: 0.25 };
    }
    function applyStyleToGroup(group, color) {
      group.eachLayer(function (lyr) {
        if (lyr.setStyle) { try { lyr.setStyle(styleFor(color)); } catch (_) {} }
        if (lyr instanceof L.CircleMarker) {
          try { lyr.setStyle({ color: color, fillColor: color, fillOpacity: 0.9 }); } catch (_) {}
        }
      });
    }

    // Persist one layer to IndexedDB.
    function persist(id) {
      var meta = layers[id];
      if (!meta) return;
      var fc = groupToGeoJSON(meta.group);
      dbPutLayer({
        id: id, name: meta.name, color: meta.color,
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
      var color = opts.color || nextColor();
      var group = L.featureGroup();
      if (opts.visible !== false) group.addTo(map);
      var meta = {
        id: id,
        name: opts.name || ('Layer ' + (Object.keys(layers).length + 1)),
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
      return meta;
    }

    function loadGeoJSONInto(meta, fc) {
      var added = L.geoJSON(fc, {
        style: styleFor(meta.color),
        pointToLayer: function (f, latlng) {
          return L.circleMarker(latlng, {
            radius: 6, color: meta.color, weight: 2,
            fillColor: meta.color, fillOpacity: 0.9,
          });
        },
        onEachFeature: function (f, lyr) { bindFeature(meta, lyr, f); },
      });
      added.eachLayer(function (lyr) { meta.group.addLayer(lyr); });
    }

    function bindFeature(meta, lyr, f) {
      var p = (f && f.properties) || {};
      var label = p.name || p.Name || p.NAME || '';
      if (label) lyr.bindTooltip(String(label), { sticky: true });
      lyr.feature = f || lyr.feature || { type: 'Feature', properties: {}, geometry: null };
    }

    // ---- Active layer handling ----
    function setActive(id) {
      activeId = id;
      Object.keys(layers).forEach(function (k) {
        var r = layers[k].row;
        if (r) r.classList.toggle('active', k === id);
      });
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
        '<span class="gis-count" data-role="count">0</span>' +
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
        persist(meta.id);
      });
      colorIn.addEventListener('input', function () {
        meta.color = colorIn.value;
        swatch.style.background = meta.color;
        applyStyleToGroup(meta.group, meta.color);
        persist(meta.id);
      });
      nameEl.addEventListener('click', function () { setActive(meta.id); });
      nameEl.addEventListener('dblclick', function () { renameLayer(meta, nameEl); });
      nameEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActive(meta.id); }
      });

      row.querySelector('[data-act="zoom"]').addEventListener('click', function () { zoomTo(meta); });
      row.querySelector('[data-act="export"]').addEventListener('click', function () { exportLayer(meta); });
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

    function deleteLayer(meta) {
      if (!confirm('Delete layer "' + meta.name + '" and all its features? This cannot be undone.')) return;
      try { map.removeLayer(meta.group); } catch (_) {}
      if (meta.row) meta.row.remove();
      delete layers[meta.id];
      dbDelLayer(meta.id);
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
        meta = createLayer({ name: 'Layer 1' });
        setActive(meta.id);
      }
      // Remove from map's default placement, add to the active group + style it.
      try { map.removeLayer(lyr); } catch (_) {}
      if (lyr.setStyle) { try { lyr.setStyle(styleFor(meta.color)); } catch (_) {} }
      if (lyr instanceof L.CircleMarker) {
        try { lyr.setStyle({ color: meta.color, fillColor: meta.color, fillOpacity: 0.9 }); } catch (_) {}
      }
      lyr.feature = lyr.feature || { type: 'Feature', properties: {}, geometry: null };
      meta.group.addLayer(lyr);

      // Re-persist on later edits of this individual feature.
      lyr.on('pm:edit pm:update pm:dragend', function () { persist(meta.id); });
      lyr.on('pm:remove', function () { persist(meta.id); updateCount(meta); });

      updateCount(meta);
      persist(meta.id);
    });

    // Global remove (toolbar trash) → recount/persist everything.
    map.on('pm:remove', function () {
      Object.keys(layers).forEach(function (k) { updateCount(layers[k]); persist(k); });
    });

    // ---- New-layer button ----
    host.querySelector('[data-act="new-layer"]').addEventListener('click', function () {
      var name = prompt('New layer name:', 'Layer ' + (Object.keys(layers).length + 1));
      if (name === null) return;
      var meta = createLayer({ name: name.trim() || undefined });
      setActive(meta.id);
      persist(meta.id);
    });

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

    // ---- Restore persisted layers ----
    dbAllLayers().then(function (recs) {
      recs.sort(function (a, b) { return (a.updatedAt || 0) - (b.updatedAt || 0); });
      recs.forEach(function (rec) {
        var meta = createLayer({
          id: rec.id, name: rec.name, color: rec.color, visible: rec.visible !== false,
        });
        if (rec.geojson) loadGeoJSONInto(meta, rec.geojson);
        updateCount(meta);
      });
      if (!recs.length) {
        // Start with one empty default layer so drawing works immediately.
        var m = createLayer({ name: 'My Survey Layer' });
        persist(m.id);
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
