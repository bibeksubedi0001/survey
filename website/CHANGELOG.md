# Changelog

## HydroFlow GIS network editor

- Fixed editor layer targeting so hydraulic tools mutate the persisted pipe, node, and valve GeoJSON layer groups.
- Added real pipe, node, and valve creation; connected endpoint movement; pipe splitting; direction reversal; reference-aware deletion; and dynamic tool cursors.
- Added Turf.js mid-pipe snapping for split and trace selections, including exact distance-along-pipe results.
- Added categorized topology validation with independent accordion sections and Node ID / Pipe ID search. Proximity and near-miss checks were removed.
- Added elevation-aware BFS traversal for complete downstream and upstream branch highlighting.
- Added repeatable two-point trace selection with graph-only temporary nodes and interpolated mid-pipe elevations.
- Added hydraulic network export as standards-compliant `.geojson` with the `application/geo+json` media type.
- Added offline caching for the HydroFlow modules and the pinned local Turf.js bundle.

## Verification

- `node tests/hydroflow.test.js`
- Desktop browser workflow at 1440 x 900
- Mobile browser workflow at 390 x 844
