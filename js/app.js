/* ============================================================
   KUKL Baneshwor — Site Survey System
   Vanilla JS: GPS + Camera + IndexedDB + Excel Export
   ============================================================ */

'use strict';

// ---------- Utilities ----------
const $ = (id) => document.getElementById(id);
const toast = (msg, ms = 2200) => {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
};
const pad = (n) => String(n).padStart(2, '0');
const fmtDateTime = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const genSurveyId = () => {
  const d = new Date();
  const r = Math.floor(Math.random() * 9000 + 1000);
  return `KUKL-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${r}`;
};

// ---------- State ----------
const state = {
  gps: null,            // {lat,lng,acc,alt,hdg,time}
  photos: [],           // [{id, dataUrl, time}]
  stream: null,
  facing: 'environment',
  editingId: null,
};

// ---------- IndexedDB ----------
const DB_NAME = 'kukl_survey_db';
const DB_VER = 1;
const STORE = 'surveys';
let dbPromise;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function dbAll() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}
async function dbPut(rec) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(rec);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function dbDel(id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function dbClear() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function dbGet(id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

// ---------- Tabs ----------
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'records') renderRecords();
    if (btn.dataset.tab === 'map') renderMap();
  });
});

// ---------- Clock + Online status ----------
function tickClock() {
  const d = new Date();
  $('clock').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
setInterval(tickClock, 1000); tickClock();

function updateOnline() {
  const el = $('onlineStatus');
  if (navigator.onLine) { el.textContent = '● ONLINE'; el.classList.remove('offline'); }
  else { el.textContent = '● OFFLINE'; el.classList.add('offline'); }
}
window.addEventListener('online', updateOnline);
window.addEventListener('offline', updateOnline);
updateOnline();

// ---------- GPS (multi-sample fusion — weighted average for ≤ 2 m precision) ----------
const TARGET_ACC = 2;          // meters — desired final fused accuracy
const MIN_GOOD_SAMPLES = 3;    // need this many samples ≤ TARGET_ACC*1.5 before lock
const MAX_WAIT_MS = 120000;    // 120s cap
const MAX_SAMPLES_KEPT = 60;   // ring buffer

let gpsWatchId = null;
let gpsSamples = [];           // [{lat,lng,acc,alt,hdg,t}]
let gpsBestAcc = Infinity;
let gpsStartTs = 0;
let gpsTickTimer = null;

function setGpsBtn(label, busy) {
  const b = $('btnGetLocation');
  b.textContent = label;
  b.classList.toggle('btn-danger', !!busy);
  b.classList.toggle('btn-primary', !busy);
}

// Weighted-average of the BEST samples (weight = 1/acc²).
// Only uses samples whose accuracy is within 2× of the best sample → ignores outliers.
function fuseSamples(samples) {
  if (!samples.length) return null;
  const best = Math.min(...samples.map(s => s.acc));
  const keep = samples.filter(s => s.acc <= best * 2 && isFinite(s.acc) && s.acc > 0);
  let sw = 0, slat = 0, slng = 0, salt = 0, saltW = 0, shdg = 0, shdgW = 0;
  for (const s of keep) {
    const w = 1 / (s.acc * s.acc);
    sw += w;
    slat += s.lat * w;
    slng += s.lng * w;
    if (s.alt != null && !isNaN(s.alt)) { salt += s.alt * w; saltW += w; }
    if (s.hdg != null && !isNaN(s.hdg)) { shdg += s.hdg * w; shdgW += w; }
  }
  // Fused theoretical accuracy ≈ 1/sqrt(sum of weights)
  const fusedAcc = 1 / Math.sqrt(sw);
  return {
    lat: slat / sw,
    lng: slng / sw,
    acc: Math.max(fusedAcc, best * 0.6),   // don't claim better than 60% of best raw fix
    alt: saltW > 0 ? salt / saltW : null,
    hdg: shdgW > 0 ? shdg / shdgW : null,
    samples: keep.length,
    rawBest: best,
    time: new Date().toISOString(),
  };
}

function updateGpsView(fused, status) {
  if (fused) {
    $('lat').textContent = fused.lat.toFixed(7);
    $('lng').textContent = fused.lng.toFixed(7);
    $('acc').textContent = fused.acc.toFixed(2);
    $('bestAcc').textContent = isFinite(fused.rawBest) ? fused.rawBest.toFixed(2) : '—';
    $('samples').textContent = gpsSamples.length;
    $('gpsTime').textContent = fmtDateTime();

    const accEl = $('acc');
    accEl.classList.remove('acc-good','acc-ok','acc-bad');
    if (fused.acc <= TARGET_ACC) accEl.classList.add('acc-good');
    else if (fused.acc <= 5) accEl.classList.add('acc-ok');
    else accEl.classList.add('acc-bad');
  }
  if (status) $('gpsStatus').textContent = status;
}

function stopGpsWatch(finalMsg) {
  if (gpsWatchId != null) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
  if (gpsTickTimer) { clearInterval(gpsTickTimer); gpsTickTimer = null; }
  setGpsBtn('CAPTURE LOCATION', false);
  if (finalMsg) $('gpsStatus').textContent = finalMsg;
}

function commitFused(reason) {
  const fused = fuseSamples(gpsSamples);
  if (!fused) { stopGpsWatch('No usable fix.'); return; }
  state.gps = fused;
  updateGpsView(fused);
  stopGpsWatch(`${reason}  ·  fused ${fused.acc.toFixed(2)} m from ${fused.samples}/${gpsSamples.length} samples (best raw ${fused.rawBest.toFixed(2)} m)`);
  toast(`GPS locked at ${fused.acc.toFixed(2)} m`);
  if (typeof scheduleDraftSave === 'function') scheduleDraftSave();
}

$('btnGetLocation').addEventListener('click', () => {
  // If watching → user wants to stop & accept best so far
  if (gpsWatchId != null) {
    if (gpsSamples.length) commitFused('Stopped by user');
    else stopGpsWatch('Cancelled — no fix obtained.');
    return;
  }

  if (!navigator.geolocation) { toast('Geolocation not supported'); return; }

  gpsSamples = [];
  gpsBestAcc = Infinity;
  gpsStartTs = Date.now();
  setGpsBtn('STOP & USE BEST', true);
  $('gpsStatus').textContent = `Acquiring high-precision GPS… target ≤ ${TARGET_ACC} m. Stand outdoors, hold device flat & still.`;
  $('samples').textContent = '0';
  $('bestAcc').textContent = '—';

  // Live ticker
  gpsTickTimer = setInterval(() => {
    if (!gpsSamples.length) return;
    const sec = Math.round((Date.now() - gpsStartTs) / 1000);
    const fused = fuseSamples(gpsSamples);
    const goodCount = gpsSamples.filter(s => s.acc <= TARGET_ACC * 1.5).length;
    $('gpsStatus').textContent =
      `Refining…  fused ${fused.acc.toFixed(2)} m  ·  best raw ${gpsBestAcc.toFixed(2)} m  ·  ${gpsSamples.length} samples (${goodCount} good)  ·  ${sec}s elapsed  ·  tap STOP to accept`;
    updateGpsView(fused);
  }, 500);

  gpsWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      const c = pos.coords;
      if (!isFinite(c.accuracy) || c.accuracy <= 0) return;

      const s = {
        lat: c.latitude, lng: c.longitude,
        acc: c.accuracy, alt: c.altitude, hdg: c.heading,
        t: Date.now(),
      };
      gpsSamples.push(s);
      if (gpsSamples.length > MAX_SAMPLES_KEPT) gpsSamples.shift();
      if (s.acc < gpsBestAcc) gpsBestAcc = s.acc;

      const fused = fuseSamples(gpsSamples);
      updateGpsView(fused);

      const goodCount = gpsSamples.filter(x => x.acc <= TARGET_ACC * 1.5).length;

      // Auto-lock when fused accuracy meets target AND we have enough agreeing samples
      if (fused.acc <= TARGET_ACC && goodCount >= MIN_GOOD_SAMPLES) {
        commitFused('Location locked ✓');
        return;
      }

      if (Date.now() - gpsStartTs > MAX_WAIT_MS) {
        commitFused('Timeout — best available accepted');
      }
    },
    (err) => {
      // err.code: 1=PERMISSION_DENIED, 2=POSITION_UNAVAILABLE, 3=TIMEOUT
      const elapsed = Math.round((Date.now() - gpsStartTs) / 1000);

      if (err.code === 1) {
        // Permission denied — must stop, user action required
        stopGpsWatch('GPS permission denied. Enable Location for this site in browser settings.');
        toast('GPS permission denied', 4000);
        return;
      }

      if (err.code === 3) {
        // TIMEOUT — keep waiting. watchPosition will keep emitting; don't kill it.
        if (gpsSamples.length > 0) {
          // We already have a fix — accept it
          commitFused('Timeout — best available accepted');
        } else {
          $('gpsStatus').textContent =
            `GPS slow (${elapsed}s) — still searching satellites. Go outdoors or near a window. Tap STOP to cancel.`;
          // Auto-give-up only after the hard cap
          if (Date.now() - gpsStartTs > MAX_WAIT_MS) {
            stopGpsWatch('Timeout — no GPS fix obtained. Check Location services are ON in device settings.');
          }
        }
        return;
      }

      if (err.code === 2) {
        // POSITION_UNAVAILABLE — device unable to determine right now; retry implicitly via watch
        $('gpsStatus').textContent =
          `GPS unavailable (${elapsed}s) — searching… check Location services & try outdoors. Tap STOP to cancel.`;
        if (gpsSamples.length === 0 && Date.now() - gpsStartTs > MAX_WAIT_MS) {
          stopGpsWatch('Unable to obtain GPS. Verify Location is ON for this browser & try outdoors.');
        }
        return;
      }

      // Unknown error — show it but keep watching
      $('gpsStatus').textContent = `GPS: ${err.message || 'unknown error'} — still trying…`;
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 60000 }
  );
});

