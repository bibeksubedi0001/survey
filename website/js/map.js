/* =============================================================
 * HydroFlow network model
 *
 * Owns hydraulic GeoJSON mutations while delegating rendering and
 * persistence to the existing KUKLGis layer bridge.
 * ============================================================ */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.HydroFlowMap = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  var ID_SPEC = {
    pipe: { key: 'pipe_id', prefix: 'P' },
    node: { key: 'node_id', prefix: 'N' },
    valve: { key: 'valve_id', prefix: 'V' },
  };
  var NODE_REF_PAIRS = [
    ['from_node', 'to_node'],
    ['start_node', 'end_node'],
    ['fromNode', 'toNode'],
    ['startNodeId', 'endNodeId'],
  ];
  var ELEVATION_PAIRS = [
    ['from_elevation', 'to_elevation'],
    ['start_elevation', 'end_elevation'],
    ['elevation_start', 'elevation_end'],
  ];
  var NODE_ELEVATION_KEYS = ['elevation', 'elevation_m', 'elev', 'altitude', 'z', 'head', 'ground_elevation'];
  var PIPE_REF_KEYS = ['pipe_id', 'pipeId', 'pipe_ref'];

  function clone(value) {
    if (value == null) return value;
    return JSON.parse(JSON.stringify(value));
  }

  function finiteCoordinate(coordinate) {
    return Array.isArray(coordinate) && coordinate.length >= 2 &&
      Number.isFinite(Number(coordinate[0])) && Number.isFinite(Number(coordinate[1]));
  }

  function copyCoordinate(coordinate) {
    if (!finiteCoordinate(coordinate)) return null;
    var lng = Number(coordinate[0]);
    var lat = Number(coordinate[1]);
    var result = [Object.is(lng, -0) ? 0 : lng, Object.is(lat, -0) ? 0 : lat];
    if (coordinate.length > 2 && Number.isFinite(Number(coordinate[2]))) result.push(Number(coordinate[2]));
    return result;
  }

  function sameCoordinate(left, right) {
    return finiteCoordinate(left) && finiteCoordinate(right) &&
      Number(left[0]) === Number(right[0]) && Number(left[1]) === Number(right[1]);
  }

  function coordinateKey(coordinate) {
    if (!finiteCoordinate(coordinate)) return '';
    var lng = Object.is(Number(coordinate[0]), -0) ? 0 : Number(coordinate[0]);
    var lat = Object.is(Number(coordinate[1]), -0) ? 0 : Number(coordinate[1]);
    return String(lng) + ',' + String(lat);
  }

  function featureOf(entry) {
    if (!entry) return null;
    if (entry.layer && typeof entry.layer.toGeoJSON === 'function') return entry.layer.toGeoJSON();
    return entry.feature || null;
  }

  function propertiesOf(entry) {
    if (!entry) return {};
    if (entry.layer && entry.layer.feature) {
      entry.layer.feature.properties = entry.layer.feature.properties || {};
      return entry.layer.feature.properties;
    }
    if (entry.feature) {
      entry.feature.properties = entry.feature.properties || {};
      return entry.feature.properties;
    }
    return {};
  }

  function featureId(entry, category) {
    var properties = propertiesOf(entry);
    var spec = ID_SPEC[category] || {};
    return String(properties[spec.key] || properties.id || (entry && entry.feature && entry.feature.id) || '').trim();
  }

  function lineCoordinates(entry) {
    var feature = featureOf(entry);
    if (!feature || !feature.geometry || feature.geometry.type !== 'LineString') return null;
    return clone(feature.geometry.coordinates || []);
  }

  function pointCoordinate(entry) {
    var feature = featureOf(entry);
    if (!feature || !feature.geometry || feature.geometry.type !== 'Point') return null;
    return copyCoordinate(feature.geometry.coordinates);
  }

  function readPipeReference(properties) {
    for (var index = 0; index < PIPE_REF_KEYS.length; index += 1) {
      var value = properties[PIPE_REF_KEYS[index]];
      if (value != null && String(value).trim()) return String(value).trim();
    }
    return '';
  }

  function writePipeReference(properties, pipeId) {
    var wroteExisting = false;
    PIPE_REF_KEYS.forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        properties[key] = pipeId || '';
        wroteExisting = true;
      }
    });
    if (!wroteExisting) properties.pipe_id = pipeId || '';
  }

  function readNodeReference(properties, side) {
    for (var index = 0; index < NODE_REF_PAIRS.length; index += 1) {
      var key = NODE_REF_PAIRS[index][side === 'start' ? 0 : 1];
      var value = properties[key];
      if (value != null && String(value).trim()) return String(value).trim();
    }
    return '';
  }

  function writeNodeReference(properties, side, nodeId) {
    var pairIndex = side === 'start' ? 0 : 1;
    var wroteExisting = false;
    NODE_REF_PAIRS.forEach(function (pair) {
      if (Object.prototype.hasOwnProperty.call(properties, pair[pairIndex])) {
        properties[pair[pairIndex]] = nodeId || '';
        wroteExisting = true;
      }
    });
    if (!wroteExisting) properties[side === 'start' ? 'from_node' : 'to_node'] = nodeId || '';
  }

  function swapPairs(properties, pairs) {
    pairs.forEach(function (pair) {
      if (!Object.prototype.hasOwnProperty.call(properties, pair[0]) &&
          !Object.prototype.hasOwnProperty.call(properties, pair[1])) return;
      var first = properties[pair[0]];
      properties[pair[0]] = properties[pair[1]];
      properties[pair[1]] = first;
    });
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

  function nodeElevation(entry) {
    if (!entry) return null;
    var elevation = numericProperty(propertiesOf(entry), NODE_ELEVATION_KEYS);
    if (elevation != null) return elevation;
    var coordinate = pointCoordinate(entry);
    return coordinate && coordinate.length > 2 && Number.isFinite(Number(coordinate[2])) ? Number(coordinate[2]) : null;
  }

  function pipeEndpointElevation(properties, side, coordinate) {
    var keys = side === 'start'
      ? ['from_elevation', 'start_elevation', 'elevation_start', 'upstream_elevation']
      : ['to_elevation', 'end_elevation', 'elevation_end', 'downstream_elevation'];
    var elevation = numericProperty(properties, keys);
    if (elevation != null) return elevation;
    return coordinate && coordinate.length > 2 && Number.isFinite(Number(coordinate[2])) ? Number(coordinate[2]) : null;
  }

  function requireTurf() {
    var turf = root.turf;
    if (!turf && typeof require === 'function') {
      try { turf = require('../assets/vendor/turf.min.js'); } catch (_) {}
    }
    if (!turf) throw new Error('Turf.js is required for hydraulic snapping and tracing.');
    return turf;
  }

  function updatePipeLength(properties, coordinates) {
    try {
      var turf = requireTurf();
      var kilometers = turf.length(turf.lineString(coordinates), { units: 'kilometers' });
      if (Number.isFinite(kilometers)) properties.length_m = Math.round(kilometers * 100000) / 100;
    } catch (_) {}
  }

  function NetworkModel(bridge) {
    if (!bridge || typeof bridge.getEntries !== 'function' || typeof bridge.addFeature !== 'function') {
      throw new Error('HydroFlow requires a KUKLGis network bridge.');
    }
    this.bridge = bridge;
  }

  NetworkModel.prototype.entries = function (category) {
    return this.bridge.getEntries(category) || [];
  };

  NetworkModel.prototype.getLayerGroup = function (category) {
    return this.bridge.getLayerGroup(category, true);
  };

  Object.defineProperties(NetworkModel.prototype, {
    pipeLayerGroup: { get: function () { return this.getLayerGroup('pipe'); } },
    nodeLayerGroup: { get: function () { return this.getLayerGroup('node'); } },
    valveLayerGroup: { get: function () { return this.getLayerGroup('valve'); } },
  });

  NetworkModel.prototype.nextId = function (category) {
    var spec = ID_SPEC[category];
    if (!spec) throw new Error('Unsupported hydraulic feature category: ' + category);
    var maximum = 0;
    var used = Object.create(null);
    this.entries(category).forEach(function (entry) {
      var id = featureId(entry, category);
      if (!id) return;
      used[id.toUpperCase()] = true;
      var match = id.match(/(\d+)\s*$/);
      if (match) maximum = Math.max(maximum, parseInt(match[1], 10));
    });
    var candidate;
    do {
      maximum += 1;
      candidate = spec.prefix + '-' + ('000' + maximum).slice(-3);
    } while (used[candidate.toUpperCase()]);
    return candidate;
  };

  NetworkModel.prototype.findById = function (category, id) {
    var wanted = String(id || '').trim().toUpperCase();
    if (!wanted) return null;
    var entries = this.entries(category);
    for (var index = 0; index < entries.length; index += 1) {
      if (featureId(entries[index], category).toUpperCase() === wanted) return entries[index];
    }
    return null;
  };

  NetworkModel.prototype.findNodeAt = function (coordinate) {
    var entries = this.entries('node');
    for (var index = 0; index < entries.length; index += 1) {
      if (sameCoordinate(pointCoordinate(entries[index]), coordinate)) return entries[index];
    }
    return null;
  };

  NetworkModel.prototype.addNode = function (coordinate, properties) {
    var cleanCoordinate = copyCoordinate(coordinate);
    if (!cleanCoordinate) throw new Error('A node requires a valid [longitude, latitude] coordinate.');
    var existing = this.findNodeAt(cleanCoordinate);
    if (existing) {
      var existingProperties = propertiesOf(existing);
      Object.keys(properties || {}).forEach(function (key) {
        if (existingProperties[key] == null || existingProperties[key] === '') existingProperties[key] = properties[key];
      });
      this.bridge.commit(['node']);
      return existing;
    }
    var nextProperties = clone(properties || {});
    if (!nextProperties.node_id) nextProperties.node_id = this.nextId('node');
    if (!nextProperties.node_type) nextProperties.node_type = 'Junction';
    return this.bridge.addFeature('node', {
      type: 'Feature',
      properties: nextProperties,
      geometry: { type: 'Point', coordinates: cleanCoordinate },
    });
  };

  NetworkModel.prototype.addPipe = function (coordinates, properties) {
    var cleanCoordinates = (coordinates || []).map(copyCoordinate).filter(Boolean);
    if (cleanCoordinates.length < 2) throw new Error('A pipe requires at least two valid vertices.');
    if (cleanCoordinates.every(function (coordinate) { return sameCoordinate(coordinate, cleanCoordinates[0]); })) {
      throw new Error('A pipe must have two different endpoints.');
    }

    var startNode = this.addNode(cleanCoordinates[0]);
    var endNode = this.addNode(cleanCoordinates[cleanCoordinates.length - 1]);
    var nextProperties = clone(properties || {});
    if (!nextProperties.pipe_id) nextProperties.pipe_id = this.nextId('pipe');
    if (!nextProperties.status) nextProperties.status = 'In Service';
    writeNodeReference(nextProperties, 'start', featureId(startNode, 'node'));
    writeNodeReference(nextProperties, 'end', featureId(endNode, 'node'));
    updatePipeLength(nextProperties, cleanCoordinates);

    var entry = this.bridge.addFeature('pipe', {
      type: 'Feature',
      properties: nextProperties,
      geometry: { type: 'LineString', coordinates: cleanCoordinates },
    });
    this.bridge.commit(['pipe', 'node']);
    return entry;
  };

  NetworkModel.prototype.addValve = function (coordinate, properties, pipeEntry) {
    var cleanCoordinate = copyCoordinate(coordinate);
    if (!cleanCoordinate) throw new Error('A valve requires a valid [longitude, latitude] coordinate.');
    var nextProperties = clone(properties || {});
    if (!nextProperties.valve_id) nextProperties.valve_id = this.nextId('valve');
    if (!nextProperties.valve_type) nextProperties.valve_type = 'Gate';
    if (!nextProperties.status) nextProperties.status = 'Unknown';
    if (pipeEntry) writePipeReference(nextProperties, featureId(pipeEntry, 'pipe'));
    return this.bridge.addFeature('valve', {
      type: 'Feature',
      properties: nextProperties,
      geometry: { type: 'Point', coordinates: cleanCoordinate },
    });
  };

  NetworkModel.prototype.nearestPointOnPipes = function (coordinate, pipeEntries) {
    var turf = requireTurf();
    var target = copyCoordinate(coordinate);
    if (!target) return null;
    var point = turf.point(target);
    var best = null;
    (pipeEntries || this.entries('pipe')).forEach(function (entry) {
      var line = featureOf(entry);
      if (!line || !line.geometry || line.geometry.type !== 'LineString' ||
          !Array.isArray(line.geometry.coordinates) || line.geometry.coordinates.length < 2) return;
      var snapped;
      try { snapped = turf.nearestPointOnLine(line, point, { units: 'kilometers' }); } catch (_) { return; }
      var snappedProperties = snapped.properties || {};
      var distance = Number(snappedProperties.dist);
      if (!Number.isFinite(distance)) distance = turf.distance(point, snapped, { units: 'kilometers' });
      if (!best || distance < best.distanceToLineKm) {
        best = {
          entry: entry,
          pipeId: featureId(entry, 'pipe'),
          coordinate: copyCoordinate(snapped.geometry.coordinates),
          distanceToLineKm: distance,
          distanceAlongKm: Number(snappedProperties.location) || 0,
          segmentIndex: Number.isFinite(Number(snappedProperties.index)) ? Number(snappedProperties.index) : 0,
        };
      }
    });
    return best;
  };

  NetworkModel.prototype.nearestPointOnPipe = function (coordinate, pipeEntry) {
    return this.nearestPointOnPipes(coordinate, pipeEntry ? [pipeEntry] : []);
  };

  NetworkModel.prototype.splitPipe = function (pipeEntry, snappedPoint) {
    var turf = requireTurf();
    var line = featureOf(pipeEntry);
    if (!line || !line.geometry || line.geometry.type !== 'LineString') throw new Error('Select a LineString pipe to split.');
    var snap = snappedPoint && snappedPoint.coordinate ? snappedPoint : this.nearestPointOnPipe(snappedPoint, pipeEntry);
    if (!snap || !finiteCoordinate(snap.coordinate)) throw new Error('The split point could not be snapped to the pipe.');

    var totalLength = turf.length(line, { units: 'kilometers' });
    var location = Number(snap.distanceAlongKm);
    if (!Number.isFinite(location)) {
      location = Number(turf.nearestPointOnLine(line, turf.point(snap.coordinate), { units: 'kilometers' }).properties.location) || 0;
    }
    var endpointGuard = Math.max(totalLength * 1e-10, 1e-12);
    if (location <= endpointGuard || location >= totalLength - endpointGuard) {
      throw new Error('Choose an interior point; the selected position is already a pipe endpoint.');
    }

    var firstLine = turf.lineSliceAlong(line, 0, location, { units: 'kilometers' });
    var secondLine = turf.lineSliceAlong(line, location, totalLength, { units: 'kilometers' });
    var splitCoordinate = copyCoordinate(snap.coordinate);
    firstLine.geometry.coordinates[firstLine.geometry.coordinates.length - 1] = clone(splitCoordinate);
    secondLine.geometry.coordinates[0] = clone(splitCoordinate);

    var originalProperties = clone(propertiesOf(pipeEntry));
    var originalPipeId = featureId(pipeEntry, 'pipe') || this.nextId('pipe');
    originalProperties.pipe_id = originalPipeId;
    var originalStartNode = readNodeReference(originalProperties, 'start');
    var originalEndNode = readNodeReference(originalProperties, 'end');
    var startNodeEntry = originalStartNode && this.findById('node', originalStartNode);
    var endNodeEntry = originalEndNode && this.findById('node', originalEndNode);
    var startElevation = nodeElevation(startNodeEntry);
    var endElevation = nodeElevation(endNodeEntry);
    if (startElevation == null) startElevation = pipeEndpointElevation(originalProperties, 'start', line.geometry.coordinates[0]);
    if (endElevation == null) endElevation = pipeEndpointElevation(originalProperties, 'end', line.geometry.coordinates[line.geometry.coordinates.length - 1]);
    var splitProperties = {};
    if (Number.isFinite(startElevation) && Number.isFinite(endElevation)) {
      splitProperties.elevation = startElevation + (endElevation - startElevation) * (location / totalLength);
    }
    var splitNode = this.addNode(splitCoordinate, splitProperties);
    var splitNodeId = featureId(splitNode, 'node');

    var firstProperties = clone(originalProperties);
    var secondProperties = clone(originalProperties);
    writeNodeReference(firstProperties, 'end', splitNodeId);
    writeNodeReference(secondProperties, 'start', splitNodeId);
    writeNodeReference(secondProperties, 'end', originalEndNode);
    secondProperties.parent_pipe_id = originalPipeId;
    secondProperties.pipe_id = this.nextId('pipe');
    updatePipeLength(firstProperties, firstLine.geometry.coordinates);
    updatePipeLength(secondProperties, secondLine.geometry.coordinates);

    // Capture downstream valve membership against the original geometry before
    // the first half replaces it in the live Leaflet layer.
    var downstreamValves = [];
    this.entries('valve').forEach(function (valveEntry) {
      var valveProperties = propertiesOf(valveEntry);
      if (readPipeReference(valveProperties) !== originalPipeId) return;
      try {
        var valveSnap = turf.nearestPointOnLine(line, turf.point(pointCoordinate(valveEntry)), { units: 'kilometers' });
        if ((Number(valveSnap.properties && valveSnap.properties.location) || 0) > location) downstreamValves.push(valveEntry);
      } catch (_) {}
    });

    if (pipeEntry.layer && pipeEntry.layer.feature) pipeEntry.layer.feature.properties = firstProperties;
    else pipeEntry.feature.properties = firstProperties;
    this.bridge.setCoordinates(pipeEntry, firstLine.geometry.coordinates);
    var secondEntry = this.bridge.addFeature('pipe', {
      type: 'Feature',
      properties: secondProperties,
      geometry: { type: 'LineString', coordinates: secondLine.geometry.coordinates },
    });

    var secondPipeId = featureId(secondEntry, 'pipe');
    downstreamValves.forEach(function (valveEntry) {
      writePipeReference(propertiesOf(valveEntry), secondPipeId);
    });
    this.bridge.commit(['pipe', 'node', 'valve']);
    return { first: pipeEntry, second: secondEntry, node: splitNode, coordinate: splitCoordinate };
  };

  NetworkModel.prototype.reversePipe = function (pipeEntry) {
    var coordinates = lineCoordinates(pipeEntry);
    if (!coordinates || coordinates.length < 2) throw new Error('Select a valid LineString pipe to reverse.');
    coordinates.reverse();
    var properties = propertiesOf(pipeEntry);
    swapPairs(properties, NODE_REF_PAIRS);
    swapPairs(properties, ELEVATION_PAIRS);
    updatePipeLength(properties, coordinates);
    this.bridge.setCoordinates(pipeEntry, coordinates);
    this.bridge.commit(['pipe']);
    return pipeEntry;
  };

  NetworkModel.prototype.deleteEntry = function (entry) {
    if (!entry || !entry.category) return false;
    var category = entry.category;
    var deletedId = featureId(entry, category);
    var changed = Object.create(null);

    if (category === 'pipe' && deletedId) {
      this.entries('valve').forEach(function (valveEntry) {
        var valveProperties = propertiesOf(valveEntry);
        if (readPipeReference(valveProperties) === deletedId) {
          writePipeReference(valveProperties, '');
          changed.valve = true;
        }
      });
      this.entries('node').forEach(function (nodeEntry) {
        var nodeProperties = propertiesOf(nodeEntry);
        if (!Array.isArray(nodeProperties.connected_pipes)) return;
        var filtered = nodeProperties.connected_pipes.filter(function (pipeId) { return String(pipeId) !== deletedId; });
        if (filtered.length !== nodeProperties.connected_pipes.length) {
          nodeProperties.connected_pipes = filtered;
          changed.node = true;
        }
      });
    }

    if (category === 'node' && deletedId) {
      this.entries('pipe').forEach(function (pipeEntry) {
        var pipeProperties = propertiesOf(pipeEntry);
        var touched = false;
        NODE_REF_PAIRS.forEach(function (pair) {
          pair.forEach(function (key) {
            if (String(pipeProperties[key] || '') === deletedId) {
              pipeProperties[key] = '';
              touched = true;
            }
          });
        });
        if (touched) changed.pipe = true;
      });
    }

    this.bridge.removeFeature(entry);
    changed[category] = true;
    this.bridge.commit(Object.keys(changed));
    return true;
  };

  NetworkModel.prototype.moveNode = function (nodeEntry, newCoordinate, oldCoordinate) {
    var nextCoordinate = copyCoordinate(newCoordinate);
    var previousCoordinate = copyCoordinate(oldCoordinate) || pointCoordinate(nodeEntry);
    if (!nextCoordinate || !previousCoordinate) throw new Error('A moved node requires valid old and new coordinates.');
    var nodeId = featureId(nodeEntry, 'node');
    this.bridge.setCoordinates(nodeEntry, nextCoordinate);

    var self = this;
    this.entries('pipe').forEach(function (pipeEntry) {
      var coordinates = lineCoordinates(pipeEntry);
      if (!coordinates || coordinates.length < 2) return;
      var properties = propertiesOf(pipeEntry);
      var startConnected = sameCoordinate(coordinates[0], previousCoordinate) ||
        (nodeId && readNodeReference(properties, 'start') === nodeId);
      var endConnected = sameCoordinate(coordinates[coordinates.length - 1], previousCoordinate) ||
        (nodeId && readNodeReference(properties, 'end') === nodeId);
      if (!startConnected && !endConnected) return;
      if (startConnected) coordinates[0] = clone(nextCoordinate);
      if (endConnected) coordinates[coordinates.length - 1] = clone(nextCoordinate);
      updatePipeLength(properties, coordinates);
      self.bridge.setCoordinates(pipeEntry, coordinates);
    });

    this.entries('valve').forEach(function (valveEntry) {
      var valveProperties = propertiesOf(valveEntry);
      if (sameCoordinate(pointCoordinate(valveEntry), previousCoordinate) ||
          (nodeId && String(valveProperties.node_id || '') === nodeId)) {
        self.bridge.setCoordinates(valveEntry, nextCoordinate);
      }
    });
    this.bridge.commit(['node', 'pipe', 'valve']);
    return nodeEntry;
  };

  NetworkModel.prototype.moveValve = function (valveEntry, newCoordinate, snapToPipe) {
    var nextCoordinate = copyCoordinate(newCoordinate);
    if (!nextCoordinate) throw new Error('A moved valve requires a valid coordinate.');
    var properties = propertiesOf(valveEntry);
    this.bridge.setCoordinates(valveEntry, nextCoordinate);
    if (snapToPipe) {
      var snap = this.nearestPointOnPipes(nextCoordinate);
      if (snap) {
        this.bridge.setCoordinates(valveEntry, snap.coordinate);
        writePipeReference(properties, snap.pipeId);
      }
    }
    this.bridge.commit(['valve']);
    return valveEntry;
  };

  NetworkModel.prototype.movePipe = function (pipeEntry, newCoordinates, oldCoordinates) {
    var nextCoordinates = clone(newCoordinates || lineCoordinates(pipeEntry));
    var previousCoordinates = clone(oldCoordinates || []);
    if (!nextCoordinates || nextCoordinates.length < 2 || previousCoordinates.length < 2) {
      throw new Error('A moved pipe requires its previous and current LineString coordinates.');
    }
    var properties = propertiesOf(pipeEntry);
    var startId = readNodeReference(properties, 'start');
    var endId = readNodeReference(properties, 'end');
    var startNode = (startId && this.findById('node', startId)) || this.findNodeAt(previousCoordinates[0]);
    var endNode = (endId && this.findById('node', endId)) || this.findNodeAt(previousCoordinates[previousCoordinates.length - 1]);

    updatePipeLength(properties, nextCoordinates);
    this.bridge.setCoordinates(pipeEntry, nextCoordinates);
    if (startNode) this.moveNode(startNode, nextCoordinates[0], previousCoordinates[0]);
    if (endNode && endNode !== startNode) {
      this.moveNode(endNode, nextCoordinates[nextCoordinates.length - 1], previousCoordinates[previousCoordinates.length - 1]);
    }
    this.bridge.commit(['pipe', 'node', 'valve']);
    return pipeEntry;
  };

  NetworkModel.prototype.syncMovedEntry = function (entry, previousGeometry) {
    if (!entry) return null;
    var feature = featureOf(entry);
    if (entry.category === 'node') return this.moveNode(entry, feature.geometry.coordinates, previousGeometry.coordinates);
    if (entry.category === 'valve') return this.moveValve(entry, feature.geometry.coordinates, true);
    if (entry.category === 'pipe') return this.movePipe(entry, feature.geometry.coordinates, previousGeometry.coordinates);
    return null;
  };

  NetworkModel.prototype.toFeatureCollection = function (category) {
    var features = this.entries(category).map(function (entry) {
      var feature = clone(featureOf(entry));
      if (!feature) return null;
      feature.properties = feature.properties || {};
      feature.properties._category = category === 'pipe' ? 'Pipe' : (category === 'node' ? 'Node' : 'Valve');
      return feature;
    }).filter(Boolean);
    return { type: 'FeatureCollection', features: features };
  };

  NetworkModel.prototype.snapshot = function () {
    return {
      pipes: this.toFeatureCollection('pipe'),
      nodes: this.toFeatureCollection('node'),
      valves: this.toFeatureCollection('valve'),
    };
  };

  NetworkModel.prototype.exportGeoJSON = function (filename) {
    var snapshot = this.snapshot();
    var features = snapshot.nodes.features.concat(snapshot.pipes.features, snapshot.valves.features);
    var collection = {
      type: 'FeatureCollection',
      name: 'HydroFlow hydraulic network',
      features: features,
    };
    var name = String(filename || 'hydroflow-network.geojson');
    if (!/\.geojson$/i.test(name)) name += '.geojson';
    this.bridge.download(name, JSON.stringify(collection, null, 2), 'application/geo+json');
    return collection;
  };

  return {
    create: function (bridge) { return new NetworkModel(bridge); },
    NetworkModel: NetworkModel,
    coordinateKey: coordinateKey,
    sameCoordinate: sameCoordinate,
    finiteCoordinate: finiteCoordinate,
    copyCoordinate: copyCoordinate,
    featureId: featureId,
    featureOf: featureOf,
    propertiesOf: propertiesOf,
    lineCoordinates: lineCoordinates,
    pointCoordinate: pointCoordinate,
    readNodeReference: readNodeReference,
    readPipeReference: readPipeReference,
  };
});