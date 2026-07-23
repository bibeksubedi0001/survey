/* =============================================================
 * HydroFlow hydraulic graph analysis
 *
 * Builds an exact endpoint graph, virtually splits pipes at selected
 * mid-pipe positions, interpolates temporary-node elevations and runs
 * a complete BFS across every elevation-valid branch.
 * ============================================================ */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.HydroFlowAnalysis = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  var NODE_ELEVATION_KEYS = ['elevation', 'elevation_m', 'elev', 'altitude', 'z', 'head', 'ground_elevation'];
  var PIPE_START_ELEVATION_KEYS = ['from_elevation', 'start_elevation', 'elevation_start', 'upstream_elevation'];
  var PIPE_END_ELEVATION_KEYS = ['to_elevation', 'end_elevation', 'elevation_end', 'downstream_elevation'];

  function mapApi() {
    return root.HydroFlowMap || (typeof require === 'function' ? require('./map.js') : null);
  }

  function turfApi(options) {
    var turf = (options && options.turf) || root.turf;
    if (!turf && typeof require === 'function') {
      try { turf = require('../assets/vendor/turf.min.js'); } catch (_) {}
    }
    if (!turf) throw new Error('Turf.js is required for hydraulic graph analysis.');
    return turf;
  }

  function numericProperty(properties, keys) {
    for (var index = 0; index < keys.length; index += 1) {
      var value = properties && properties[keys[index]];
      if (value == null || value === '') continue;
      var number = Number(value);
      if (Number.isFinite(number)) return number;
    }
    return null;
  }

  function coordinateElevation(coordinate) {
    if (!Array.isArray(coordinate) || coordinate.length < 3) return null;
    var elevation = Number(coordinate[2]);
    return Number.isFinite(elevation) ? elevation : null;
  }

  function endpointElevation(entry, side, coordinate) {
    var api = mapApi();
    var properties = api.propertiesOf(entry);
    var value = numericProperty(properties, side === 'start' ? PIPE_START_ELEVATION_KEYS : PIPE_END_ELEVATION_KEYS);
    return value == null ? coordinateElevation(coordinate) : value;
  }

  function nodeElevation(entry) {
    var api = mapApi();
    var value = numericProperty(api.propertiesOf(entry), NODE_ELEVATION_KEYS);
    if (value != null) return value;
    return coordinateElevation(api.pointCoordinate(entry));
  }

  function interpolateElevation(startElevation, endElevation, ratio) {
    if (!Number.isFinite(startElevation) || !Number.isFinite(endElevation)) return null;
    return startElevation + (endElevation - startElevation) * Math.max(0, Math.min(1, ratio));
  }

  function uniqueId(base, store) {
    if (!store[base]) return base;
    var suffix = 2;
    while (store[base + '#' + suffix]) suffix += 1;
    return base + '#' + suffix;
  }

  function prepareSelection(network, selection, label) {
    if (!selection || !selection.coordinate) return null;
    var snap = null;
    if (selection.entry) snap = network.nearestPointOnPipe(selection.coordinate, selection.entry);
    if (!snap) snap = network.nearestPointOnPipes(selection.coordinate);
    if (!snap) return null;
    if (selection.distanceAlongKm != null && Number.isFinite(Number(selection.distanceAlongKm))) {
      snap.distanceAlongKm = Number(selection.distanceAlongKm);
    }
    snap.label = label;
    return snap;
  }

  function entryIdentity(entry) {
    return entry && (entry.layer || entry.feature || entry);
  }

  function createGraph(network, selections, options) {
    if (!network || typeof network.entries !== 'function') throw new Error('A HydroFlow network model is required.');
    var api = mapApi();
    if (!api) throw new Error('HydroFlowMap is required.');
    var turf = turfApi(options);
    var graph = {
      nodes: Object.create(null),
      edges: [],
      adjacency: Object.create(null),
      coordinateIndex: Object.create(null),
      selectionNodeIds: Object.create(null),
      warnings: [],
    };

    function addNode(id, coordinate, elevation, entry, temporary) {
      var nodeId = uniqueId(id, graph.nodes);
      var node = {
        id: nodeId,
        coordinate: api.copyCoordinate(coordinate),
        elevation: Number.isFinite(elevation) ? elevation : null,
        entry: entry || null,
        temporary: !!temporary,
      };
      graph.nodes[nodeId] = node;
      graph.adjacency[nodeId] = [];
      var key = api.coordinateKey(coordinate);
      if (key && !graph.coordinateIndex[key]) graph.coordinateIndex[key] = nodeId;
      return node;
    }

    network.entries('node').forEach(function (entry, index) {
      var coordinate = api.pointCoordinate(entry);
      if (!coordinate) return;
      var id = api.featureId(entry, 'node');
      var key = api.coordinateKey(coordinate);
      if (graph.coordinateIndex[key]) {
        var existing = graph.nodes[graph.coordinateIndex[key]];
        if (existing.elevation == null) existing.elevation = nodeElevation(entry);
        return;
      }
      addNode('node:' + (id || key || index), coordinate, nodeElevation(entry), entry, false);
    });

    var preparedSelections = [];
    (selections || []).forEach(function (selection, index) {
      var prepared = prepareSelection(network, selection, selection.label || (index === 0 ? 'start' : 'end'));
      if (prepared) preparedSelections.push(prepared);
    });

    var pipeCuts = new Map();
    preparedSelections.forEach(function (selection) {
      var key = entryIdentity(selection.entry);
      var cuts = pipeCuts.get(key);
      if (!cuts) { cuts = []; pipeCuts.set(key, cuts); }
      cuts.push(selection);
    });

    function endpointNode(entry, coordinate, side, pipeIndex) {
      var key = api.coordinateKey(coordinate);
      var existingId = graph.coordinateIndex[key];
      var elevation = endpointElevation(entry, side, coordinate);
      if (existingId) {
        var existing = graph.nodes[existingId];
        if (existing.elevation == null && elevation != null) existing.elevation = elevation;
        return existing;
      }
      return addNode('coordinate:' + (key || pipeIndex + ':' + side), coordinate, elevation, null, false);
    }

    function addEdge(edge) {
      graph.edges.push(edge);
      graph.adjacency[edge.from].push({ edge: edge, neighbor: edge.to });
      graph.adjacency[edge.to].push({ edge: edge, neighbor: edge.from });
    }

    network.entries('pipe').forEach(function (entry, pipeIndex) {
      var feature = api.featureOf(entry);
      var coordinates = api.lineCoordinates(entry);
      if (!feature || !coordinates || coordinates.length < 2) return;
      var line = turf.lineString(coordinates);
      var totalLength = turf.length(line, { units: 'kilometers' });
      if (!Number.isFinite(totalLength) || totalLength <= 0) return;
      var pipeId = api.featureId(entry, 'pipe') || 'Pipe ' + (pipeIndex + 1);
      var startNode = endpointNode(entry, coordinates[0], 'start', pipeIndex);
      var endNode = endpointNode(entry, coordinates[coordinates.length - 1], 'end', pipeIndex);
      var startElevation = startNode.elevation;
      var endElevation = endNode.elevation;
      var guard = Math.max(totalLength * 1e-10, 1e-12);
      var cuts = (pipeCuts.get(entryIdentity(entry)) || []).slice().sort(function (left, right) {
        return left.distanceAlongKm - right.distanceAlongKm;
      });
      var positions = [{ location: 0, node: startNode, labels: [] }];

      cuts.forEach(function (cut) {
        var location = Math.max(0, Math.min(totalLength, Number(cut.distanceAlongKm) || 0));
        if (location <= guard) {
          graph.selectionNodeIds[cut.label] = startNode.id;
          return;
        }
        if (location >= totalLength - guard) {
          graph.selectionNodeIds[cut.label] = endNode.id;
          return;
        }
        var previous = positions[positions.length - 1];
        if (Math.abs(previous.location - location) <= guard) {
          previous.labels.push(cut.label);
          graph.selectionNodeIds[cut.label] = previous.node.id;
          return;
        }
        var elevation = interpolateElevation(startElevation, endElevation, location / totalLength);
        var temporaryNode = addNode(
          'temporary:' + pipeIndex + ':' + location.toFixed(12),
          cut.coordinate,
          elevation,
          null,
          true
        );
        positions.push({ location: location, node: temporaryNode, labels: [cut.label] });
        graph.selectionNodeIds[cut.label] = temporaryNode.id;
      });
      positions.push({ location: totalLength, node: endNode, labels: [] });

      positions.forEach(function (position) {
        position.labels.forEach(function (label) { graph.selectionNodeIds[label] = position.node.id; });
      });

      for (var segmentIndex = 0; segmentIndex < positions.length - 1; segmentIndex += 1) {
        var fromPosition = positions[segmentIndex];
        var toPosition = positions[segmentIndex + 1];
        if (toPosition.location - fromPosition.location <= guard) continue;
        var segment = turf.lineSliceAlong(line, fromPosition.location, toPosition.location, { units: 'kilometers' });
        var segmentCoordinates = segment.geometry.coordinates;
        segmentCoordinates[0] = api.copyCoordinate(fromPosition.node.coordinate);
        segmentCoordinates[segmentCoordinates.length - 1] = api.copyCoordinate(toPosition.node.coordinate);
        addEdge({
          id: 'pipe:' + pipeIndex + ':segment:' + segmentIndex,
          pipeId: pipeId,
          pipeEntry: entry,
          from: fromPosition.node.id,
          to: toPosition.node.id,
          coordinates: segmentCoordinates,
          lengthKm: toPosition.location - fromPosition.location,
          segmentIndex: segmentIndex,
        });
      }
    });

    preparedSelections.forEach(function (selection) {
      if (!graph.selectionNodeIds[selection.label]) {
        graph.warnings.push('Could not place the ' + selection.label + ' selection in the analysis graph.');
      }
    });
    return graph;
  }

  function elevationAllows(current, neighbor, direction, allowUnknownElevation) {
    if (direction === 'connected') return true;
    if (!Number.isFinite(current.elevation) || !Number.isFinite(neighbor.elevation)) {
      return !!allowUnknownElevation;
    }
    if (direction === 'upstream') return neighbor.elevation >= current.elevation;
    return neighbor.elevation <= current.elevation;
  }

  function traverse(graph, options) {
    options = options || {};
    var direction = options.direction || 'downstream';
    if (['downstream', 'upstream', 'connected'].indexOf(direction) === -1) {
      throw new Error('Trace direction must be downstream, upstream or connected.');
    }
    var startNodeId = options.startNodeId || graph.selectionNodeIds.start;
    var endNodeId = options.endNodeId || graph.selectionNodeIds.end || null;
    if (!startNodeId || !graph.nodes[startNodeId]) throw new Error('Select a valid trace start point.');

    var queue = [startNodeId];
    var visitedNodes = Object.create(null);
    var visitedEdges = Object.create(null);
    var attemptedDirections = Object.create(null);
    var traversedNodes = [];
    var traversedEdges = [];
    var blocked = [];
    visitedNodes[startNodeId] = true;

    while (queue.length) {
      var currentId = queue.shift();
      var currentNode = graph.nodes[currentId];
      traversedNodes.push(currentNode);
      (graph.adjacency[currentId] || []).forEach(function (connection) {
        var attemptKey = currentId + '>' + connection.edge.id;
        if (attemptedDirections[attemptKey]) return;
        attemptedDirections[attemptKey] = true;
        var neighbor = graph.nodes[connection.neighbor];
        if (!elevationAllows(currentNode, neighbor, direction, options.allowUnknownElevation)) {
          blocked.push({
            edge: connection.edge,
            from: currentNode,
            to: neighbor,
            reason: (!Number.isFinite(currentNode.elevation) || !Number.isFinite(neighbor.elevation))
              ? 'missing-elevation' : 'elevation-direction',
          });
          return;
        }
        if (!visitedEdges[connection.edge.id]) {
          visitedEdges[connection.edge.id] = true;
          traversedEdges.push(connection.edge);
        }
        if (!visitedNodes[neighbor.id]) {
          visitedNodes[neighbor.id] = true;
          queue.push(neighbor.id);
        }
      });
    }

    var pipeEntries = [];
    var pipeIds = [];
    var seenEntries = new Set();
    traversedEdges.forEach(function (edge) {
      if (!seenEntries.has(edge.pipeEntry)) {
        seenEntries.add(edge.pipeEntry);
        pipeEntries.push(edge.pipeEntry);
        pipeIds.push(edge.pipeId);
      }
    });

    return {
      direction: direction,
      startNodeId: startNodeId,
      endNodeId: endNodeId,
      endReached: endNodeId ? !!visitedNodes[endNodeId] : null,
      nodes: traversedNodes,
      edges: traversedEdges,
      pipeEntries: pipeEntries,
      pipeIds: pipeIds,
      blocked: blocked,
      graph: graph,
    };
  }

  function trace(network, options) {
    options = options || {};
    var selections = [];
    if (options.startPoint) selections.push(Object.assign({}, options.startPoint, { label: 'start' }));
    if (options.endPoint) selections.push(Object.assign({}, options.endPoint, { label: 'end' }));
    var graph = createGraph(network, selections, options);
    return traverse(graph, {
      direction: options.direction,
      allowUnknownElevation: options.allowUnknownElevation,
      startNodeId: graph.selectionNodeIds.start,
      endNodeId: graph.selectionNodeIds.end,
    });
  }

  return {
    createGraph: createGraph,
    traverse: traverse,
    trace: trace,
    interpolateElevation: interpolateElevation,
    elevationAllows: elevationAllows,
    numericProperty: numericProperty,
    nodeElevation: nodeElevation,
  };
});