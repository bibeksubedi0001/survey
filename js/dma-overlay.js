/* =============================================================
 * KUKLDma — DMA overlay layer for Leaflet maps
 *
 *  window.KUKLDma.attach(map, { positionContainer })
 *    → returns { setActiveDma(id), getActiveDma(), destroy() }
 *
 *  Reads ./data/dma/index.json then lazily fetches each DMA's
 *  boundary / connections / pipes / devices GeoJSON on demand.
 *
 *  UI: floating control panel inside the map ─
 *    [DMA ▼  ] [☑ All outlines]
 *    Layers: [☑ Boundary] [☑ Connections] [☑ Pipes] [☑ Devices]
 * ============================================================ */
(function () {
  'use strict';

  if (window.KUKLDma) return;

  var DATA_BASE = 'data/dma/';
  var INDEX_URL = DATA_BASE + 'index.json';

  // Shared state across map instances
  var _indexPromise = null;
  var _geojsonCache = Object.create(null);  // key = 'dma/layer' → GeoJSON

  function loadIndex() {
    if (!_indexPromise) {
      _indexPromise = fetch(INDEX_URL, { cache: 'force-cache' })
        .then(function (r) { if (!r.ok) throw new Error('index.json ' + r.status); return r.json(); })
        .catch(function (e) { _indexPromise = null; throw e; });
    }
    return _indexPromise;
  }

  function loadLayer(dmaId, layer) {
    var key = dmaId + '/' + layer;
    if (_geojsonCache[key]) return Promise.resolve(_geojsonCache[key]);
    return fetch(DATA_BASE + key + '.geojson', { cache: 'force-cache' })
      .then(function (r) { if (!r.ok) throw new Error(layer + ' ' + r.status); return r.json(); })
      .then(function (gj) { _geojsonCache[key] = gj; return gj; });
  }

  // Styling
  var STYLE = {
    boundary: { color: '#000', weight: 2, opacity: 0.9, fill: true, fillColor: '#000', fillOpacity: 0.05, dashArray: '4 4' },
    boundaryAll: { color: '#888', weight: 1, opacity: 0.8, fill: false, dashArray: '2 4' },
    pipes:    { color: '#0d47a1', weight: 1.4, opacity: 0.85 },
    connection: { radius: 2, weight: 0, color: '#1565c0', fillColor: '#1976d2', fillOpacity: 0.85 },
    devices: {
      valve:     { color: '#000',     fillColor: '#fff',    radius: 5, weight: 1.5 },
      hydrant:   { color: '#b71c1c',  fillColor: '#e53935', radius: 5, weight: 1.5 },
      flowmeter: { color: '#1b5e20',  fillColor: '#43a047', radius: 5, weight: 1.5 },
      logger:    { color: '#4a148c',  fillColor: '#8e24aa', radius: 5, weight: 1.5 },
    },
  };
  var DEVICE_LABELS = { valve: 'Valve', hydrant: 'Hydrant', flowmeter: 'Flow meter', logger: 'Pressure logger' };

  function attach(map, opts) {
    opts = opts || {};
    var L = window.L;
    if (!L) { console.warn('[KUKLDma] Leaflet not loaded'); return null; }

    var state = {
      activeId: null,
      showAllOutlines: false,
      layersVisible: { boundary: true, connections: true, pipes: true, devices: true },
      activeLayers: {},   // layer-name → L.Layer
      outlineLayer: null, // FeatureGroup for ALL boundaries
      index: null,
    };

    // ---------- Build control panel ----------
    var Control = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function () {
        var c = L.DomUtil.create('div', 'kukl-dma-ctrl leaflet-bar');
        c.innerHTML =
          '<div class="kdma-row kdma-head">' +
            '<select class="kdma-select"><option value="">— DMA —</option></select>' +
            '<button type="button" class="kdma-fit" title="Fit to DMA">⤢</button>' +
            '<button type="button" class="kdma-close" title="Hide DMA layers">×</button>' +
          '</div>' +
          '<label class="kdma-row"><input type="checkbox" class="kdma-all"> Show all DMA outlines</label>' +
          '<div class="kdma-row kdma-layers">' +
            '<label><input type="checkbox" class="kdma-lyr" data-lyr="boundary" checked> Boundary</label>' +
            '<label><input type="checkbox" class="kdma-lyr" data-lyr="connections" checked> Connections</label>' +
            '<label><input type="checkbox" class="kdma-lyr" data-lyr="pipes" checked> Pipes</label>' +
            '<label><input type="checkbox" class="kdma-lyr" data-lyr="devices" checked> Devices</label>' +
          '</div>' +
          '<div class="kdma-row kdma-stats" hidden></div>';
        L.DomEvent.disableClickPropagation(c);
        L.DomEvent.disableScrollPropagation(c);
        return c;
      },
    });
    var ctrl = new Control(opts.controlOpts || {});
    ctrl.addTo(map);
    var root = ctrl.getContainer();
    var $sel  = root.querySelector('.kdma-select');
    var $all  = root.querySelector('.kdma-all');
    var $fit  = root.querySelector('.kdma-fit');
    var $close= root.querySelector('.kdma-close');
    var $stats= root.querySelector('.kdma-stats');

    // ---------- Public API ----------
    function destroy() {
      removeActive();
      removeOutlines();
      map.removeControl(ctrl);
    }

    function setActiveDma(id) {
      $sel.value = id || '';
      applyActive();
    }

    // ---------- Internals ----------
    function removeActive() {
      Object.keys(state.activeLayers).forEach(function (k) {
        try { map.removeLayer(state.activeLayers[k]); } catch (_) {}
      });
      state.activeLayers = {};
    }
    function removeOutlines() {
      if (state.outlineLayer) { try { map.removeLayer(state.outlineLayer); } catch (_) {} state.outlineLayer = null; }
    }

    function applyActive() {
      var id = $sel.value;
      state.activeId = id || null;
      removeActive();
      $stats.hidden = !id;
      if (!id) return;
      var meta = (state.index && state.index.dmas || []).find(function (d) { return d.id === id; });
      if (!meta) return;
      $stats.innerHTML = renderStats(meta);
      var jobs = [];
      if (state.layersVisible.boundary    && meta.layers.indexOf('boundary')    >= 0) jobs.push(addBoundary(id));
      if (state.layersVisible.pipes       && meta.layers.indexOf('pipes')       >= 0) jobs.push(addPipes(id));
      if (state.layersVisible.connections && meta.layers.indexOf('connections') >= 0) jobs.push(addConnections(id));
      if (state.layersVisible.devices     && meta.layers.indexOf('devices')     >= 0) jobs.push(addDevices(id));
      Promise.all(jobs).then(function () {
        if (meta.bbox) {
          try {
            map.fitBounds([[meta.bbox[1], meta.bbox[0]], [meta.bbox[3], meta.bbox[2]]], { padding: [20, 20], maxZoom: 18 });
          } catch (_) {}
        }
      });
    }

    function renderStats(m) {
      var c = m.counts || {};
      return '<b>' + escapeHtml(m.label) + '</b><br>' +
        '<span class="kdma-pill">' + (c.connections || 0) + ' connections</span>' +
        '<span class="kdma-pill">' + (c.pipes       || 0) + ' pipes</span>' +
        '<span class="kdma-pill">' + (c.devices     || 0) + ' devices</span>';
    }
    function escapeHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function addBoundary(id) {
      return loadLayer(id, 'boundary').then(function (gj) {
        var layer = L.geoJSON(gj, {
          style: STYLE.boundary,
          interactive: false,
        }).addTo(map);
        state.activeLayers.boundary = layer;
      }).catch(noop);
    }
    function addPipes(id) {
      return loadLayer(id, 'pipes').then(function (gj) {
        var layer = L.geoJSON(gj, { style: STYLE.pipes, interactive: false }).addTo(map);
        state.activeLayers.pipes = layer;
      }).catch(noop);
    }
    function addConnections(id) {
      return loadLayer(id, 'connections').then(function (gj) {
        var layer = L.geoJSON(gj, {
          pointToLayer: function (f, latlng) { return L.circleMarker(latlng, STYLE.connection); },
          interactive: false,
        }).addTo(map);
        state.activeLayers.connections = layer;
      }).catch(noop);
    }
    function addDevices(id) {
      return loadLayer(id, 'devices').then(function (gj) {
        var layer = L.geoJSON(gj, {
          pointToLayer: function (f, latlng) {
            var kind = (f.properties && f.properties.kind) || 'valve';
            var s = STYLE.devices[kind] || STYLE.devices.valve;
            return L.circleMarker(latlng, {
              radius: s.radius, color: s.color, weight: s.weight,
              fillColor: s.fillColor, fillOpacity: 0.95,
            });
          },
          onEachFeature: function (f, lyr) {
            var kind = (f.properties && f.properties.kind) || 'asset';
            lyr.bindTooltip(DEVICE_LABELS[kind] || kind, { sticky: true });
          },
        }).addTo(map);
        state.activeLayers.devices = layer;
      }).catch(noop);
    }

    function applyShowAll() {
      removeOutlines();
      if (!state.showAllOutlines) return;
      var promises = (state.index.dmas || []).map(function (m) {
        if (m.layers.indexOf('boundary') < 0) return null;
        return loadLayer(m.id, 'boundary').then(function (gj) { return { meta: m, gj: gj }; }).catch(function () { return null; });
      });
      Promise.all(promises).then(function (results) {
        var group = L.featureGroup();
        results.forEach(function (r) {
          if (!r) return;
          var layer = L.geoJSON(r.gj, { style: STYLE.boundaryAll, interactive: true });
          layer.bindTooltip(r.meta.label, { sticky: true });
          layer.on('click', function () { setActiveDma(r.meta.id); });
          group.addLayer(layer);
        });
        if (group.getLayers().length) { group.addTo(map); state.outlineLayer = group; }
      });
    }

    function noop() {}

    // ---------- Event wiring ----------
    $sel.addEventListener('change', applyActive);
    $all.addEventListener('change', function () {
      state.showAllOutlines = $all.checked;
      applyShowAll();
    });
    $close.addEventListener('click', function () { setActiveDma(''); });
    $fit.addEventListener('click', function () {
      var meta = state.activeId && state.index.dmas.find(function (d) { return d.id === state.activeId; });
      if (meta && meta.bbox) {
        map.fitBounds([[meta.bbox[1], meta.bbox[0]], [meta.bbox[3], meta.bbox[2]]], { padding: [20, 20], maxZoom: 18 });
      }
    });
    root.querySelectorAll('.kdma-lyr').forEach(function (cb) {
      cb.addEventListener('change', function () {
        state.layersVisible[cb.dataset.lyr] = cb.checked;
        applyActive();
      });
    });

    // ---------- Load index and populate dropdown ----------
    loadIndex().then(function (idx) {
      state.index = idx;
      (idx.dmas || []).sort(function (a, b) {
        var ax = a.id.split('.').map(Number), bx = b.id.split('.').map(Number);
        for (var i = 0; i < Math.max(ax.length, bx.length); i++) {
          if ((ax[i]||0) !== (bx[i]||0)) return (ax[i]||0) - (bx[i]||0);
        }
        return 0;
      }).forEach(function (m) {
        var opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.label;
        $sel.appendChild(opt);
      });
      if (opts.defaultId) setActiveDma(opts.defaultId);
    }).catch(function (e) {
      console.warn('[KUKLDma] could not load index:', e);
      root.querySelector('.kdma-head').innerHTML = '<span style="color:#b00;font-size:11px;">DMA data unavailable</span>';
    });

    return { setActiveDma: setActiveDma, getActiveDma: function () { return state.activeId; }, destroy: destroy };
  }

  window.KUKLDma = { attach: attach };
})();