// ---------- Camera ----------
const video = $('video');
const canvas = $('canvas');
const camOverlay = $('camOverlay');

async function startCamera() {
  try {
    stopCamera();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Camera API not available. Use HTTPS and a modern browser.', 4500);
      return;
    }

    // Mobile-safe constraints: facingMode as exact when possible, fall back gracefully.
    const tryConstraints = [
      { video: { facingMode: { exact: state.facing }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
      { video: { facingMode: state.facing, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
      { video: { facingMode: state.facing }, audio: false },
      { video: true, audio: false },
    ];

    let stream = null;
    let lastErr = null;
    for (const c of tryConstraints) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(c);
        if (stream) break;
      } catch (e) { lastErr = e; }
    }
    if (!stream) throw (lastErr || new Error('Unable to open camera'));

    state.stream = stream;

    // iOS-safe video attributes (must be set BEFORE srcObject)
    video.setAttribute('playsinline', 'true');
    video.setAttribute('webkit-playsinline', 'true');
    video.muted = true;
    video.autoplay = true;
    video.srcObject = stream;

    // Wait for metadata so videoWidth/Height are non-zero BEFORE enabling snap
    await new Promise((resolve, reject) => {
      let done = false;
      const ok = () => { if (done) return; done = true; resolve(); };
      const fail = (e) => { if (done) return; done = true; reject(e); };
      video.addEventListener('loadedmetadata', ok, { once: true });
      video.addEventListener('canplay', ok, { once: true });
      video.addEventListener('error', fail, { once: true });
      // safety timeout — resolve anyway, we'll re-check at snap time
      setTimeout(ok, 4000);
    });

    // Force play() — required on iOS Safari and some Android browsers
    try { await video.play(); } catch (e) { /* user gesture already, but ignore if browser auto-resolved */ }

    camOverlay.classList.add('hidden');
    $('btnSnap').disabled = false;
    $('btnStopCam').disabled = false;
    $('btnSwitchCam').disabled = false;
    $('btnStartCam').disabled = true;
    toast('Camera ready');
  } catch (e) {
    const msg = (e && e.name === 'NotAllowedError') ? 'Camera permission denied. Enable Camera for this site in browser settings.'
              : (e && e.name === 'NotFoundError') ? 'No camera found on this device.'
              : (e && e.name === 'NotReadableError') ? 'Camera is in use by another app — close other apps and try again.'
              : (e && e.name === 'OverconstrainedError') ? 'Requested camera not available — try SWITCH.'
              : ('Camera error: ' + (e && e.message ? e.message : e));
    toast(msg, 5000);
  }
}
function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
  }
  video.srcObject = null;
  camOverlay.classList.remove('hidden');
  $('btnSnap').disabled = true;
  $('btnStopCam').disabled = true;
  $('btnSwitchCam').disabled = true;
  $('btnStartCam').disabled = false;
}
async function snapPhoto() {
  if (!state.stream) { toast('Camera not started'); return; }

  // If dimensions aren't ready yet (mobile timing), wait briefly for the next frame.
  let w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) {
    await new Promise((resolve) => {
      let tries = 0;
      const tick = () => {
        w = video.videoWidth; h = video.videoHeight;
        if (w && h) return resolve();
        if (++tries > 30) return resolve();   // ~1s max wait
        requestAnimationFrame(tick);
      };
      tick();
    });
    w = video.videoWidth; h = video.videoHeight;
  }
  if (!w || !h) { toast('Camera not ready — tap START CAMERA again'); return; }

  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);

  // Stamp GPS + time
  const stamp = [
    fmtDateTime(),
    state.gps ? `LAT ${state.gps.lat.toFixed(7)}  LNG ${state.gps.lng.toFixed(7)}  ±${state.gps.acc.toFixed(2)}m` : 'GPS: not captured'
  ];
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(0, h - 60, w, 60);
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.max(14, Math.floor(w / 70))}px monospace`;
  ctx.fillText(stamp[0], 12, h - 36);
  ctx.fillText(stamp[1], 12, h - 12);

  let dataUrl = canvas.toDataURL('image/jpeg', 0.82);
  dataUrl = injectExif(dataUrl, state.gps, $('surveyId').value);
  addPhoto(dataUrl);
}
function addPhoto(dataUrl) {
  state.photos.push({ id: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2,7), dataUrl, time: new Date().toISOString() });
  renderThumbs();
  toast('Photo captured');
}
function renderThumbs() {
  const strip = $('thumbStrip');
  strip.innerHTML = '';
  if (!state.photos.length) {
    strip.innerHTML = '<div class="thumb-empty">No photos captured yet.</div>';
    return;
  }
  state.photos.forEach(p => {
    const div = document.createElement('div');
    div.className = 'thumb';
    div.innerHTML = `<img src="${p.dataUrl}" alt=""><button class="del" title="Delete">×</button>`;
    div.querySelector('.del').addEventListener('click', () => {
      state.photos = state.photos.filter(x => x.id !== p.id);
      renderThumbs();
    });
    div.querySelector('img').addEventListener('click', () =>
      openLightbox(state.photos.map(x => x.dataUrl), state.photos.findIndex(x => x.id === p.id), 'Captured photo')
    );
    strip.appendChild(div);
  });
}
function openImageModal(src) {
  // Legacy — now routes to lightbox
  openLightbox([src], 0);
}

$('btnStartCam').addEventListener('click', startCamera);
$('btnStopCam').addEventListener('click', stopCamera);
$('btnSnap').addEventListener('click', snapPhoto);
$('btnSwitchCam').addEventListener('click', () => {
  state.facing = state.facing === 'environment' ? 'user' : 'environment';
  startCamera();
});
$('fileInput').addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  files.forEach(f => {
    const reader = new FileReader();
    reader.onload = () => {
      let url = reader.result;
      if (typeof url === 'string' && url.startsWith('data:image/jpeg')) {
        url = injectExif(url, state.gps, $('surveyId').value);
      }
      addPhoto(url);
    };
    reader.readAsDataURL(f);
  });
  e.target.value = '';
});

// ---------- Form ----------
function newSurveyId() { $('surveyId').value = genSurveyId(); }
newSurveyId();

$('btnReset').addEventListener('click', () => resetForm(true));

function resetForm(confirmReset = false) {
  if (confirmReset && !confirm('Reset the current form? Unsaved data will be lost.')) return;
  $('surveyForm').reset();
  state.photos = [];
  state.gps = null;
  ['lat','lng','acc','bestAcc','gpsTime'].forEach(id => $(id).textContent = '—');
  $('samples').textContent = '0';
  $('acc').classList.remove('acc-good','acc-ok','acc-bad');
  $('gpsStatus').textContent = 'Tap CAPTURE LOCATION to fetch precise GPS coordinates.';
  renderThumbs();
  newSurveyId();
  state.editingId = null;
  $('btnSave').textContent = 'SAVE SURVEY';
}

$('surveyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const rec = collectForm();
  if (!rec.surveyor || !rec.customer || !rec.address) {
    toast('Please fill required fields'); return;
  }
  if (!rec.gps || rec.gps.lat == null || rec.gps.lng == null) {
    toast('GPS coordinates required — tap CAPTURE LOCATION first', 3500);
    document.querySelector('#tab-capture .card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('btnGetLocation').focus();
    return;
  }
  try {
    await dbPut(rec);
    toast(state.editingId ? 'Survey updated' : 'Survey saved');
    clearDraft();
    resetForm(false);
    await refreshCount();
  } catch (err) {
    toast('Save failed: ' + err.message, 3500);
  }
});

function collectForm() {
  return {
    id: $('surveyId').value || genSurveyId(),
    createdAt: new Date().toISOString(),
    surveyor: $('surveyor').value.trim(),
    customer: $('customer').value.trim(),
    customerId: $('customerId').value.trim(),
    address: $('address').value.trim(),
    ward: $('ward').value,
    contact: $('contact').value.trim(),
    connType: $('connType').value,
    pipeMat: $('pipeMat').value,
    meterStatus: $('meterStatus').value,
    meterReading: $('meterReading').value,
    meterSerial: $('meterSerial').value.trim(),
    pressure: $('pressure').value,
    leakage: $('leakage').value,
    supplyHrs: $('supplyHrs').value,
    condition: $('condition').value,
    priority: $('priority').value,
    remarks: $('remarks').value.trim(),
    gps: state.gps,
    photos: state.photos.slice(),
  };
}

// ---------- Records ----------
async function refreshCount() {
  const all = await dbAll();
  $('recordCount').textContent = all.length;
}
refreshCount();

async function renderRecords() {
  const all = (await dbAll()).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const q = ($('searchBox').value || '').toLowerCase().trim();
  const list = q ? all.filter(r =>
    [r.customer, r.address, r.id, r.surveyor, r.customerId].some(v => (v || '').toLowerCase().includes(q))
  ) : all;

  const body = $('recordBody');
  body.innerHTML = '';
  $('emptyState').style.display = list.length ? 'none' : 'block';
  list.forEach((r, i) => {
    const tr = document.createElement('tr');
    const photos = (r.photos || []).slice(0, 3).map((p, pi) => `<img src="${p.dataUrl}" data-rid="${r.id}" data-pi="${pi}">`).join('');
    const more = (r.photos?.length > 3) ? `<span style="font-size:10px;align-self:center;">+${r.photos.length - 3}</span>` : '';
    tr.innerHTML = `
      <td data-label="#">${i + 1}</td>
      <td data-label="Survey ID" style="font-family:monospace;font-size:11px;">${r.id}</td>
      <td data-label="Date">${(r.createdAt || '').replace('T',' ').slice(0,16)}</td>
      <td data-label="Customer">${escapeHtml(r.customer || '')}</td>
      <td data-label="Address">${escapeHtml(r.address || '')}</td>
      <td data-label="Lat, Lng" style="font-family:monospace;font-size:11px;">${r.gps ? r.gps.lat.toFixed(6)+', '+r.gps.lng.toFixed(6) : '—'}</td>
      <td data-label="Condition">${escapeHtml(r.condition || '')}</td>
      <td data-label="Photos"><div class="mini-thumbs">${photos}${more}</div></td>
      <td data-label="Actions">
        <div class="row-actions">
          <button class="btn" data-act="view" data-id="${r.id}">VIEW</button>
          <button class="btn" data-act="pdf" data-id="${r.id}">PDF</button>
          <button class="btn" data-act="edit" data-id="${r.id}">EDIT</button>
          <button class="btn btn-danger" data-act="del" data-id="${r.id}">DEL</button>
        </div>
      </td>
    `;
    body.appendChild(tr);
  });

  body.querySelectorAll('button[data-act]').forEach(b => {
    b.addEventListener('click', () => handleRowAction(b.dataset.act, b.dataset.id));
  });
  body.querySelectorAll('.mini-thumbs img').forEach(img => {
    img.addEventListener('click', async () => {
      const rec = await dbGet(img.dataset.rid);
      if (rec) openLightbox(rec.photos.map(p => p.dataUrl), Number(img.dataset.pi), rec.customer || rec.id);
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function handleRowAction(act, id) {
  const rec = await dbGet(id);
  if (!rec) return;
  if (act === 'view') showRecordModal(rec);
  else if (act === 'pdf') generateSurveyPdf(rec);
  else if (act === 'del') {
    if (!confirm(`Delete record ${id}?`)) return;
    await dbDel(id);
    await refreshCount();
    renderRecords();
    toast('Deleted');
  } else if (act === 'edit') {
    loadIntoForm(rec);
    document.querySelector('.tab[data-tab="capture"]').click();
  }
}

function loadIntoForm(r) {
  resetForm(false);
  state.editingId = r.id;
  $('surveyId').value = r.id;
  $('surveyor').value = r.surveyor || '';
  $('customer').value = r.customer || '';
  $('customerId').value = r.customerId || '';
  $('address').value = r.address || '';
  $('ward').value = r.ward || '';
  $('contact').value = r.contact || '';
  $('connType').value = r.connType || '';
  $('pipeMat').value = r.pipeMat || '';
  $('meterStatus').value = r.meterStatus || '';
  $('meterReading').value = r.meterReading || '';
  $('meterSerial').value = r.meterSerial || '';
  $('pressure').value = r.pressure || '';
  $('leakage').value = r.leakage || 'No';
  $('supplyHrs').value = r.supplyHrs || '';
  $('condition').value = r.condition || 'Good';
  $('priority').value = r.priority || 'Normal';
  $('remarks').value = r.remarks || '';
  if (r.gps) {
    state.gps = r.gps;
    $('lat').textContent = r.gps.lat?.toFixed?.(7) ?? '—';
    $('lng').textContent = r.gps.lng?.toFixed?.(7) ?? '—';
    $('acc').textContent = r.gps.acc?.toFixed?.(2) ?? '—';
    $('bestAcc').textContent = r.gps.rawBest?.toFixed?.(2) ?? '—';
    $('samples').textContent = r.gps.samples ?? '—';
    $('gpsTime').textContent = (r.gps.time || '').replace('T',' ').slice(0,19);
  }
  state.photos = (r.photos || []).slice();
  renderThumbs();
  $('btnSave').textContent = 'UPDATE SURVEY';
  toast('Loaded for editing');
}

function showRecordModal(r) {
  $('modalTitle').textContent = r.id;
  const rows = [
    ['Survey ID', r.id],
    ['Created At', (r.createdAt || '').replace('T',' ').slice(0,19)],
    ['Surveyor', r.surveyor],
    ['Customer', r.customer],
    ['Customer ID', r.customerId],
    ['Address', r.address],
    ['Ward', r.ward],
    ['Contact', r.contact],
    ['Connection Type', r.connType],
    ['Pipe Material', r.pipeMat],
    ['Meter Status', r.meterStatus],
    ['Meter Reading', r.meterReading],
    ['Meter Serial', r.meterSerial],
    ['Pressure (psi)', r.pressure],
    ['Leakage', r.leakage],
    ['Supply Hours/day', r.supplyHrs],
    ['Condition', r.condition],
    ['Priority', r.priority],
    ['Remarks', r.remarks],
    ['Latitude', r.gps?.lat?.toFixed?.(7)],
    ['Longitude', r.gps?.lng?.toFixed?.(7)],
    ['Accuracy (m)', r.gps?.acc?.toFixed?.(2)],
    ['Best Raw (m)', r.gps?.rawBest?.toFixed?.(2)],
    ['Samples', r.gps?.samples],
    ['Google Maps', r.gps ? `<a href="https://maps.google.com/?q=${r.gps.lat},${r.gps.lng}" target="_blank" rel="noopener">OPEN ↗</a>` : ''],
  ];
  const kv = rows.map(([k, v]) => `<div class="kv"><b>${k}</b><span>${v ?? '—'}</span></div>`).join('');
  const photos = (r.photos || []).map((p, i) => `<img src="${p.dataUrl}" data-idx="${i}" alt="">`).join('');
  $('modalBody').innerHTML = kv + (photos ? `<div class="modal-photos">${photos}</div>` : '');
  // Wire photo clicks → lightbox
  $('modalBody').querySelectorAll('.modal-photos img').forEach(img => {
    img.addEventListener('click', () => {
      openLightbox(r.photos.map(p => p.dataUrl), Number(img.dataset.idx), r.customer || r.id);
    });
  });
  $('modal').hidden = false;
}
$('modalClose').addEventListener('click', () => $('modal').hidden = true);
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('modal').hidden = true; });

$('searchBox').addEventListener('input', renderRecords);

// ---------- Excel Export ----------
$('btnExport').addEventListener('click', async () => {
  const all = await dbAll();
  if (!all.length) { toast('No records to export'); return; }

  const rows = all.map((r, i) => ({
    '#': i + 1,
    'Survey ID': r.id,
    'Date/Time': (r.createdAt || '').replace('T',' ').slice(0,19),
    'Surveyor': r.surveyor || '',
    'Customer Name': r.customer || '',
    'Customer ID': r.customerId || '',
    'Address': r.address || '',
    'Ward': r.ward || '',
    'Contact': r.contact || '',
    'Connection Type': r.connType || '',
    'Pipe Material': r.pipeMat || '',
    'Meter Status': r.meterStatus || '',
    'Meter Reading': r.meterReading || '',
    'Meter Serial': r.meterSerial || '',
    'Pressure (psi)': r.pressure || '',
    'Leakage': r.leakage || '',
    'Supply Hours/Day': r.supplyHrs || '',
    'Condition': r.condition || '',
    'Priority': r.priority || '',
    'Remarks': r.remarks || '',
    'Latitude': r.gps?.lat ?? '',
    'Longitude': r.gps?.lng ?? '',
    'GPS Accuracy (m)': r.gps?.acc ?? '',
    'Best Raw Accuracy (m)': r.gps?.rawBest ?? '',
    'GPS Samples': r.gps?.samples ?? '',
    'Google Maps Link': r.gps ? `https://maps.google.com/?q=${r.gps.lat},${r.gps.lng}` : '',
    'Photo Count': (r.photos || []).length,
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  // Auto width
  const colWidths = Object.keys(rows[0]).map(k => ({
    wch: Math.min(40, Math.max(k.length, ...rows.map(r => String(r[k] ?? '').length))) + 2
  }));
  ws['!cols'] = colWidths;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Surveys');

  // Optional summary sheet
  const summary = [
    ['KUKL Baneshwor — Site Survey Export'],
    ['Generated', fmtDateTime()],
    ['Total Records', all.length],
    ['Total Photos', all.reduce((s, r) => s + (r.photos?.length || 0), 0)],
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(summary);
  ws2['!cols'] = [{wch:24},{wch:30}];
  XLSX.utils.book_append_sheet(wb, ws2, 'Summary');

  const fname = `KUKL_Baneshwor_Survey_${new Date().toISOString().slice(0,10)}.xlsx`;
  XLSX.writeFile(wb, fname);
  toast('Excel exported');
});

