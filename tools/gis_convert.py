"""
Convert all readable .gdb / .gpkg datasets under GIS Files/ into web-ready
GeoJSON, one folder per DMA under  data/dma/<id>/

Output files per DMA:
  boundary.geojson      one MultiPolygon (real boundary if present, else convex hull of connections)
  connections.geojson   service-connection points  (House_Connection_End)
  pipes.geojson         distribution lines         (Pipes, simplified)
  devices.geojson       valves + hydrants + flowmeters + loggers (combined with `kind` attr)

Plus  data/dma/index.json  manifest:
  { "dmas": [ { "id", "label", "bbox", "center", "counts", "layers": [...] }, ... ] }

All geometries are reprojected to EPSG:4326 (WGS84) and simplified.
Attributes are stripped to keep payload small.
"""
from __future__ import annotations
import os, re, json, math, sys
from pathlib import Path

import geopandas as gpd
import shapely
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

READ_KW = {'engine': 'pyogrio'}

def _force_2d_geom(g):
    if g is None or g.is_empty:
        return g
    try:
        return shapely.force_2d(g)
    except Exception:
        return g

ROOT = Path(__file__).resolve().parent.parent
GIS  = ROOT / 'GIS Files'
OUT  = ROOT / 'data' / 'dma'

# ----- helpers --------------------------------------------------------------

DMA_NAME_RE = re.compile(r'(?:DNI[_\- ]?|DMA[_\- ]?|DMA )(\d+(?:\.\d+)+)', re.IGNORECASE)

def dma_id_from(path: Path) -> str | None:
    """Pull a '1.2' / '3.1' / '9.2' DMA id out of any segment of the path."""
    for part in path.parts[::-1]:
        m = DMA_NAME_RE.search(part)
        if m:
            return m.group(1)
        # Handedover2.3.gpkg
        m = re.search(r'(?<!\d)(\d+\.\d+)(?!\d)', part)
        if m and 'gdb' not in part.lower() and 'GIS' not in part:
            return m.group(1)
    return None

LAYER_KINDS = {
    'boundary'  : re.compile(r'(sdma_boundary|dma_boundary)$', re.I),
    'connections': re.compile(r'house_connection_end$', re.I),
    'pipes'     : re.compile(r'(^|_)pipes$', re.I),
    'valve'     : re.compile(r'valves?$', re.I),
    'hydrant'   : re.compile(r'hydrants?$', re.I),
    'flowmeter' : re.compile(r'flowmeter$', re.I),
    'logger'    : re.compile(r'flow_pressure_logger$', re.I),
}

def classify(layer_name: str) -> str | None:
    for kind, rx in LAYER_KINDS.items():
        if rx.search(layer_name):
            return kind
    return None

def find_datasets(root: Path) -> list[Path]:
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dp = Path(dirpath)
        if dp.suffix.lower() == '.gdb':
            out.append(dp)
            dirnames[:] = []
            continue
        for f in filenames:
            if f.lower().endswith('.gpkg'):
                out.append(dp / f)
    return out

def simplify_to_4326(gdf: gpd.GeoDataFrame, tol_m: float) -> gpd.GeoDataFrame:
    """Simplify in the source CRS (meters) then reproject to EPSG:4326."""
    if gdf.empty:
        return gdf.to_crs(4326) if gdf.crs and gdf.crs.to_epsg() != 4326 else gdf
    # Drop Z if present (Leaflet ignores it but it inflates JSON)
    gdf = gdf.copy()
    gdf['geometry'] = gdf.geometry.map(_force_2d_geom)
    if tol_m > 0:
        gdf['geometry'] = gdf.geometry.simplify(tol_m, preserve_topology=True)
    return gdf.to_crs(4326)

def _drop_z(coords):
    if not coords:
        return coords
    if isinstance(coords[0], (int, float)):
        return list(coords[:2])
    return [_drop_z(c) for c in coords]

def strip_attrs(gdf: gpd.GeoDataFrame, keep: list[str] | None = None) -> gpd.GeoDataFrame:
    keep = keep or []
    cols = [c for c in gdf.columns if c == 'geometry' or c in keep]
    return gdf[cols].copy()

