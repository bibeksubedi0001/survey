"""
Walk GIS Files/, list every .gdb folder / .gpkg / shapefile dataset
along with its layers, feature counts, geometry types, CRS, and bbox.
Prints a compact summary so we can decide how to convert.
"""
import os, sys, json
import fiona

ROOT = os.path.join(os.path.dirname(__file__), '..', 'GIS Files')
ROOT = os.path.abspath(ROOT)

def find_datasets(root):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        # Treat any folder ending in .gdb as a dataset (don't descend further)
        if dirpath.lower().endswith('.gdb'):
            out.append(dirpath)
            dirnames[:] = []
            continue
        for f in filenames:
            low = f.lower()
            if low.endswith('.gpkg'):
                out.append(os.path.join(dirpath, f))
            elif low.endswith('.shp'):
                out.append(os.path.join(dirpath, f))
    return out

def describe(path):
    try:
        layers = fiona.listlayers(path)
    except Exception as e:
        return {'path': path, 'error': str(e)}
    info = {'path': path, 'layers': []}
    for lyr in layers:
        try:
            with fiona.open(path, layer=lyr) as src:
                gtype = src.schema.get('geometry')
                crs = src.crs.get('init') if isinstance(src.crs, dict) and 'init' in src.crs else (
                    src.crs_wkt[:80] + '...' if src.crs_wkt else 'unknown')
                try:
                    count = len(src)
                except TypeError:
                    count = sum(1 for _ in src)
                bbox = None
                try:
                    bbox = src.bounds  # (minx, miny, maxx, maxy)
                except Exception:
                    pass
                info['layers'].append({
                    'name': lyr, 'count': count, 'geom': gtype,
                    'crs': crs, 'bbox': bbox,
                })
        except Exception as e:
            info['layers'].append({'name': lyr, 'error': str(e)})
    return info

def main():
    datasets = find_datasets(ROOT)
    print(f'Found {len(datasets)} dataset(s) under {ROOT}\n')
    summary = []
    for ds in datasets:
        d = describe(ds)
        summary.append(d)
        rel = os.path.relpath(ds, ROOT)
        if 'error' in d:
            print(f'!! {rel}\n   ERROR: {d["error"]}')
            continue
        print(f'== {rel}')
        for lyr in d['layers']:
            if 'error' in lyr:
                print(f'   - {lyr["name"]}  (error: {lyr["error"]})')
            else:
                bb = lyr['bbox']
                bbstr = f"[{bb[0]:.4f},{bb[1]:.4f}..{bb[2]:.4f},{bb[3]:.4f}]" if bb else '?'
                print(f'   - {lyr["name"]:<40}  n={lyr["count"]:<6} geom={lyr["geom"]:<14} crs={str(lyr["crs"])[:30]:<30} bbox={bbstr}')
        print()
    out_path = os.path.join(os.path.dirname(__file__), 'gis_inventory.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(summary, f, indent=2, default=str)
    print(f'\nWrote {out_path}')

if __name__ == '__main__':
    main()