// ---------- JSON Export / Import (full backup incl. photos) ----------
$('btnExportJson').addEventListener('click', async () => {
  const all = await dbAll();
  if (!all.length) { toast('No records'); return; }
  const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `KUKL_Survey_Backup_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Backup exported');
});

$('btnImportJson').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  try {
    const text = await f.text();
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error('Invalid file');
    if (!confirm(`Import ${arr.length} record(s)? Existing IDs will be overwritten.`)) return;
    for (const r of arr) await dbPut(r);
    await refreshCount();
    renderRecords();
    toast('Import complete');
  } catch (err) {
    toast('Import failed: ' + err.message, 3500);
  }
  e.target.value = '';
});

$('btnClearAll').addEventListener('click', async () => {
  const all = await dbAll();
  if (!all.length) { toast('Nothing to delete'); return; }
  if (!confirm(`Delete ALL ${all.length} records? This cannot be undone.`)) return;
  if (!confirm('Are you really sure? Export Excel first if needed.')) return;
  await dbClear();
  await refreshCount();
  renderRecords();
  toast('All records deleted');
});

// ---------- Map Tab (Leaflet + OpenStreetMap) ----------
let leafletMap = null;
let leafletMarkers = [];
const KTM_DEFAULT = [27.7053, 85.3414]; // Kathmandu Baneshwor approx

function conditionClass(c) {
  switch ((c || '').toLowerCase()) {
    case 'excellent': return 'excellent';
    case 'good':      return 'good';
    case 'fair':      return 'fair';
    case 'poor':      return 'poor';
    case 'critical':  return 'critical';
    default:          return 'good';
  }
}

function ensureLeaflet() {
  if (leafletMap) return leafletMap;
  if (typeof L === 'undefined') return null;
  const el = $('leafletMap');
  if (!el) return null;
  // Guarantee non-zero height even if CSS is overridden
  if (!el.style.height) el.style.height = '520px';
  leafletMap = L.map(el, { zoomControl: true }).setView(KTM_DEFAULT, 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    crossOrigin: true,
    attribution: '© OpenStreetMap contributors',
  }).addTo(leafletMap);
  // Resize support
  window.addEventListener('resize', () => leafletMap && leafletMap.invalidateSize());
  // DMA overlay (boundaries, pipes, connections, devices) — optional
  if (window.KUKLDma) {
    try { window.KUKLDma.attach(leafletMap); } catch (e) { console.warn('[DMA] attach failed', e); }
  }
  return leafletMap;
}

function kickMapResize() {
  if (!leafletMap) return;
  // Ladder of resizes to defeat any layout/animation race conditions
  [0, 50, 200, 500, 1000].forEach(t => setTimeout(() => leafletMap.invalidateSize(), t));
}

async function renderMap() {
  const map = ensureLeaflet();
  if (!map) { toast('Map library not loaded — check internet'); return; }
  kickMapResize();

  // Clear old markers
  leafletMarkers.forEach(m => map.removeLayer(m));
  leafletMarkers = [];

  const all = (await dbAll()).filter(r => r.gps && isFinite(r.gps.lat) && isFinite(r.gps.lng));
  if (!all.length) {
    map.setView(KTM_DEFAULT, 14);
    kickMapResize();
    return;
  }

  all.forEach(r => {
    const cls = conditionClass(r.condition);
    const icon = L.divIcon({
      className: '',
      html: `<div class="kukl-marker ${cls}"></div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 22],
      popupAnchor: [0, -20],
    });
    const marker = L.marker([r.gps.lat, r.gps.lng], { icon }).addTo(map);

    const photosHtml = (r.photos || []).slice(0, 4)
      .map((p, i) => `<img data-rid="${r.id}" data-pi="${i}" src="${p.dataUrl}" alt="">`).join('');
    const popup = `
      <b>${escapeHtml(r.customer || r.id)}</b><br/>
      <span style="font-size:11px;">${escapeHtml(r.address || '')}</span><br/>
      <span style="font-family:monospace;font-size:11px;">${r.gps.lat.toFixed(6)}, ${r.gps.lng.toFixed(6)}  ±${r.gps.acc?.toFixed?.(1) ?? '?'}m</span><br/>
      <span style="font-size:11px;">Condition: <b>${escapeHtml(r.condition || '—')}</b>  ·  Priority: <b>${escapeHtml(r.priority || '—')}</b></span>
      ${photosHtml ? `<div class="popup-photos">${photosHtml}</div>` : ''}
      <a class="popup-link" href="https://maps.google.com/?q=${r.gps.lat},${r.gps.lng}" target="_blank" rel="noopener">GOOGLE MAPS ↗</a>
      <a class="popup-link" href="#" data-view="${r.id}">VIEW DETAILS</a>
    `;
    marker.bindPopup(popup);
    marker.on('popupopen', (e) => {
      const root = e.popup.getElement();
      const v = root.querySelector('[data-view]');
      if (v) v.addEventListener('click', (ev) => {
        ev.preventDefault();
        marker.closePopup();
        showRecordModal(r);
      });
    });
    leafletMarkers.push(marker);
  });

  // Fit bounds
  const bounds = L.latLngBounds(all.map(r => [r.gps.lat, r.gps.lng]));
  map.fitBounds(bounds.pad(0.2), { maxZoom: 18 });
  kickMapResize();
}

