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
      stopGpsWatch('GPS error: ' + err.message);
      toast('GPS error: ' + err.message, 3500);
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 }
  );
});

// ---------- Camera ----------
const video = $('video');
const canvas = $('canvas');
const camOverlay = $('camOverlay');

async function startCamera() {
  try {
    stopCamera();
    const constraints = {
      video: { facingMode: state.facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    };
    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = state.stream;
    camOverlay.classList.add('hidden');
    $('btnSnap').disabled = false;
    $('btnStopCam').disabled = false;
    $('btnSwitchCam').disabled = false;
    $('btnStartCam').disabled = true;
  } catch (e) {
    toast('Camera error: ' + e.message, 3500);
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
function snapPhoto() {
  if (!state.stream) { toast('Camera not started'); return; }
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) { toast('Camera not ready'); return; }
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

  const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
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
    div.querySelector('img').addEventListener('click', () => openImageModal(p.dataUrl));
    strip.appendChild(div);
  });
}
function openImageModal(src) {
  $('modalTitle').textContent = 'Photo';
  $('modalBody').innerHTML = `<img src="${src}" style="max-width:100%;border:2px solid #000;">`;
  $('modal').hidden = false;
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
    reader.onload = () => addPhoto(reader.result);
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
    const photos = (r.photos || []).slice(0, 3).map(p => `<img src="${p.dataUrl}">`).join('');
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
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function handleRowAction(act, id) {
  const rec = await dbGet(id);
  if (!rec) return;
  if (act === 'view') showRecordModal(rec);
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
  const photos = (r.photos || []).map(p => `<img src="${p.dataUrl}" alt="">`).join('');
  $('modalBody').innerHTML = kv + (photos ? `<div class="modal-photos">${photos}</div>` : '');
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

// ---------- Map Tab ----------
async function renderMap() {
  const grid = $('mapGrid');
  const all = (await dbAll()).filter(r => r.gps);
  if (!all.length) {
    grid.innerHTML = '<div class="empty-state">No locations captured yet.</div>';
    return;
  }
  grid.innerHTML = all.map(r => `
    <div class="map-card">
      <h4>${escapeHtml(r.customer || r.id)}</h4>
      <div class="meta">${escapeHtml(r.address || '')}</div>
      <div class="coord">LAT ${r.gps.lat.toFixed(7)}</div>
      <div class="coord">LNG ${r.gps.lng.toFixed(7)}</div>
      <div class="meta">Accuracy: ${r.gps.acc?.toFixed?.(2) ?? '—'} m  ·  ${r.gps.samples ?? '—'} samples</div>
      <a href="https://maps.google.com/?q=${r.gps.lat},${r.gps.lng}" target="_blank" rel="noopener">OPEN IN GOOGLE MAPS ↗</a>
    </div>
  `).join('');
}

$('btnOpenGmaps').addEventListener('click', async () => {
  const all = (await dbAll()).filter(r => r.gps);
  if (!all.length) { toast('No locations'); return; }
  // Open first; opening many tabs is usually blocked by browsers.
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