def round_coords(geom_obj, ndigits: int = 6):
    """Round all coordinate floats in a GeoJSON-like dict to ndigits."""
    if isinstance(geom_obj, dict):
        return {k: round_coords(v, ndigits) for k, v in geom_obj.items()}
    if isinstance(geom_obj, list):
        if geom_obj and isinstance(geom_obj[0], (int, float)):
            return [round(x, ndigits) for x in geom_obj]
        return [round_coords(x, ndigits) for x in geom_obj]
    return geom_obj

def write_geojson(gdf: gpd.GeoDataFrame, path: Path, ndigits: int = 6):
    path.parent.mkdir(parents=True, exist_ok=True)
    features = []
    for i, row in enumerate(gdf.itertuples(index=False)):
        g = row.geometry
        if g is None or g.is_empty:
            continue
        props = {f: getattr(row, f) for f in gdf.columns if f != 'geometry'}
        for k, v in list(props.items()):
            if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                props[k] = None
        feat = {
            'type': 'Feature',
            'properties': props,
            'geometry': round_coords(mapping(g), ndigits),
        }
        features.append(feat)
    fc = {'type': 'FeatureCollection', 'features': features}
    path.write_text(json.dumps(fc, separators=(',', ':')), encoding='utf-8')
    return len(features), path.stat().st_size

# ----- main -----------------------------------------------------------------