$('btnFitMap')?.addEventListener('click', () => {
  if (!leafletMap || !leafletMarkers.length) { toast('No locations'); return; }
  const bounds = L.latLngBounds(leafletMarkers.map(m => m.getLatLng()));
  leafletMap.fitBounds(bounds.pad(0.2), { maxZoom: 18 });
});

$('btnOpenGmaps').addEventListener('click', async () => {
  const all = (await dbAll()).filter(r => r.gps);
  if (!all.length) { toast('No locations'); return; }
  const r = all[0];
  window.open(`https://maps.google.com/?q=${r.gps.lat},${r.gps.lng}`, '_blank');
});

// ---------- Beforeunload guard ----------
window.addEventListener('beforeunload', (e) => {
  const hasData = state.photos.length > 0 || state.gps || $('customer').value || $('address').value;
  if (hasData && !state.justSaved) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------- Init ----------
renderThumbs();

/* ============================================================
   AUTO-SAVE DRAFTS  (localStorage, debounced)
   ============================================================ */
const DRAFT_KEY = 'kukl_survey_draft_v1';
let draftTimer = null;

const FORM_FIELDS = [
  'surveyId','surveyor','customer','customerId','address','ward','contact',
  'connType','pipeMat','meterStatus','meterReading','meterSerial',
  'pressure','leakage','supplyHrs','condition','priority','remarks'
];

function saveDraftNow() {
  // Don't draft while editing existing record
  if (state.editingId) return;
  const data = {};
  FORM_FIELDS.forEach(id => { data[id] = $(id)?.value ?? ''; });
  const hasContent = data.customer || data.address || data.surveyor || data.remarks
                  || state.gps || state.photos.length;
  if (!hasContent) {
    localStorage.removeItem(DRAFT_KEY);
    return;
  }
  const draft = { data, gps: state.gps, photos: state.photos, savedAt: new Date().toISOString() };
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); }
  catch (e) { /* quota: drop photos */
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, photos: [] })); } catch {}
  }
}
function scheduleDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraftNow, 400);
}
function clearDraft() { localStorage.removeItem(DRAFT_KEY); $('draftBanner').hidden = true; }

