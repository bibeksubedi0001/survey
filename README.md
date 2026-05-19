# KUKL Baneshwor — Site Survey System

A black-and-white, field-ready web app for capturing site survey data at KUKL Baneshwor.

## Features

- **GPS capture** — latitude, longitude, accuracy, altitude, heading, timestamp
- **Camera capture** — live capture (front/rear switch) with GPS + timestamp watermark stamped onto each photo
- **Photo upload** — also accepts existing images from device
- **Detailed survey form** — customer info, connection type, pipe material, meter, pressure, leakage, condition, priority, remarks, etc.
- **Local storage (IndexedDB)** — works offline; all data stays on your device
- **Records table** — view, edit, delete, search
- **Location map view** — quick Google Maps deep-links
- **Excel export** — one-click `.xlsx` export (SheetJS)
- **JSON backup/restore** — full backup including photos
- **Strict black & white UI** — print-friendly, high-contrast

## How to Run

This is a pure static site. No build step needed.

### Option 1 — Open directly

Just double-click `index.html`.

> Note: Some browsers restrict camera/GPS over `file://`. If that happens, use Option 2.

### Option 2 — Local server (recommended)

From the `Intern` folder:

```powershell
# Python (any version 3.x)
python -m http.server 8080
```

Then open: <http://localhost:8080>

### Option 3 — VS Code Live Server

Install the "Live Server" extension, right-click `index.html` → **Open with Live Server**.

For HTTPS-only browsers (required for camera/GPS on mobile), host the folder on GitHub Pages, Netlify, or any HTTPS static host.

## Files

| File         | Purpose                                      |
| ------------ | -------------------------------------------- |
| `index.html` | App structure & layout                       |
| `styles.css` | Black & white theme                          |
| `app.js`     | GPS, camera, IndexedDB storage, Excel export |
| `README.md`  | This file                                    |

## Usage Tips

1. Allow **Location** and **Camera** permissions when prompted.
2. Stand outdoors briefly so GPS accuracy improves (lower meters = better).
3. Capture multiple photos per site (front, meter, leak point, etc.).
4. **Export Excel often** — local data can be cleared by browser cache wipes.
5. Use **JSON Backup** for full, photo-inclusive backups between devices.

## Tech

- Vanilla HTML / CSS / JavaScript (no framework)
- IndexedDB for local persistence
- [SheetJS](https://sheetjs.com) (CDN) for Excel export
- Browser-native `getUserMedia` + `Geolocation` APIs
