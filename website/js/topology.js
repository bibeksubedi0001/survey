/* =============================================================
 * HydroFlow topology validation
 *
 * Validation uses exact coordinate identity and explicit references only.
 * ============================================================ */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.HydroFlowTopology = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  function mapApi() {
    return root.HydroFlowMap || (typeof require === 'function' ? require('./map.js') : null);
  }

  function validCoordinate(coordinate) {
    return Array.isArray(coordinate) && coordinate.length >= 2 &&
      Number.isFinite(Number(coordinate[0])) && Number.isFinite(Number(coordinate[1]));
  }

  function validPointFeature(feature) {
    return !!(feature && feature.geometry && feature.geometry.type === 'Point' &&
      validCoordinate(feature.geometry.coordinates));
  }

  function validLineFeature(feature) {
    if (!feature || !feature.geometry || feature.geometry.type !== 'LineString') return false;
    var coordinates = feature.geometry.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2 || !coordinates.every(validCoordinate)) return false;
    var first = coordinates[0];
    return coordinates.some(function (coordinate) {
      return Number(coordinate[0]) !== Number(first[0]) || Number(coordinate[1]) !== Number(first[1]);
    });
  }

  function issue(category, code, featureType, featureId, message, entry) {
    return {
      category: category,
      code: code,
      featureType: featureType,
      featureId: featureId || 'Unidentified ' + featureType,
      message: message,
      entry: entry || null,
    };
  }

  function pushCategory(categories, category, item) {
    if (!categories[category]) categories[category] = [];
    categories[category].push(item);
  }

  function endpointKeys(entry, api) {
    var coordinates = api.lineCoordinates(entry);
    if (!coordinates || coordinates.length < 2) return null;
    return [api.coordinateKey(coordinates[0]), api.coordinateKey(coordinates[coordinates.length - 1])];
  }

  function connectedComponents(validPipes, api) {
    var endpointIndex = Object.create(null);
    validPipes.forEach(function (entry, pipeIndex) {
      var keys = endpointKeys(entry, api);
      keys.forEach(function (key) {
        if (!endpointIndex[key]) endpointIndex[key] = [];
        endpointIndex[key].push(pipeIndex);
      });
    });

    var adjacency = validPipes.map(function () { return []; });
    Object.keys(endpointIndex).forEach(function (key) {
      var indexes = endpointIndex[key];
      for (var left = 0; left < indexes.length; left += 1) {
        for (var right = left + 1; right < indexes.length; right += 1) {
          adjacency[indexes[left]].push(indexes[right]);
          adjacency[indexes[right]].push(indexes[left]);
        }
      }
    });

    var visited = Object.create(null);
    var components = [];
    validPipes.forEach(function (_entry, startIndex) {
      if (visited[startIndex]) return;
      var queue = [startIndex];
      var component = [];
      visited[startIndex] = true;
      while (queue.length) {
        var current = queue.shift();
        component.push(current);
        adjacency[current].forEach(function (neighbor) {
          if (visited[neighbor]) return;
          visited[neighbor] = true;
          queue.push(neighbor);
        });
      }
      components.push(component);
    });
    components.sort(function (left, right) { return right.length - left.length; });
    return components;
  }

  function validate(network) {
    if (!network || typeof network.entries !== 'function') throw new Error('A HydroFlow network model is required.');
    var api = mapApi();
    if (!api) throw new Error('HydroFlowMap is required.');

    var categories = Object.create(null);
    var pipes = network.entries('pipe');
    var nodes = network.entries('node');
    var valves = network.entries('valve');
    var validPipes = [];
    var nodeById = Object.create(null);
    var nodeByCoordinate = Object.create(null);
    var duplicateTracker = { pipe: Object.create(null), node: Object.create(null), valve: Object.create(null) };

    function trackId(entry, featureType) {
      var id = api.featureId(entry, featureType);
      if (!id) {
        pushCategory(categories, 'Missing IDs', issue('Missing IDs', 'missing-id', featureType, '',
          'This ' + featureType + ' has no ' + featureType + ' ID.', entry));
        return '';
      }
      var key = id.toUpperCase();
      if (duplicateTracker[featureType][key]) {
        pushCategory(categories, 'Duplicate IDs', issue('Duplicate IDs', 'duplicate-id', featureType, id,
          featureType.charAt(0).toUpperCase() + featureType.slice(1) + ' ID ' + id + ' is duplicated.', entry));
        var first = duplicateTracker[featureType][key];
        if (!first.reported) {
          pushCategory(categories, 'Duplicate IDs', issue('Duplicate IDs', 'duplicate-id', featureType, id,
            featureType.charAt(0).toUpperCase() + featureType.slice(1) + ' ID ' + id + ' is duplicated.', first.entry));
          first.reported = true;
        }
      } else {
        duplicateTracker[featureType][key] = { entry: entry, reported: false };
      }
      return id;
    }

    nodes.forEach(function (entry) {
      var id = trackId(entry, 'node');
      var feature = api.featureOf(entry);
      if (!validPointFeature(feature)) {
        pushCategory(categories, 'Invalid Geometry', issue('Invalid Geometry', 'invalid-point', 'node', id,
          'Node ' + (id || '(no ID)') + ' must be a valid Point geometry.', entry));
        return;
      }
      if (id) nodeById[id.toUpperCase()] = entry;
      var key = api.coordinateKey(feature.geometry.coordinates);
      if (!nodeByCoordinate[key]) nodeByCoordinate[key] = [];
      nodeByCoordinate[key].push(entry);
    });

    valves.forEach(function (entry) {
      var id = trackId(entry, 'valve');
      if (!validPointFeature(api.featureOf(entry))) {
        pushCategory(categories, 'Invalid Geometry', issue('Invalid Geometry', 'invalid-point', 'valve', id,
          'Valve ' + (id || '(no ID)') + ' must be a valid Point geometry.', entry));
      }
    });

    pipes.forEach(function (entry) {
      var id = trackId(entry, 'pipe');
      var feature = api.featureOf(entry);
      if (!validLineFeature(feature)) {
        pushCategory(categories, 'Invalid Geometry', issue('Invalid Geometry', 'invalid-line', 'pipe', id,
          'Pipe ' + (id || '(no ID)') + ' must be a non-zero LineString with at least two valid coordinates.', entry));
        return;
      }
      validPipes.push(entry);
    });

    var nodeDegree = new Map();
    nodes.forEach(function (entry) { nodeDegree.set(entry, 0); });

    validPipes.forEach(function (entry) {
      var id = api.featureId(entry, 'pipe');
      var properties = api.propertiesOf(entry);
      var coordinates = api.lineCoordinates(entry);
      var endpointData = [
        { side: 'start', coordinate: coordinates[0] },
        { side: 'end', coordinate: coordinates[coordinates.length - 1] },
      ];
      endpointData.forEach(function (endpoint) {
        var reference = api.readNodeReference(properties, endpoint.side);
        var referencedNode = reference ? nodeById[reference.toUpperCase()] : null;
        var coordinateNodes = nodeByCoordinate[api.coordinateKey(endpoint.coordinate)] || [];
        var node = referencedNode || coordinateNodes[0] || null;
        if (!node) {
          pushCategory(categories, 'Missing Endpoint Nodes', issue('Missing Endpoint Nodes', 'missing-endpoint-node', 'pipe', id,
            'Pipe ' + id + ' ' + endpoint.side + ' endpoint has no node at the exact same coordinate.', entry));
          return;
        }
        if (referencedNode && api.coordinateKey(api.pointCoordinate(referencedNode)) !== api.coordinateKey(endpoint.coordinate)) {
          pushCategory(categories, 'Reference Mismatch', issue('Reference Mismatch', 'node-coordinate-mismatch', 'pipe', id,
            'Pipe ' + id + ' references node ' + reference + ' at a different coordinate.', entry));
        }
        nodeDegree.set(node, (nodeDegree.get(node) || 0) + 1);
      });
    });

    nodes.forEach(function (entry) {
      if (!validPointFeature(api.featureOf(entry))) return;
      var degree = nodeDegree.get(entry) || 0;
      if (degree <= 1) {
        var id = api.featureId(entry, 'node');
        pushCategory(categories, 'Dangling Nodes', issue('Dangling Nodes', 'dangling-node', 'node', id,
          'Node ' + id + ' has ' + degree + ' connected pipe' + (degree === 1 ? '' : 's') + '.', entry));
      }
    });

    connectedComponents(validPipes, api).forEach(function (component, componentIndex) {
      if (componentIndex === 0) return;
      component.forEach(function (pipeIndex) {
        var entry = validPipes[pipeIndex];
        var id = api.featureId(entry, 'pipe');
        pushCategory(categories, 'Disconnected Network', issue('Disconnected Network', 'disconnected-pipe', 'pipe', id,
          'Pipe ' + id + ' is outside the largest connected network component.', entry));
      });
    });

    var order = [
      'Invalid Geometry',
      'Missing IDs',
      'Duplicate IDs',
      'Missing Endpoint Nodes',
      'Reference Mismatch',
      'Dangling Nodes',
      'Disconnected Network',
    ];
    var categoryList = order.filter(function (name) { return categories[name] && categories[name].length; })
      .map(function (name) { return { name: name, issues: categories[name] }; });
    var issues = [];
    categoryList.forEach(function (category) { issues = issues.concat(category.issues); });

    return {
      valid: issues.length === 0,
      count: issues.length,
      categories: categoryList,
      issues: issues,
      summary: {
        pipes: pipes.length,
        nodes: nodes.length,
        valves: valves.length,
        connectedComponents: connectedComponents(validPipes, api).length,
      },
    };
  }

  function filterReport(report, searchText) {
    var query = String(searchText || '').trim().toLowerCase();
    if (!query) return report;
    var categories = report.categories.map(function (category) {
      return {
        name: category.name,
        issues: category.issues.filter(function (item) {
          return String(item.featureId || '').toLowerCase().indexOf(query) !== -1 ||
            String(item.message || '').toLowerCase().indexOf(query) !== -1;
        }),
      };
    }).filter(function (category) { return category.issues.length; });
    var issues = [];
    categories.forEach(function (category) { issues = issues.concat(category.issues); });
    return {
      valid: report.valid,
      count: issues.length,
      categories: categories,
      issues: issues,
      summary: report.summary,
      sourceCount: report.count,
    };
  }

  return {
    validate: validate,
    filterReport: filterReport,
    validCoordinate: validCoordinate,
    validLineFeature: validLineFeature,
    validPointFeature: validPointFeature,
  };
});