// Hook every form input
FORM_FIELDS.forEach(id => {
  const el = $(id);
  if (el) el.addEventListener('input', scheduleDraftSave);
});

// Also save when photos / GPS change
const _addPhoto = addPhoto;
window.addPhoto = function(d){ _addPhoto(d); scheduleDraftSave(); };
// patch the photo array delete (renderThumbs rebuilds; hook the click via mutation isn't needed — just save on any thumb interaction by re-listening here)
new MutationObserver(scheduleDraftSave).observe($('thumbStrip'), { childList: true });

// Restore draft on load
function restoreDraft() {
  const raw = localStorage.getItem(DRAFT_KEY);
  if (!raw) return;
  try {
    const draft = JSON.parse(raw);
    if (!draft || !draft.data) return;
    FORM_FIELDS.forEach(id => { if ($(id) && draft.data[id] != null) $(id).value = draft.data[id]; });
    if (draft.gps) {
      state.gps = draft.gps;
      $('lat').textContent = draft.gps.lat?.toFixed?.(7) ?? '—';
      $('lng').textContent = draft.gps.lng?.toFixed?.(7) ?? '—';
      $('acc').textContent = draft.gps.acc?.toFixed?.(2) ?? '—';
      $('bestAcc').textContent = draft.gps.rawBest?.toFixed?.(2) ?? '—';
      $('samples').textContent = draft.gps.samples ?? '—';
      $('gpsTime').textContent = (draft.gps.time || '').replace('T',' ').slice(0,19);
      if (draft.gps.acc <= TARGET_ACC) $('acc').classList.add('acc-good');
    }
    if (Array.isArray(draft.photos)) {
      state.photos = draft.photos;
      renderThumbs();
    }
    const when = (draft.savedAt || '').replace('T',' ').slice(0,16);
    $('draftMsg').textContent = `Draft restored from ${when}`;
    $('draftBanner').hidden = false;
  } catch {}
}
$('btnDiscardDraft').addEventListener('click', () => {
  if (!confirm('Discard the restored draft?')) return;
  clearDraft();
  resetForm(false);
});
restoreDraft();

/* ============================================================
   VOICE → TEXT for Remarks  (Web Speech API)
   ============================================================ */
const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
const btnVoice = $('btnVoice');
let recog = null, recogActive = false;

if (!Speech) {
  btnVoice.disabled = true;
  btnVoice.title = 'Voice recognition not supported in this browser';
  btnVoice.textContent = 'NO MIC';
} else {
  btnVoice.addEventListener('click', () => {
    if (recogActive) { try { recog.stop(); } catch {} return; }
    recog = new Speech();
    recog.lang = $('voiceLang').value || 'en-US';
    recog.continuous = true;
    recog.interimResults = true;

    let finalAdd = '';
    recog.onstart = () => {
      recogActive = true;
      btnVoice.classList.add('active');
      btnVoice.textContent = '■ STOP';
      toast('Listening… speak now');
    };
    recog.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalAdd += t + ' ';
        else interim += t;
      }
      const ta = $('remarks');
      const base = (ta.dataset.voiceBase ?? ta.value);
      if (!ta.dataset.voiceBase) ta.dataset.voiceBase = base;
      const sep = ta.dataset.voiceBase && !/\s$/.test(ta.dataset.voiceBase) ? ' ' : '';
      ta.value = ta.dataset.voiceBase + sep + finalAdd + interim;
      scheduleDraftSave();
    };
    recog.onerror = (e) => { toast('Voice error: ' + e.error, 3000); };
    recog.onend = () => {
      recogActive = false;
      btnVoice.classList.remove('active');
      btnVoice.textContent = '● MIC';
      const ta = $('remarks');
      delete ta.dataset.voiceBase;
    };
    try { recog.start(); } catch (e) { toast('Mic failed: ' + e.message, 3000); }
  });
}

/* ============================================================
   QR / BARCODE SCAN for Customer ID  (html5-qrcode)
   ============================================================ */
let qrScanner = null;
const scanModal = $('scanModal');

async function openScanner() {
  if (typeof Html5Qrcode === 'undefined') {
    toast('Scanner library failed to load (need internet)', 3500); return;
  }
  scanModal.hidden = false;
  try {
    qrScanner = new Html5Qrcode('scanRegion');
    await qrScanner.start(
      { facingMode: 'environment' },
      { fps: 12, qrbox: { width: 260, height: 160 } },
      (decodedText) => {
        $('customerId').value = decodedText;
        scheduleDraftSave();
        toast('Scanned: ' + decodedText);
        closeScanner();
      },
      () => { /* per-frame errors silenced */ }
    );
  } catch (e) {
    toast('Camera error: ' + e.message, 3500);
    closeScanner();
  }
}
async function closeScanner() {
  scanModal.hidden = true;
  if (qrScanner) {
    try { await qrScanner.stop(); await qrScanner.clear(); } catch {}
    qrScanner = null;
  }
}
$('btnScanQr').addEventListener('click', openScanner);
$('scanClose').addEventListener('click', closeScanner);
scanModal.addEventListener('click', (e) => { if (e.target.id === 'scanModal') closeScanner(); });

