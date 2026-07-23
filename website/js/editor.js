/* =============================================================
 * HydroFlow hydraulic network editor
 *
 * Routes every editing tool to the real pipe/node/valve layer groups
 * exposed by KUKLGis. Temporary layers are used only for previews,
 * selections and analysis highlights.
 * ============================================================ */
(function (root) {
  'use strict';
  if (root.HydroFlowEditor) return;

  var HYDRAULIC_CATEGORIES = { pipe: true, node: true, valve: true };
  var CURSORS = {
    select: 'pointer',
    'add-pipe': 'crosshair',
    'add-node': 'crosshair',
    'add-valve': 'crosshair',
    split: 'crosshair',
    move: 'grab',
    delete: 'not-allowed',
    reverse: 'pointer',
    trace: 'crosshair',
  };

  function mount(options) {
    options = options || {};
    var map = options.map;
    var host = options.host;
    var panel = options.panel;
    var bridge = options.bridge;
    var L = root.L;
    if (!map || !host || !panel || !bridge || !L) throw new Error('HydroFlow editor mount options are incomplete.');
    if (!root.HydroFlowMap || !root.HydroFlowTopology || !root.HydroFlowAnalysis) {
      throw new Error('HydroFlow map, topology and analysis modules must load before the editor.');
    }
    if (panel._hydroFlowController) return panel._hydroFlowController;

    var network = root.HydroFlowMap.create(bridge);
    var workspaceActive = false;
    var activeTool = 'select';
    var selectedEntry = null;
    var movingEntry = null;
    var movingStartGeometry = null;
    var pipeDraft = [];
    var pipePreview = null;
    var topologyReport = null;
    var lastTraceResult = null;
    var destroyed = false;

    // Trace selection state stays explicit so A/B selection can be reused.
    var startPoint = null;
    var endPoint = null;
    var selectionMode = null;
    var temporaryMarkers = [];

    var selectionLayerGroup = L.layerGroup().addTo(map);
    var interactionLayerGroup = L.layerGroup().addTo(map);
    var analysisLayerGroup = L.layerGroup().addTo(map);
    var doubleClickZoomWasEnabled = !!(map.doubleClickZoom && map.doubleClickZoom.enabled());

    panel.innerHTML =
      '<div class="hydroflow-section">' +
      '  <div class="hydroflow-section-head"><span>Network Editing</span><span class="hydroflow-count" data-role="network-count">0 / 0 / 0</span></div>' +
      '  <div class="hydroflow-tool-grid" role="toolbar" aria-label="Hydraulic network editing tools">' +
      '    <button type="button" class="hydroflow-tool active" data-tool="select" title="Select feature"><span aria-hidden="true">↖</span><b>Select</b></button>' +
      '    <button type="button" class="hydroflow-tool" data-tool="add-pipe" title="Add pipe"><span aria-hidden="true">＋</span><b>Pipe</b></button>' +
      '    <button type="button" class="hydroflow-tool" data-tool="add-node" title="Add hydraulic node"><span aria-hidden="true">○</span><b>Node</b></button>' +
      '    <button type="button" class="hydroflow-tool" data-tool="add-valve" title="Add valve"><span aria-hidden="true">◇</span><b>Valve</b></button>' +
      '    <button type="button" class="hydroflow-tool" data-tool="split" title="Split pipe"><span aria-hidden="true">✂</span><b>Split</b></button>' +
      '    <button type="button" class="hydroflow-tool" data-tool="move" title="Move feature"><span aria-hidden="true">✥</span><b>Move</b></button>' +
      '    <button type="button" class="hydroflow-tool" data-tool="delete" title="Delete feature"><span aria-hidden="true">×</span><b>Delete</b></button>' +
      '    <button type="button" class="hydroflow-tool" data-tool="reverse" title="Reverse pipe direction"><span aria-hidden="true">⇄</span><b>Reverse</b></button>' +
      '  </div>' +
      '  <div class="hydroflow-draft-actions" data-role="pipe-actions" hidden>' +
      '    <button type="button" class="btn btn-mini btn-primary" data-action="finish-pipe" disabled>FINISH PIPE</button>' +
      '    <button type="button" class="btn btn-mini btn-outline" data-action="cancel-pipe">CANCEL</button>' +
      '  </div>' +
      '</div>' +
      '<div class="hydroflow-section">' +
      '  <div class="hydroflow-section-head"><span>Hydraulic Trace</span></div>' +
      '  <div class="hydroflow-segmented" role="radiogroup" aria-label="Trace direction">' +
      '    <label><input type="radio" name="hydroflow-direction" value="downstream" checked><span>Downstream</span></label>' +
      '    <label><input type="radio" name="hydroflow-direction" value="upstream"><span>Upstream</span></label>' +
      '  </div>' +
      '  <div class="hydroflow-trace-actions">' +
      '    <button type="button" class="btn btn-mini btn-outline" data-action="pick-trace">SELECT A + B</button>' +
      '    <button type="button" class="btn btn-mini btn-primary" data-action="run-trace" disabled>RUN TRACE</button>' +
      '    <button type="button" class="hydroflow-icon-btn" data-action="clear-trace" title="Clear trace" aria-label="Clear trace">×</button>' +
      '  </div>' +
      '  <div class="hydroflow-point-state"><span data-role="trace-a">A: not set</span><span data-role="trace-b">B: not set</span></div>' +
      '</div>' +
      '<div class="hydroflow-section">' +
      '  <div class="hydroflow-section-head"><span>Topology</span></div>' +
      '  <div class="hydroflow-topology-actions">' +
      '    <button type="button" class="btn btn-mini btn-outline" data-action="validate">VALIDATE</button>' +
      '    <input type="search" data-role="topology-search" placeholder="Search Node ID or Pipe ID" autocomplete="off" spellcheck="false">' +
      '  </div>' +
      '  <div class="hydroflow-topology-results" data-role="topology-results"><div class="hydroflow-empty">Validation not run</div></div>' +
      '</div>' +
      '<div class="hydroflow-section hydroflow-export">' +
      '  <button type="button" class="btn btn-outline gis-full-btn" data-action="export-geojson">EXPORT NETWORK .GEOJSON</button>' +
      '</div>' +
      '<div class="hydroflow-status" data-role="status" aria-live="polite">Select a hydraulic feature.</div>';

    var statusElement = panel.querySelector('[data-role="status"]');
    var countElement = panel.querySelector('[data-role="network-count"]');
    var pipeActions = panel.querySelector('[data-role="pipe-actions"]');
    var finishPipeButton = panel.querySelector('[data-action="finish-pipe"]');
    var runTraceButton = panel.querySelector('[data-action="run-trace"]');
    var traceAElement = panel.querySelector('[data-role="trace-a"]');
    var traceBElement = panel.querySelector('[data-role="trace-b"]');
    var topologySearch = panel.querySelector('[data-role="topology-search"]');
    var topologyResults = panel.querySelector('[data-role="topology-results"]');

    function setStatus(message, tone) {
      statusElement.textContent = message;
      statusElement.dataset.tone = tone || 'info';
    }

    function notify(message, tone) {
      setStatus(message, tone);
      if (bridge.toast) bridge.toast(message);
    }

    function updateCounts() {
      countElement.textContent = network.entries('pipe').length + ' pipes / ' +
        network.entries('node').length + ' nodes / ' + network.entries('valve').length + ' valves';
    }

    function disableGeomanModes() {
      if (!map.pm) return;
      try {
        var activeShape = map.pm.Draw && typeof map.pm.Draw.getActiveShape === 'function'
          ? map.pm.Draw.getActiveShape() : null;
        if (activeShape && typeof map.pm.disableDraw === 'function') map.pm.disableDraw(activeShape);
      } catch (_) {}
      var modes = [
        ['disableGlobalEditMode', 'globalEditModeEnabled'],
        ['disableGlobalDragMode', 'globalDragModeEnabled'],
        ['disableGlobalRemovalMode', 'globalRemovalModeEnabled'],
        ['disableGlobalCutMode', 'globalCutModeEnabled'],
        ['disableGlobalRotateMode', 'globalRotateModeEnabled'],
      ];
      modes.forEach(function (mode) {
        try {
          if (typeof map.pm[mode[0]] === 'function' && typeof map.pm[mode[1]] === 'function' && map.pm[mode[1]]()) {
            map.pm[mode[0]]();
          }
        } catch (_) {}
      });
    }

    function applyCursor() {
      var cursor = workspaceActive ? (CURSORS[activeTool] || 'default') : '';
      map.getContainer().style.cursor = cursor;
      map.getContainer().classList.toggle('hydroflow-move-active', workspaceActive && activeTool === 'move');
    }

    function setToolButtonState() {
      panel.querySelectorAll('[data-tool]').forEach(function (button) {
        button.classList.toggle('active', button.dataset.tool === activeTool);
        button.setAttribute('aria-pressed', button.dataset.tool === activeTool ? 'true' : 'false');
      });
      pipeActions.hidden = activeTool !== 'add-pipe';
    }

    function clearPipeDraft() {
      pipeDraft = [];
      interactionLayerGroup.clearLayers();
      pipePreview = null;
      finishPipeButton.disabled = true;
    }

    function disarmMove() {
      if (!movingEntry || !movingEntry.layer) {
        movingEntry = null;
        movingStartGeometry = null;
        return;
      }
      var layer = movingEntry.layer;
      try { layer.off('pm:dragstart', onMoveDragStart); } catch (_) {}
      try { layer.off('pm:dragend', onMoveDragEnd); } catch (_) {}
      try { layer.off('dragstart', onMoveDragStart); } catch (_) {}
      try { layer.off('dragend', onMoveDragEnd); } catch (_) {}
      try {
        if (layer.pm && typeof layer.pm.disableLayerDrag === 'function') layer.pm.disableLayerDrag();
        else if (layer.dragging && layer.dragging.disable) layer.dragging.disable();
      } catch (_) {}
      movingEntry = null;
      movingStartGeometry = null;
      applyCursor();
    }

    function activateTool(tool) {
      if (!CURSORS[tool]) tool = 'select';
      if (activeTool === 'add-pipe' && tool !== 'add-pipe') clearPipeDraft();
      if (activeTool === 'move' && tool !== 'move') disarmMove();
      activeTool = tool;
      if (workspaceActive) disableGeomanModes();
      if (map.doubleClickZoom) {
        if (workspaceActive && activeTool === 'add-pipe') map.doubleClickZoom.disable();
        else if (doubleClickZoomWasEnabled) map.doubleClickZoom.enable();
      }
      setToolButtonState();
      applyCursor();
      var messages = {
        select: 'Select a pipe, node or valve.',
        'add-pipe': 'Click pipe vertices; double-click or use Finish Pipe.',
        'add-node': 'Click the map to add a hydraulic node.',
        'add-valve': 'Click a pipe to snap a valve, or click the map to place it.',
        split: 'Click any position along a pipe to split it.',
        move: 'Select a feature, then drag it.',
        delete: 'Select a feature to delete it and clean its references.',
        reverse: 'Select a pipe to reverse its coordinate order.',
        trace: selectionMode === 'end' ? 'Select trace point B.' : 'Select trace point A.',
      };
      setStatus(messages[activeTool] || messages.select);
    }

    function featureGeometry(entry) {
      var feature = root.HydroFlowMap.featureOf(entry);
      return feature && feature.geometry ? JSON.parse(JSON.stringify(feature.geometry)) : null;
    }

    function selectEntry(entry) {
      selectedEntry = entry || null;
      selectionLayerGroup.clearLayers();
      if (!entry) return;
      var feature = root.HydroFlowMap.featureOf(entry);
      if (!feature || !feature.geometry) return;
      if (feature.geometry.type === 'Point') {
        L.circleMarker([feature.geometry.coordinates[1], feature.geometry.coordinates[0]], {
          radius: 13,
          color: '#ffd400',
          weight: 4,
          fillOpacity: 0,
          interactive: false,
        }).addTo(selectionLayerGroup);
      } else if (feature.geometry.type === 'LineString') {
        L.polyline(feature.geometry.coordinates.map(function (coordinate) { return [coordinate[1], coordinate[0]]; }), {
          color: '#ffd400',
          weight: 10,
          opacity: 0.65,
          interactive: false,
        }).addTo(selectionLayerGroup);
      }
    }

    function entryFromEvent(event) {
      var candidates = [event.propagatedFrom, event.sourceTarget, event.layer, event.target];
      for (var index = 0; index < candidates.length; index += 1) {
        var candidate = candidates[index];
        if (!candidate || candidate === map) continue;
        var entry = bridge.entryForLayer(candidate);
        if (entry && HYDRAULIC_CATEGORIES[entry.category]) return entry;
      }
      return null;
    }

    function eventCoordinate(event) {
      if (!event || !event.latlng) return null;
      return [Number(event.latlng.lng), Number(event.latlng.lat)];
    }

    function sameCoordinate(left, right) {
      return root.HydroFlowMap.sameCoordinate(left, right);
    }

    function redrawPipeDraft() {
      interactionLayerGroup.clearLayers();
      pipePreview = null;
      pipeDraft.forEach(function (coordinate) {
        L.circleMarker([coordinate[1], coordinate[0]], {
          radius: 4,
          color: '#fff',
          weight: 2,
          fillColor: '#007c91',
          fillOpacity: 1,
          interactive: false,
        }).addTo(interactionLayerGroup);
      });
      if (pipeDraft.length >= 2) {
        pipePreview = L.polyline(pipeDraft.map(function (coordinate) { return [coordinate[1], coordinate[0]]; }), {
          color: '#007c91',
          weight: 4,
          dashArray: '8,6',
          interactive: false,
        }).addTo(interactionLayerGroup);
      }
      finishPipeButton.disabled = pipeDraft.length < 2;
    }

    function addPipeVertex(coordinate) {
      if (!coordinate) return;
      if (pipeDraft.length && sameCoordinate(pipeDraft[pipeDraft.length - 1], coordinate)) return;
      pipeDraft.push(coordinate);
      redrawPipeDraft();
      setStatus(pipeDraft.length + ' pipe ' + (pipeDraft.length === 1 ? 'vertex' : 'vertices') + ' captured.');
    }

    function finishPipe() {
      if (pipeDraft.length < 2) {
        setStatus('A pipe requires at least two different vertices.', 'error');
        return;
      }
      try {
        var entry = network.addPipe(pipeDraft);
        clearPipeDraft();
        selectEntry(entry);
        bridge.openAttributes(entry);
        notify('Pipe ' + root.HydroFlowMap.featureId(entry, 'pipe') + ' added.', 'success');
      } catch (error) {
        setStatus(error.message, 'error');
      }
    }

    function addNodeAt(coordinate) {
      try {
        var before = network.entries('node').length;
        var entry = network.addNode(coordinate);
        selectEntry(entry);
        if (network.entries('node').length > before) bridge.openAttributes(entry);
        notify('Node ' + root.HydroFlowMap.featureId(entry, 'node') + ' ready.', 'success');
      } catch (error) { setStatus(error.message, 'error'); }
    }

    function addValveAt(coordinate, targetEntry) {
      try {
        var snap = targetEntry && targetEntry.category === 'pipe'
          ? network.nearestPointOnPipe(coordinate, targetEntry) : null;
        var entry = network.addValve(snap ? snap.coordinate : coordinate, {}, snap ? snap.entry : null);
        selectEntry(entry);
        bridge.openAttributes(entry);
        notify('Valve ' + root.HydroFlowMap.featureId(entry, 'valve') + ' added.', 'success');
      } catch (error) { setStatus(error.message, 'error'); }
    }

    function splitAt(coordinate, targetEntry) {
      try {
        var snap = targetEntry && targetEntry.category === 'pipe'
          ? network.nearestPointOnPipe(coordinate, targetEntry)
          : network.nearestPointOnPipes(coordinate);
        if (!snap) throw new Error('No pipe is available to split.');
        var result = network.splitPipe(snap.entry, snap);
        selectEntry(result.second);
        notify('Pipe split at ' + snap.distanceAlongKm.toFixed(3) + ' km.', 'success');
      } catch (error) { setStatus(error.message, 'error'); }
    }

    function deleteEntry(entry) {
      if (!entry) { setStatus('Select a pipe, node or valve to delete.', 'error'); return; }
      var id = root.HydroFlowMap.featureId(entry, entry.category);
      if (!root.confirm('Delete ' + entry.category + ' ' + (id || '') + '? Associated references will be cleaned.')) return;
      network.deleteEntry(entry);
      selectEntry(null);
      notify((entry.category.charAt(0).toUpperCase() + entry.category.slice(1)) + ' ' + id + ' deleted.', 'success');
    }

    function reverseEntry(entry) {
      if (!entry || entry.category !== 'pipe') {
        setStatus('Select a pipe to reverse.', 'error');
        return;
      }
      try {
        network.reversePipe(entry);
        selectEntry(entry);
        notify('Pipe ' + root.HydroFlowMap.featureId(entry, 'pipe') + ' direction reversed.', 'success');
      } catch (error) { setStatus(error.message, 'error'); }
    }

    function onMoveDragStart() {
      map.getContainer().style.cursor = 'grabbing';
      movingStartGeometry = featureGeometry(movingEntry);
    }

    function onMoveDragEnd() {
      if (!movingEntry || !movingStartGeometry) return;
      try {
        network.syncMovedEntry(movingEntry, movingStartGeometry);
        movingStartGeometry = featureGeometry(movingEntry);
        selectEntry(movingEntry);
        setStatus('Feature moved; connected pipe endpoints were synchronized.', 'success');
      } catch (error) {
        setStatus(error.message, 'error');
      }
      applyCursor();
    }

    function armMove(entry) {
      if (!entry) { setStatus('Select a pipe, node or valve to move.', 'error'); return; }
      disarmMove();
      movingEntry = entry;
      movingStartGeometry = featureGeometry(entry);
      selectEntry(entry);
      var layer = entry.layer;
      try {
        layer.on('pm:dragstart', onMoveDragStart);
        layer.on('pm:dragend', onMoveDragEnd);
        if (layer.pm && typeof layer.pm.enableLayerDrag === 'function') {
          layer.pm.enableLayerDrag();
        } else if (layer.dragging && layer.dragging.enable) {
          layer.on('dragstart', onMoveDragStart);
          layer.on('dragend', onMoveDragEnd);
          layer.dragging.enable();
        } else {
          throw new Error('Dragging is unavailable for this feature.');
        }
        setStatus('Drag the selected ' + entry.category + ' to its new position.');
      } catch (error) {
        disarmMove();
        setStatus(error.message, 'error');
      }
    }

    function clearTemporaryMarkers() {
      temporaryMarkers.forEach(function (marker) {
        try { map.removeLayer(marker); } catch (_) {}
      });
      temporaryMarkers = [];
    }

    function clearTraceResult() {
      analysisLayerGroup.clearLayers();
      lastTraceResult = null;
    }

    function updateTraceState() {
      traceAElement.textContent = startPoint
        ? 'A: ' + startPoint.pipeId + ' @ ' + startPoint.distanceAlongKm.toFixed(3) + ' km'
        : 'A: not set';
      traceBElement.textContent = endPoint
        ? 'B: ' + endPoint.pipeId + ' @ ' + endPoint.distanceAlongKm.toFixed(3) + ' km'
        : 'B: not set';
      runTraceButton.disabled = !(startPoint && endPoint);
    }

    function addTraceMarker(snap, label) {
      var marker = L.circleMarker([snap.coordinate[1], snap.coordinate[0]], {
        radius: 8,
        color: '#fff',
        weight: 3,
        fillColor: label === 'A' ? '#007c91' : '#c1001f',
        fillOpacity: 1,
        interactive: false,
      }).addTo(map);
      marker.bindTooltip(label, {
        permanent: true,
        direction: 'top',
        className: 'hydroflow-trace-label',
        offset: [0, -7],
      });
      temporaryMarkers.push(marker);
    }

    function resetTraceSelection(clearResult) {
      startPoint = null;
      endPoint = null;
      selectionMode = null;
      clearTemporaryMarkers();
      if (clearResult !== false) clearTraceResult();
      updateTraceState();
    }

    function beginTraceSelection() {
      resetTraceSelection(true);
      selectionMode = 'start';
      activateTool('trace');
      setStatus('Select trace point A on any pipe.');
    }

    function selectTracePoint(coordinate, targetEntry) {
      if (!selectionMode) {
        resetTraceSelection(true);
        selectionMode = 'start';
      }
      var snap = targetEntry && targetEntry.category === 'pipe'
        ? network.nearestPointOnPipe(coordinate, targetEntry)
        : network.nearestPointOnPipes(coordinate);
      if (!snap) { setStatus('No pipe is available for trace selection.', 'error'); return; }

      if (selectionMode === 'start') {
        clearTemporaryMarkers();
        clearTraceResult();
        startPoint = snap;
        endPoint = null;
        addTraceMarker(snap, 'A');
        selectionMode = 'end';
        setStatus('Point A selected. Select point B on any pipe.');
      } else {
        endPoint = snap;
        addTraceMarker(snap, 'B');
        selectionMode = null;
        setStatus('Point B selected. Run the trace.');
      }
      updateTraceState();
    }

    function traceDirection() {
      var checked = panel.querySelector('input[name="hydroflow-direction"]:checked');
      return checked ? checked.value : 'downstream';
    }

    function renderTrace(result) {
      analysisLayerGroup.clearLayers();
      var color = result.direction === 'upstream' ? '#d24a00' : '#00a36c';
      result.edges.forEach(function (edge) {
        L.polyline(edge.coordinates.map(function (coordinate) { return [coordinate[1], coordinate[0]]; }), {
          color: '#fff',
          weight: 10,
          opacity: 0.9,
          interactive: false,
        }).addTo(analysisLayerGroup);
        L.polyline(edge.coordinates.map(function (coordinate) { return [coordinate[1], coordinate[0]]; }), {
          color: color,
          weight: 6,
          opacity: 1,
          interactive: false,
        }).addTo(analysisLayerGroup);
      });
    }

    function runTrace() {
      if (!startPoint || !endPoint) {
        setStatus('Select both trace points A and B first.', 'error');
        return;
      }
      try {
        lastTraceResult = root.HydroFlowAnalysis.trace(network, {
          startPoint: startPoint,
          endPoint: endPoint,
          direction: traceDirection(),
          allowUnknownElevation: false,
        });
        renderTrace(lastTraceResult);
        var missingElevationBlocks = lastTraceResult.blocked.filter(function (item) {
          return item.reason === 'missing-elevation';
        }).length;
        var message = lastTraceResult.direction.charAt(0).toUpperCase() + lastTraceResult.direction.slice(1) +
          ' trace reached ' + lastTraceResult.pipeIds.length + ' pipe' + (lastTraceResult.pipeIds.length === 1 ? '' : 's') +
          ' across ' + lastTraceResult.edges.length + ' branch segment' + (lastTraceResult.edges.length === 1 ? '' : 's') + '. ' +
          'Point B was ' + (lastTraceResult.endReached ? 'reached.' : 'blocked.');
        if (missingElevationBlocks) message += ' ' + missingElevationBlocks + ' branch' +
          (missingElevationBlocks === 1 ? ' lacks' : 'es lack') + ' elevation.';
        selectionMode = 'start';
        setStatus(message, lastTraceResult.endReached ? 'success' : 'warning');
      } catch (error) {
        setStatus(error.message, 'error');
      }
    }

    function topologyIssueButton(item) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'hydroflow-issue';
      var id = document.createElement('strong');
      id.textContent = item.featureId;
      var message = document.createElement('span');
      message.textContent = item.message;
      button.appendChild(id);
      button.appendChild(message);
      button.addEventListener('click', function () {
        if (!item.entry) return;
        selectEntry(item.entry);
        bridge.focusEntry(item.entry);
      });
      return button;
    }

    function renderTopology() {
      topologyResults.innerHTML = '';
      if (!topologyReport) {
        topologyResults.innerHTML = '<div class="hydroflow-empty">Validation not run</div>';
        return;
      }
      var filtered = root.HydroFlowTopology.filterReport(topologyReport, topologySearch.value);
      if (topologyReport.valid) {
        var valid = document.createElement('div');
        valid.className = 'hydroflow-valid';
        valid.textContent = 'No topology errors found.';
        topologyResults.appendChild(valid);
        return;
      }
      if (!filtered.categories.length) {
        var empty = document.createElement('div');
        empty.className = 'hydroflow-empty';
        empty.textContent = 'No errors match this ID.';
        topologyResults.appendChild(empty);
        return;
      }
      filtered.categories.forEach(function (category, categoryIndex) {
        var details = document.createElement('details');
        details.className = 'hydroflow-error-category';
        details.open = categoryIndex === 0;
        var summary = document.createElement('summary');
        var name = document.createElement('span');
        name.textContent = category.name;
        var count = document.createElement('b');
        count.textContent = String(category.issues.length);
        summary.appendChild(name);
        summary.appendChild(count);
        details.appendChild(summary);
        var list = document.createElement('div');
        list.className = 'hydroflow-issue-list';
        category.issues.forEach(function (item) { list.appendChild(topologyIssueButton(item)); });
        details.appendChild(list);
        topologyResults.appendChild(details);
      });
    }

    function runTopology() {
      try {
        topologyReport = root.HydroFlowTopology.validate(network);
        renderTopology();
        setStatus(topologyReport.valid
          ? 'Topology valid: no errors found.'
          : topologyReport.count + ' topology error' + (topologyReport.count === 1 ? '' : 's') + ' found.',
        topologyReport.valid ? 'success' : 'warning');
      } catch (error) { setStatus(error.message, 'error'); }
    }

    function onMapClick(event) {
      if (!workspaceActive || destroyed) return;
      var coordinate = eventCoordinate(event);
      if (!coordinate) return;
      var entry = entryFromEvent(event);

      if (activeTool === 'add-pipe') { addPipeVertex(coordinate); return; }
      if (activeTool === 'add-node') { addNodeAt(coordinate); return; }
      if (activeTool === 'add-valve') { addValveAt(coordinate, entry); return; }
      if (activeTool === 'split') { splitAt(coordinate, entry); return; }
      if (activeTool === 'trace') { selectTracePoint(coordinate, entry); return; }

      if (!entry) {
        selectEntry(null);
        setStatus('No hydraulic feature selected.');
        return;
      }
      if (activeTool === 'delete') { deleteEntry(entry); return; }
      if (activeTool === 'reverse') { reverseEntry(entry); return; }
      if (activeTool === 'move') { armMove(entry); return; }
      selectEntry(entry);
      bridge.openAttributes(entry);
      setStatus(entry.category.charAt(0).toUpperCase() + entry.category.slice(1) + ' ' +
        root.HydroFlowMap.featureId(entry, entry.category) + ' selected.');
    }

    function onMapDoubleClick(event) {
      if (!workspaceActive || activeTool !== 'add-pipe') return;
      if (event.originalEvent) {
        event.originalEvent.preventDefault();
        event.originalEvent.stopPropagation();
      }
      finishPipe();
    }

    panel.querySelectorAll('[data-tool]').forEach(function (button) {
      button.addEventListener('click', function () { activateTool(button.dataset.tool); });
    });
    panel.querySelector('[data-action="finish-pipe"]').addEventListener('click', finishPipe);
    panel.querySelector('[data-action="cancel-pipe"]').addEventListener('click', function () {
      clearPipeDraft();
      activateTool('select');
    });
    panel.querySelector('[data-action="pick-trace"]').addEventListener('click', beginTraceSelection);
    panel.querySelector('[data-action="run-trace"]').addEventListener('click', runTrace);
    panel.querySelector('[data-action="clear-trace"]').addEventListener('click', function () {
      resetTraceSelection(true);
      activateTool('select');
      setStatus('Trace cleared.');
    });
    panel.querySelector('[data-action="validate"]').addEventListener('click', runTopology);
    topologySearch.addEventListener('input', renderTopology);
    panel.querySelector('[data-action="export-geojson"]').addEventListener('click', function () {
      var collection = network.exportGeoJSON('hydroflow-network.geojson');
      notify('Exported ' + collection.features.length + ' hydraulic features as GeoJSON.', 'success');
    });

    map.on('click', onMapClick);
    map.on('dblclick', onMapDoubleClick);
    var unsubscribeChange = bridge.onChange(function () {
      updateCounts();
      if (topologyReport) runTopology();
    });

    var controller = {
      network: network,
      get pipeLayerGroup() { return network.pipeLayerGroup; },
      get nodeLayerGroup() { return network.nodeLayerGroup; },
      get valveLayerGroup() { return network.valveLayerGroup; },
      get startPoint() { return startPoint; },
      get endPoint() { return endPoint; },
      get selectionMode() { return selectionMode; },
      get temporaryMarkers() { return temporaryMarkers.slice(); },
      get lastTraceResult() { return lastTraceResult; },
      setWorkspaceActive: function (active) {
        workspaceActive = !!active;
        host.classList.toggle('hydroflow-workspace-active', workspaceActive);
        if (!workspaceActive) {
          if (activeTool === 'add-pipe') clearPipeDraft();
          disarmMove();
          if (map.doubleClickZoom && doubleClickZoomWasEnabled) map.doubleClickZoom.enable();
        } else {
          disableGeomanModes();
        }
        applyCursor();
      },
      handlesFeatureClick: function (category) {
        return workspaceActive && !!HYDRAULIC_CATEGORIES[category];
      },
      activateTool: activateTool,
      validateTopology: runTopology,
      runTrace: runTrace,
      exportGeoJSON: function (filename) { return network.exportGeoJSON(filename); },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        map.off('click', onMapClick);
        map.off('dblclick', onMapDoubleClick);
        if (unsubscribeChange) unsubscribeChange();
        disarmMove();
        clearTemporaryMarkers();
        selectionLayerGroup.clearLayers();
        interactionLayerGroup.clearLayers();
        analysisLayerGroup.clearLayers();
        try { map.removeLayer(selectionLayerGroup); } catch (_) {}
        try { map.removeLayer(interactionLayerGroup); } catch (_) {}
        try { map.removeLayer(analysisLayerGroup); } catch (_) {}
        if (map.doubleClickZoom && doubleClickZoomWasEnabled) map.doubleClickZoom.enable();
        map.getContainer().style.cursor = '';
        host.classList.remove('hydroflow-workspace-active');
        panel._hydroFlowController = null;
        panel.innerHTML = '';
      },
    };

    panel._hydroFlowController = controller;
    updateCounts();
    updateTraceState();
    setToolButtonState();
    return controller;
  }

  root.HydroFlowEditor = { mount: mount };
})(typeof window !== 'undefined' ? window : globalThis);