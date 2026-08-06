# Changelog

## Toilet Construction — Final Site Survey section

- Added a new **Toilet Survey** section (nav tab + Home hub card) for the final on-site survey that confirms a household site for toilet construction.
- Schema-driven site-measurement form organised into: beneficiary & location, household context, plot & available space, ground & terrain, building setting-out, leach-pit & disposal, water/rainwater/power, access & material logistics, and site confirmation — capturing full on-site dimensions (setbacks, level difference, excavation depth, pit spacing/clearances, pipe runs, carriage distance, etc.), with high-accuracy GPS, stamped photo capture, offline IndexedDB storage, Excel/JSON/PDF export, records table and location map (markers coloured by confirmation status).
- Added a **DESIGN** reference view to the section's SURVEY / DESIGN / REPORT / MAP switcher: the single finalized toilet design (issued construction drawing, Fig. 4.1 — stone masonry, RCC roof, SATO pan, wet twin leach-pit — with its design-basis specifications and setting-out targets) and Bhadaure (Dhading) site maps (slope, contour, drainage), all tap-to-enlarge.

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