/* ============================================================
   EXIF — Write GPS coordinates + survey ID into JPEG
   ============================================================ */
function injectExif(jpegDataUrl, gps, surveyId) {
  if (typeof piexif === 'undefined') return jpegDataUrl;
  if (typeof jpegDataUrl !== 'string' || !jpegDataUrl.startsWith('data:image/jpeg')) return jpegDataUrl;
  try {
    let exif;
    try { exif = piexif.load(jpegDataUrl); }
    catch { exif = { '0th': {}, 'Exif': {}, 'GPS': {}, 'Interop': {}, '1st': {}, 'thumbnail': null }; }
    exif['0th'] = exif['0th'] || {};
    exif['Exif'] = exif['Exif'] || {};
    exif['GPS']  = exif['GPS']  || {};

    if (gps && isFinite(gps.lat) && isFinite(gps.lng)) {
      const toDms = piexif.GPSHelper.degToDmsRational;
      exif.GPS[piexif.GPSIFD.GPSLatitudeRef]  = gps.lat >= 0 ? 'N' : 'S';
      exif.GPS[piexif.GPSIFD.GPSLatitude]     = toDms(Math.abs(gps.lat));
      exif.GPS[piexif.GPSIFD.GPSLongitudeRef] = gps.lng >= 0 ? 'E' : 'W';
      exif.GPS[piexif.GPSIFD.GPSLongitude]    = toDms(Math.abs(gps.lng));
      if (gps.alt != null && isFinite(gps.alt)) {
        exif.GPS[piexif.GPSIFD.GPSAltitudeRef] = gps.alt >= 0 ? 0 : 1;
        exif.GPS[piexif.GPSIFD.GPSAltitude]    = [Math.round(Math.abs(gps.alt) * 100), 100];
      }
      if (gps.acc != null && isFinite(gps.acc)) {
        // Use DOP field to store accuracy radius (rational, 2-decimal)
        exif.GPS[piexif.GPSIFD.GPSDOP] = [Math.round(gps.acc * 100), 100];
      }
      const d = new Date(gps.time || Date.now());
      exif.GPS[piexif.GPSIFD.GPSDateStamp] = `${d.getUTCFullYear()}:${pad(d.getUTCMonth()+1)}:${pad(d.getUTCDate())}`;
      exif.GPS[piexif.GPSIFD.GPSTimeStamp] = [
        [d.getUTCHours(), 1], [d.getUTCMinutes(), 1], [d.getUTCSeconds(), 1]
      ];
      exif.GPS[piexif.GPSIFD.GPSMapDatum] = 'WGS-84';
    }

    exif['0th'][piexif.ImageIFD.ImageDescription] = `KUKL Survey ${surveyId || ''}`.trim();
    exif['0th'][piexif.ImageIFD.Software] = 'KUKL Baneshwor Site Survey System';
    exif['0th'][piexif.ImageIFD.DateTime] = fmtDateTime().replace(/-/g, ':');
    // UserComment requires 8-byte charset prefix (ASCII\0\0\0)
    const uc = `SurveyID:${surveyId || ''}` +
               (gps ? ` | ${gps.lat?.toFixed(7)},${gps.lng?.toFixed(7)} ±${gps.acc?.toFixed(2)}m` : '');
    exif.Exif[piexif.ExifIFD.UserComment] = 'ASCII\0\0\0' + uc;

    return piexif.insert(piexif.dump(exif), jpegDataUrl);
  } catch (e) {
    console.warn('EXIF inject failed:', e);
    return jpegDataUrl;
  }
}

/* ============================================================
   LIGHTBOX — full-screen photo viewer with prev/next/download
   ============================================================ */
const lb = $('lightbox');
const lbImg = $('lbImg');
const lbMeta = $('lbMeta');
let lbList = [];
let lbIdx = 0;
let lbLabel = '';

function openLightbox(urls, idx = 0, label = '') {
  if (!urls?.length) return;
  lbList = urls;
  lbIdx = Math.max(0, Math.min(idx, urls.length - 1));
  lbLabel = label || '';
  showLbImage();
  lb.hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeLightbox() {
  lb.hidden = true;
  lbImg.src = '';
  document.body.style.overflow = '';
}
function showLbImage() {
  lbImg.src = lbList[lbIdx];
  lbMeta.textContent = `${lbLabel ? lbLabel + ' — ' : ''}${lbIdx + 1} / ${lbList.length}`;
  $('lbPrev').style.display = lbList.length > 1 ? '' : 'none';
  $('lbNext').style.display = lbList.length > 1 ? '' : 'none';
}
function lbNext() { lbIdx = (lbIdx + 1) % lbList.length; showLbImage(); }
function lbPrev() { lbIdx = (lbIdx - 1 + lbList.length) % lbList.length; showLbImage(); }

$('lbClose').addEventListener('click', closeLightbox);
$('lbNext').addEventListener('click', lbNext);
$('lbPrev').addEventListener('click', lbPrev);
$('lbDownload').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = lbList[lbIdx];
  const safe = (lbLabel || 'photo').replace(/[^a-z0-9\-_]/gi, '_');
  a.download = `${safe}_${lbIdx + 1}.jpg`;
  a.click();
});
lb.addEventListener('click', (e) => {
  // Click on backdrop (not image or buttons) closes
  if (e.target === lb) closeLightbox();
});
document.addEventListener('keydown', (e) => {
  if (lb.hidden) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowRight') lbNext();
  else if (e.key === 'ArrowLeft') lbPrev();
});
// swipe on mobile
let touchX0 = null;
lb.addEventListener('touchstart', (e) => { touchX0 = e.touches[0].clientX; }, { passive: true });
lb.addEventListener('touchend', (e) => {
  if (touchX0 == null) return;
  const dx = (e.changedTouches[0].clientX - touchX0);
  if (Math.abs(dx) > 50 && lbList.length > 1) (dx < 0 ? lbNext : lbPrev)();
  touchX0 = null;
}, { passive: true });

/* Global event delegation: any thumb image with [data-rid] / [data-pi] anywhere
   in the app opens the lightbox. Safety net so clicks always work. */
document.addEventListener('click', async (e) => {
  const img = e.target.closest('.mini-thumbs img[data-rid], .popup-photos img[data-rid]');
  if (!img) return;
  e.preventDefault();
  e.stopPropagation();
  try {
    const rec = await dbGet(img.dataset.rid);
    if (rec && rec.photos && rec.photos.length) {
      const idx = Number(img.dataset.pi) || 0;
      openLightbox(rec.photos.map(p => p.dataUrl), idx, rec.customer || rec.id);
    }
  } catch (err) {
    console.warn('thumb click failed:', err);
  }
});