def main():
    datasets = find_datasets(GIS)
    print(f'Scanning {len(datasets)} dataset(s)...')

    # Group: dma_id -> {kind: list[(path, layer_name)]}
    grouped: dict[str, dict[str, list[tuple[Path, str]]]] = {}
    for ds in datasets:
        dma = dma_id_from(ds)
        if not dma:
            print(f'  skip (no DMA id): {ds.relative_to(GIS)}')
            continue
        try:
            import fiona
            layers = fiona.listlayers(str(ds))
        except Exception as e:
            print(f'  ERROR opening {ds}: {e}')
            continue
        for lyr in layers:
            kind = classify(lyr)
            if not kind:
                continue
            grouped.setdefault(dma, {}).setdefault(kind, []).append((ds, lyr))

    print(f'\nFound {len(grouped)} DMA(s): {sorted(grouped.keys())}\n')

    manifest_dmas = []
    OUT.mkdir(parents=True, exist_ok=True)

    for dma in sorted(grouped.keys(), key=lambda s: [int(x) for x in s.split('.')]):
        bucket = grouped[dma]
        out_dir = OUT / dma
        out_dir.mkdir(parents=True, exist_ok=True)
        counts: dict[str, int] = {}
        layers_avail: list[str] = []

        # --- connections ---
        if 'connections' in bucket:
            gdfs = []
            for ds, lyr in bucket['connections']:
                g = gpd.read_file(ds, layer=lyr, engine="pyogrio")
                g = strip_attrs(g, [])
                g = simplify_to_4326(g, tol_m=0)  # points don't need simplification
                gdfs.append(g)
            merged = gpd.GeoDataFrame(geopandas_concat(gdfs), crs='EPSG:4326')
            n, sz = write_geojson(merged, out_dir / 'connections.geojson')
            counts['connections'] = n
            layers_avail.append('connections')
            connections_gdf = merged
        else:
            connections_gdf = None

        # --- pipes ---
        if 'pipes' in bucket:
            gdfs = []
            for ds, lyr in bucket['pipes']:
                g = gpd.read_file(ds, layer=lyr, engine="pyogrio")
                g = strip_attrs(g, [])
                g = simplify_to_4326(g, tol_m=1.5)  # 1.5m
                gdfs.append(g)
            merged = gpd.GeoDataFrame(geopandas_concat(gdfs), crs='EPSG:4326')
            n, sz = write_geojson(merged, out_dir / 'pipes.geojson')
            counts['pipes'] = n
            layers_avail.append('pipes')

        # --- devices = valves + hydrants + flowmeters + loggers ---
        device_kinds = ['valve', 'hydrant', 'flowmeter', 'logger']
        if any(k in bucket for k in device_kinds):
            gdfs = []
            for k in device_kinds:
                for ds, lyr in bucket.get(k, []):
                    g = gpd.read_file(ds, layer=lyr, engine="pyogrio")
                    g = strip_attrs(g, [])
                    g['kind'] = k
                    gdfs.append(g)
            if gdfs:
                merged = gpd.GeoDataFrame(geopandas_concat(gdfs), crs=gdfs[0].crs)
                merged = simplify_to_4326(merged, tol_m=0)
                n, sz = write_geojson(merged, out_dir / 'devices.geojson')
                counts['devices'] = n
                layers_avail.append('devices')

        # --- boundary (real polygon if present, else convex hull of connections) ---
        boundary_gdf = None
        if 'boundary' in bucket:
            gdfs = []
            for ds, lyr in bucket['boundary']:
                g = gpd.read_file(ds, layer=lyr, engine="pyogrio")
                if not g.empty:
                    g = strip_attrs(g, [])
                    g = simplify_to_4326(g, tol_m=1.0)
                    gdfs.append(g)
            if gdfs:
                boundary_gdf = gpd.GeoDataFrame(geopandas_concat(gdfs), crs='EPSG:4326')
        if (boundary_gdf is None or boundary_gdf.empty) and connections_gdf is not None and not connections_gdf.empty:
            # Derive boundary from connection points using a numpy convex hull
            # (avoids a shapely/numpy collection-creation incompatibility).
            import numpy as np
            from shapely.geometry import Polygon
            cp_proj = connections_gdf.to_crs(32645)
            pts = np.array([(p.x, p.y) for p in cp_proj.geometry if p is not None and not p.is_empty])
            if len(pts) >= 3:
                try:
                    from scipy.spatial import ConvexHull
                    hull_idx = ConvexHull(pts).vertices
                    hull_poly = Polygon(pts[hull_idx]).buffer(40)  # 40 m pad
                except ImportError:
                    # Fallback: padded bounding box
                    xmin, ymin = pts.min(axis=0); xmax, ymax = pts.max(axis=0)
                    pad = 40
                    hull_poly = Polygon([
                        (xmin - pad, ymin - pad), (xmax + pad, ymin - pad),
                        (xmax + pad, ymax + pad), (xmin - pad, ymax + pad),
                    ])
                boundary_gdf = gpd.GeoDataFrame({'geometry': [hull_poly], 'derived': [True]}, crs=32645).to_crs(4326)
        if boundary_gdf is not None and not boundary_gdf.empty:
            n, sz = write_geojson(boundary_gdf, out_dir / 'boundary.geojson')
            counts['boundary'] = n
            layers_avail.append('boundary')

        # bbox + center — prefer connections (always cover the DMA), fallback to boundary
        bbox_src = connections_gdf if (connections_gdf is not None and not connections_gdf.empty) else boundary_gdf
        if bbox_src is not None and not bbox_src.empty:
            bx = bbox_src.total_bounds  # [minx,miny,maxx,maxy]
            bbox = [round(float(x), 6) for x in bx]
            center = [round((bx[1] + bx[3]) / 2, 6), round((bx[0] + bx[2]) / 2, 6)]
        else:
            bbox = None
            center = None

        manifest_dmas.append({
            'id': dma,
            'label': f'DMA {dma}',
            'bbox': bbox,
            'center': center,
            'counts': counts,
            'layers': layers_avail,
        })
        print(f'  DMA {dma}: {counts}')

    manifest = {
        'generated': __import__('datetime').datetime.utcnow().isoformat() + 'Z',
        'dmas': manifest_dmas,
    }
    (OUT / 'index.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print(f'\nWrote {OUT / "index.json"}')

def geopandas_concat(gdfs):
    import pandas as pd
    return pd.concat([g for g in gdfs if g is not None and not g.empty], ignore_index=True)

if __name__ == '__main__':
    main()
