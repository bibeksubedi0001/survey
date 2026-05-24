/* KUKL Geo Utilities
   ------------------------------------------------------------------
   window.KUKLGeo
     .detectDma(lat, lng)              → Promise<{ id, label } | null>
     .snapToNearestPipe(lat, lng, opts)→ Promise<{ lat, lng, dist, pipe } | null>
         opts = { dmaId, maxMeters = 30 }
     .meters(latA, lngA, latB, lngB)   → number  (equirectangular metres)

   Caches GeoJSON HTTP responses in memory.
   ------------------------------------------------------------------ */
(function () {
  'use strict';
  if (window.KUKLGeo) return;

  const DATA_BASE = './data/dma/';
  const INDEX_URL = DATA_BASE + 'index.json';
  const _cache = Object.create(null);
  let _indexPromise = null;

  function loadIndex() {
    if (!_indexPromise) {
      _indexPromise = fetch(INDEX_URL)
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .catch(e => { _indexPromise = null; throw e; });
    }
    return _indexPromise;
  }
  function loadLayer(dmaId, layer) {
    const key = dmaId + '/' + layer;
    if (_cache[key]) return Promise.resolve(_cache[key]);
    return fetch(DATA_BASE + key + '.geojson')
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(gj => (_cache[key] = gj));
  }

  // ---------- Geometry helpers ----------
  function bboxContains(bbox, lng, lat) {
    return lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
  }
  // Ray-cast point-in-polygon for a single ring (array of [lng,lat])
  function pointInRing(lng, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      const intersect = ((yi > lat) !== (yj > lat)) &&
        (lng < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }
  function pointInPolygon(lng, lat, poly) {
    // poly = Array<ring>; first ring outer, rest holes
    if (!poly || !poly.length) return false;
    if (!pointInRing(lng, lat, poly[0])) return false;
    for (let i = 1; i < poly.length; i++) if (pointInRing(lng, lat, poly[i])) return false;
    return true;
  }
  function pointInFeature(lng, lat, feat) {
    const g = feat && feat.geometry;
    if (!g) return false;
    if (g.type === 'Polygon')      return pointInPolygon(lng, lat, g.coordinates);
    if (g.type === 'MultiPolygon') return g.coordinates.some(p => pointInPolygon(lng, lat, p));
    return false;
  }

  function meters(latA, lngA, latB, lngB) {
    const R = 6371008.8;
    const φ1 = latA * Math.PI / 180, φ2 = latB * Math.PI / 180;
    const dφ = (latB - latA) * Math.PI / 180;
    const dλ = (lngB - lngA) * Math.PI / 180;
    const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  /* Project [lng,lat] to local metres around an origin (small-area planar OK
     for distances of a few km). Returns [x,y] metres. */
  function toLocalMeters(originLat) {
    const mLat = 111320;
    const mLng = 111320 * Math.cos(originLat * Math.PI / 180);
    return (lng, lat) => [lng * mLng, lat * mLat];
  }
  function fromLocalMeters(originLat) {
    const mLat = 111320;
    const mLng = 111320 * Math.cos(originLat * Math.PI / 180);
    return (x, y) => [x / mLng, y / mLat];
  }
  // Closest point on segment (ax,ay)-(bx,by) to (px,py) in 2D
  function nearestOnSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const x = ax + t * dx, y = ay + t * dy;
    const ex = px - x, ey = py - y;
    return { x, y, dist: Math.sqrt(ex * ex + ey * ey) };
  }

  // ---------- Public: detect DMA from a GPS point ----------
  async function detectDma(lat, lng) {
    if (!isFinite(lat) || !isFinite(lng)) return null;
    let idx;
    try { idx = await loadIndex(); } catch (e) { console.warn('[KUKLGeo] index load failed', e); return null; }
    const dmas = (idx && idx.dmas) || [];
    // Quick bbox prefilter
    const candidates = dmas.filter(d => Array.isArray(d.bbox) && bboxContains(d.bbox, lng, lat));
    for (const d of candidates) {
      try {
        const gj = await loadLayer(d.id, 'boundary');
        const feats = (gj && gj.features) || [];
        for (const f of feats) {
          if (pointInFeature(lng, lat, f)) return { id: d.id, label: d.label || ('DMA ' + d.id) };
        }
      } catch (e) { /* skip missing */ }
    }
    return null;
  }

  // ---------- Public: snap to nearest pipe ----------
  async function snapToNearestPipe(lat, lng, opts) {
    opts = opts || {};
    const maxMeters = opts.maxMeters != null ? opts.maxMeters : 30;
    let dmaId = opts.dmaId;
    if (!dmaId) {
      const d = await detectDma(lat, lng);
      if (d) dmaId = d.id;
    }
    if (!dmaId) return null;
    let pipes;
    try { pipes = await loadLayer(dmaId, 'pipes'); }
    catch (e) { console.warn('[KUKLGeo] pipes load failed for', dmaId, e); return null; }
    const feats = (pipes && pipes.features) || [];
    if (!feats.length) return null;

    const toM   = toLocalMeters(lat);
    const fromM = fromLocalMeters(lat);
    const [px, py] = toM(lng, lat);

    let best = null;  // { dist, x, y, pipe }
    for (const f of feats) {
      const g = f.geometry;
      if (!g) continue;
      const lines = g.type === 'LineString'      ? [g.coordinates]
                 : g.type === 'MultiLineString' ? g.coordinates
                 : null;
      if (!lines) continue;
      for (const line of lines) {
        for (let i = 1; i < line.length; i++) {
          const [alng, alat] = line[i - 1];
          const [blng, blat] = line[i];
          const [ax, ay] = toM(alng, alat);
          const [bx, by] = toM(blng, blat);
          const n = nearestOnSegment(px, py, ax, ay, bx, by);
          if (!best || n.dist < best.dist) best = { dist: n.dist, x: n.x, y: n.y, pipe: f };
        }
      }
    }
    if (!best || best.dist > maxMeters) return null;
    const [slng, slat] = fromM(best.x, best.y);
    return { lat: slat, lng: slng, dist: best.dist, pipe: best.pipe };
  }

  window.KUKLGeo = { detectDma, snapToNearestPipe, meters };
})();