/* ============================================================
   PDF REPORT (jsPDF) — one-tap per-survey PDF
   ============================================================ */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function generateSurveyPdf(rec) {
  if (typeof window.jspdf === 'undefined') { toast('PDF library not loaded'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
  const W = doc.internal.pageSize.getWidth();   // 595.28
  const H = doc.internal.pageSize.getHeight();  // 841.89
  const M = 40;                                 // page margin
  const CW = W - 2 * M;                         // content width
  let y;

  // ---------- THEME ----------
  const BLACK = [0, 0, 0];
  const WHITE = [255, 255, 255];
  const GREY_TEXT = [90, 90, 90];
  const GREY_LIGHT = [235, 235, 235];
  const GREY_LINE = [200, 200, 200];
  const ZEBRA = [248, 248, 248];
  const BLUE = [0, 87, 168];

  const COND_COLORS = {
    'Excellent': [26, 127, 26],
    'Good':      [27, 111, 214],
    'Fair':      [230, 194, 0],
    'Poor':      [224, 122, 0],
    'Critical':  [193, 0, 31],
  };
  const PRIO_COLORS = {
    'Normal':   [120, 120, 120],
    'Medium':   [224, 122, 0],
    'High':     [193, 0, 31],
    'Urgent':   [120, 0, 0],
  };

  const setFill = (rgb) => doc.setFillColor(rgb[0], rgb[1], rgb[2]);
  const setText = (rgb) => doc.setTextColor(rgb[0], rgb[1], rgb[2]);
  const setDraw = (rgb) => doc.setDrawColor(rgb[0], rgb[1], rgb[2]);

  // ---------- HELPERS ----------
  function drawHeader() {
    setFill(BLACK);
    doc.rect(0, 0, W, 86, 'F');
    // logo
    try {
      // synchronous-safe: logoImg captured before drawHeader is called
      if (logoImg) doc.addImage(logoImg, 'PNG', M, 16, 54, 54);
    } catch {}
    setText(WHITE);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.text('KUKL — SITE SURVEY REPORT', M + 68, 38);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text('Kathmandu Upatyaka Khanepani Limited', M + 68, 54);
    doc.setFontSize(8);
    setText([200, 200, 200]);
    doc.text('Baneshwor Branch · Site Survey System', M + 68, 66);
    // top-right meta
    setText(WHITE);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text('REPORT GENERATED', W - M, 32, { align: 'right' });
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text(fmtDateTime(new Date()), W - M, 46, { align: 'right' });
    setText(BLACK);
  }

  function drawFooter(pageNo, total) {
    setDraw(GREY_LINE);
    doc.setLineWidth(0.5);
    doc.line(M, H - 30, W - M, H - 30);
    setText(GREY_TEXT);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.text(`KUKL BANESHWOR · SURVEY ${rec.id}`, M, H - 18);
    doc.text('CONFIDENTIAL — INTERNAL USE ONLY', W / 2, H - 18, { align: 'center' });
    doc.text(`Page ${pageNo} / ${total}`, W - M, H - 18, { align: 'right' });
    setText(BLACK);
  }

  function ensure(spaceNeeded) {
    if (y + spaceNeeded > H - 40) {
      doc.addPage();
      drawHeader();
      y = 100;
    }
  }

  function sectionHeader(label) {
    ensure(34);
    setFill(BLACK);
    doc.rect(M, y, CW, 20, 'F');
    setText(WHITE);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.text(label.toUpperCase(), M + 10, y + 14);
    setText(BLACK);
    y += 26;
  }

  function dash(v) {
    if (v == null || v === '' || v === undefined) return '—';
    return String(v);
  }

  // Render a two-column row of key/value pairs. Each side: [label, value].
  // Zebra-striped background based on a counter we keep in closure.
  let _zebra = 0;
  function kvRow(leftPair, rightPair) {
    const colW = (CW - 12) / 2;
    const labelW = 92;
    const padX = 8;
    const padY = 6;

    // Estimate height
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    const leftVal = doc.splitTextToSize(dash(leftPair[1]), colW - labelW - padX * 2);
    const rightVal = rightPair ? doc.splitTextToSize(dash(rightPair[1]), colW - labelW - padX * 2) : [''];
    const rowH = Math.max(22, Math.max(leftVal.length, rightVal.length) * 11 + padY * 2);

    ensure(rowH + 4);

    if (_zebra % 2 === 1) {
      setFill(ZEBRA);
      doc.rect(M, y, CW, rowH, 'F');
    }
    _zebra++;

    // border
    setDraw(GREY_LINE);
    doc.setLineWidth(0.4);
    doc.line(M, y + rowH, M + CW, y + rowH);

    // Left
    setText(GREY_TEXT);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.text(String(leftPair[0]).toUpperCase(), M + padX, y + padY + 8);
    setText(BLACK);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.text(leftVal, M + padX + labelW, y + padY + 8);

    // Right
    if (rightPair) {
      const rx = M + colW + 12;
      setText(GREY_TEXT);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.text(String(rightPair[0]).toUpperCase(), rx + padX, y + padY + 8);
      setText(BLACK);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      doc.text(rightVal, rx + padX + labelW, y + padY + 8);
    }

    y += rowH;
  }

  // Full-width row (long values like address, remarks)
  function fullRow(label, value) {
    const padX = 8;
    const padY = 8;
    const labelH = 14;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    const wrapped = doc.splitTextToSize(dash(value), CW - padX * 2);
    const rowH = Math.max(36, labelH + wrapped.length * 12 + padY * 2);
    ensure(rowH + 4);

    if (_zebra % 2 === 1) {
      setFill(ZEBRA);
      doc.rect(M, y, CW, rowH, 'F');
    }
    _zebra++;
    setDraw(GREY_LINE);
    doc.setLineWidth(0.4);
    doc.line(M, y + rowH, M + CW, y + rowH);

    setText(GREY_TEXT);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.text(String(label).toUpperCase(), M + padX, y + padY + 6);
    setText(BLACK);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text(wrapped, M + padX, y + padY + labelH + 6);
    y += rowH;
  }

  function chip(text, color, x, yPos, opts = {}) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    const padX = 8, padY = 4;
    const w = doc.getTextWidth(text) + padX * 2;
    const h = 16;
    setFill(color);
    doc.rect(x, yPos - h + 4, w, h, 'F');
    setText(WHITE);
    doc.text(text, x + padX, yPos);
    setText(BLACK);
    return w;
  }

  // ---------- PRE-LOAD logo ----------
  let logoImg = null;
  try { logoImg = await loadImage('assets/kukl-logo.png'); } catch {}

  // ============================================================
  // PAGE 1
  // ============================================================
  drawHeader();
  y = 104;

  // -------- HERO SUMMARY CARD --------
  const heroH = 78;
  setDraw(BLACK);
  doc.setLineWidth(1.2);
  doc.rect(M, y, CW, heroH);
  // left thick accent bar
  setFill(BLACK);
  doc.rect(M, y, 6, heroH, 'F');

  // Customer (big)
  setText(BLACK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  const customerText = dash(rec.customer);
  doc.text(doc.splitTextToSize(customerText, CW - 200)[0], M + 18, y + 26);

  // sub-line: customer ID + address
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  setText(GREY_TEXT);
  const subLine = [rec.customerId, rec.address].filter(Boolean).join('  ·  ') || '—';
  doc.text(doc.splitTextToSize(subLine, CW - 200)[0], M + 18, y + 42);

  // survey id (monospace) + date
  doc.setFont('courier', 'normal');
  doc.setFontSize(8.5);
  setText(BLACK);
  doc.text(rec.id, M + 18, y + 60);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  setText(GREY_TEXT);
  const created = (rec.createdAt || '').replace('T', ' ').slice(0, 19);
  doc.text(`Surveyed: ${created}   ·   Surveyor: ${dash(rec.surveyor)}`, M + 18, y + 72);
  setText(BLACK);

  // chips on the right (condition + priority)
  let chipX = W - M - 10;
  if (rec.priority) {
    const c = PRIO_COLORS[rec.priority] || GREY_TEXT;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
    const tw = doc.getTextWidth(`PRIORITY: ${rec.priority.toUpperCase()}`) + 16;
    chipX -= tw;
    chip(`PRIORITY: ${rec.priority.toUpperCase()}`, c, chipX, y + 28);
    chipX -= 8;
  }
  if (rec.condition) {
    const c = COND_COLORS[rec.condition] || GREY_TEXT;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
    const tw = doc.getTextWidth(`CONDITION: ${rec.condition.toUpperCase()}`) + 16;
    chipX -= tw;
    chip(`CONDITION: ${rec.condition.toUpperCase()}`, c, chipX, y + 28);
  }
  y += heroH + 16;

  // -------- CUSTOMER INFORMATION --------
  _zebra = 0;
  sectionHeader('1. Customer Information');
  kvRow(['Customer Name', rec.customer], ['Customer ID', rec.customerId]);
  kvRow(['Contact', rec.contact], ['Ward No.', rec.ward]);
  fullRow('Address', rec.address);
  kvRow(['Surveyor', rec.surveyor], ['Survey Date', created]);
  y += 10;

  // -------- CONNECTION & METER --------
  _zebra = 0;
  sectionHeader('2. Connection & Meter Details');
  kvRow(['Connection Type', rec.connType], ['Pipe Material', rec.pipeMat]);
  kvRow(['Meter Status', rec.meterStatus], ['Meter Serial No.', rec.meterSerial]);
  kvRow(['Meter Reading', rec.meterReading], ['Pressure (psi)', rec.pressure]);
  kvRow(['Leakage', rec.leakage], ['Supply (hrs/day)', rec.supplyHrs]);
  kvRow(['Condition', rec.condition], ['Priority', rec.priority]);
  y += 10;

  // -------- GPS COORDINATES --------
  _zebra = 0;
  sectionHeader('3. GPS Coordinates');
  if (rec.gps) {
    const g = rec.gps;
    const boxH = 92;
    ensure(boxH + 8);
    setDraw(GREY_LINE);
    doc.setLineWidth(0.6);
    doc.rect(M, y, CW, boxH);

    // Left: coords (monospace)
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    setText(GREY_TEXT);
    doc.text('LATITUDE', M + 12, y + 18);
    doc.text('LONGITUDE', M + 12, y + 48);

    doc.setFont('courier', 'bold');
    doc.setFontSize(14);
    setText(BLACK);
    doc.text(`${g.lat?.toFixed(7)}°`, M + 12, y + 34);
    doc.text(`${g.lng?.toFixed(7)}°`, M + 12, y + 64);

    // Right: accuracy block
    const rx = M + CW / 2 + 8;
    setDraw(GREY_LINE);
    doc.line(M + CW / 2, y + 8, M + CW / 2, y + boxH - 8);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    setText(GREY_TEXT);
    doc.text('ACCURACY', rx, y + 18);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    setText(BLACK);
    doc.text(`± ${g.acc?.toFixed(1) ?? '?'} m`, rx, y + 40);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    setText(GREY_TEXT);
    doc.text(`Best raw: ${g.rawBest?.toFixed?.(2) ?? '—'} m   ·   Samples: ${g.samples ?? '—'}`, rx, y + 54);
    if (g.time) {
      const t = String(g.time).replace('T', ' ').slice(0, 19);
      doc.text(`Captured at: ${t}`, rx, y + 68);
    }
    setText(BLACK);
    y += boxH + 6;

    // Google Maps link
    ensure(20);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    setText(BLUE);
    const mapsUrl = `https://maps.google.com/?q=${g.lat},${g.lng}`;
    doc.textWithLink('▸ OPEN LOCATION IN GOOGLE MAPS', M + 4, y + 10, { url: mapsUrl });
    setText(BLACK);
    y += 22;
  } else {
    ensure(28);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(10);
    setText(GREY_TEXT);
    doc.text('No GPS coordinates recorded for this survey.', M + 4, y + 12);
    setText(BLACK);
    y += 24;
  }
  y += 8;

  // -------- REMARKS --------
  if (rec.remarks && rec.remarks.trim()) {
    _zebra = 0;
    sectionHeader('4. Field Remarks');
    fullRow('Observations', rec.remarks);
    y += 10;
  }

  // -------- PHOTO EVIDENCE --------
  const photos = rec.photos || [];
  if (photos.length) {
    _zebra = 0;
    sectionHeader(`5. Photo Evidence  (${photos.length})`);

    const cols = 2;
    const gap = 12;
    const cellW = (CW - gap) / cols;
    const cellH = cellW * 0.72;
    const captionH = 14;
    const blockH = cellH + captionH;

    let col = 0;
    for (let i = 0; i < photos.length; i++) {
      if (y + blockH > H - 40) {
        doc.addPage();
        drawHeader();
        y = 100;
        sectionHeader(`5. Photo Evidence  (continued)`);
        col = 0;
      }
      const x = M + col * (cellW + gap);
      try {
        const img = await loadImage(photos[i].dataUrl);
        doc.addImage(img, 'JPEG', x, y, cellW, cellH, undefined, 'FAST');
        setDraw(BLACK);
        doc.setLineWidth(0.6);
        doc.rect(x, y, cellW, cellH);
      } catch {}
      // caption
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      setText(GREY_TEXT);
      const ts = photos[i].time ? String(photos[i].time).replace('T', ' ').slice(0, 19) : '';
      doc.text(`PHOTO ${i + 1}${ts ? '  ·  ' + ts : ''}`, x, y + cellH + 10);
      setText(BLACK);

      col++;
      if (col >= cols) { col = 0; y += blockH + 4; }
    }
    if (col !== 0) y += blockH + 4;
  }

  // ---------- Apply footer on every page ----------
  const totalPages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    drawFooter(i, totalPages);
  }

  const safeName = (rec.customer || rec.id).replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40);
  const fileName = `KUKL-Survey-${safeName}-${rec.id.slice(-8)}.pdf`;

  // Mobile-friendly delivery: prefer Web Share API (gives WhatsApp / Email / Save options)
  try {
    const blob = doc.output('blob');
    const file = new File([blob], fileName, { type: 'application/pdf' });

    const canShareFile = navigator.canShare && navigator.canShare({ files: [file] });
    if (canShareFile && /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent)) {
      try {
        await navigator.share({
          files: [file],
          title: `KUKL Survey — ${rec.customer || rec.id}`,
          text: `KUKL Site Survey Report\nSurvey ID: ${rec.id}`,
        });
        toast('PDF shared');
        return;
      } catch (e) {
        // User cancelled or share failed — fall through to direct download
        if (e && e.name !== 'AbortError') console.warn('share failed', e);
      }
    }

    // Fallback: direct download via blob URL (works on desktop + mobile browsers without share)
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 4000);
    toast('PDF downloaded');
  } catch (err) {
    console.warn('PDF blob/share failed, falling back to doc.save()', err);
    doc.save(fileName);
    toast('PDF generated');
  }
}

// Modal PDF button
$('modalPdf')?.addEventListener('click', async () => {
  const idText = $('modalTitle').textContent;
  const rec = await dbGet(idText);
  if (rec) generateSurveyPdf(rec);
});

/* ============================================================
   PWA — service worker registration + install prompt
   ============================================================ */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('Update ready — reload to apply', 3500);
          }
        });
      });
    }).catch(err => console.warn('SW register failed', err));
  });
}

let deferredInstallPrompt = null;
const installBtn = $('btnInstall');

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
}
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

function showInstallInstructions() {
  const ios = isIOS();
  const android = /Android/i.test(navigator.userAgent);
  let msg;
  if (ios) {
    msg = 'To install on iOS:\n\n1. Tap the SHARE button (□↑) in Safari\n2. Scroll down and tap "Add to Home Screen"\n3. Tap ADD';
  } else if (android) {
    msg = 'To install:\n\n1. Tap the ⋮ menu (top-right) in Chrome\n2. Tap "Install app" or "Add to Home screen"\n\nIf you don\'t see it, the app may already be installed, or your browser doesn\'t support PWA install on this site yet (try reloading once or twice).';
  } else {
    msg = 'To install:\n\nLook for the install icon (⊕ or ⤓) in your browser\'s address bar, or open the browser menu and choose "Install app".';
  }
  alert(msg);
}

// Show button unless already installed
if (installBtn) {
  if (!isStandalone()) installBtn.hidden = false;
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (installBtn) installBtn.hidden = false;
});

installBtn?.addEventListener('click', async () => {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') {
      toast('App installed');
      installBtn.hidden = true;
    }
    deferredInstallPrompt = null;
  } else {
    // No native prompt available (iOS, or criteria not yet met) — show guidance.
    showInstallInstructions();
  }
});

window.addEventListener('appinstalled', () => {
  if (installBtn) installBtn.hidden = true;
  toast('App installed');
});



