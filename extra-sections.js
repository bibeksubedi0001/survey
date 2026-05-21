/* KUKL Extra Sections
   Adds four data-collection tabs (Chief Officer, Pipe Leakage, Pressure, Area Survey)
   driven by a shared schema-based form/save/list/export pipeline.

   - Independent IndexedDB: `kukl_extra_db` v1, one object store per section.
   - Reuses existing styles (.card / .form-grid / .field / .btn-*).
   - Photos: base64 data URLs stored in the record (multi-file <input capture>).
   - Location: one-shot geolocation + manual fallback.
   - Export: SheetJS (already loaded for the main app).
*/
(function () {
  'use strict';

  // ---------- IndexedDB ----------
  const DB_NAME = 'kukl_extra_db';
  const DB_VER  = 1;
  const STORES  = ['chief_reports', 'leakage_reports', 'pressure_reports', 'area_reports'];
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        STORES.forEach(name => {
          if (!db.objectStoreNames.contains(name)) {
            const s = db.createObjectStore(name, { keyPath: 'id' });
            s.createIndex('createdAt', 'createdAt');
          }
        });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
    return dbPromise;
  }

  async function dbPut(store, rec) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(rec);
      tx.oncomplete = () => res();
      tx.onerror    = () => rej(tx.error);
    });
  }
  async function dbAll(store) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = () => rej(req.error);
    });
  }
  async function dbDelete(store, id) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(id);
      tx.oncomplete = () => res();
      tx.onerror    = () => rej(tx.error);
    });
  }

  // ---------- Field schemas ----------
  // Field types: text | textarea | number | select | yesno | datetime | location | photos
  // Common props: key, label, required, placeholder, options (for select), unit, full (boolean for full row)

  const SECTIONS = {
    chief: {
      store: 'chief_reports',
      title: 'Chief Officer Field Report',
      idPrefix: 'CHF',
      exportName: 'KUKL_ChiefOfficer_Reports',
      sheetName: 'Chief Officer',
      fields: [
        { key: 'reportedBy', label: 'Reported By *',          type: 'text',     required: true, placeholder: 'Officer name' },
        { key: 'reportedAt', label: 'Date / Time *',          type: 'datetime', required: true },
        { key: 'location',   label: 'Location (Address / Landmark) *', type: 'text', required: true, full: true, placeholder: 'e.g. Baneshwor Chowk, Ward 10' },
        { key: 'gps',        label: 'GPS Coordinates',        type: 'location', full: true },
        { key: 'issue',      label: 'Primary Issue *',        type: 'select',   required: true, options: ['No Water Supply','Low Pressure','Leakage','Pipe Burst','Blockage','Contamination','Meter Fault','Billing Dispute','Illegal Connection','Other'] },
        { key: 'leakage',    label: 'Leakage',                type: 'select',   options: ['None','Minor (drip)','Moderate','Major','Burst'] },
        { key: 'blockage',   label: 'Blockage',               type: 'select',   options: ['None','Partial','Full'] },
        { key: 'supplyStatus',  label: 'Water Supply Status', type: 'select',   options: ['Supplying','Intermittent','Off','Tanker only'] },
        { key: 'billingStatus', label: 'Billing Status',      type: 'select',   options: ['Up to date','1-3 months due','3-6 months due','6+ months due','Disputed','Unknown'] },
        { key: 'meterStatus',   label: 'Meter Reading Status',type: 'select',   options: ['Working','Stopped','Faulty','Missing','Inaccessible','Not Installed'] },
        { key: 'otherIssues', label: 'Any Other Issues',      type: 'textarea', full: true, placeholder: 'Describe any additional observations' },
        { key: 'remarks',     label: 'Remarks',               type: 'textarea', full: true },
        { key: 'photos',      label: 'Photo Capture',         type: 'photos',   full: true },
      ],
    },

    leak: {
      store: 'leakage_reports',
      title: 'Pipe Leakage Survey',
      idPrefix: 'LEK',
      exportName: 'KUKL_Pipe_Leakage_Survey',
      sheetName: 'Pipe Leakage',
      fields: [
        { key: 'reportedBy', label: 'Reported By *',     type: 'text', required: true, placeholder: 'Field officer name' },
        { key: 'reportedAt', label: 'Date Observed *',   type: 'datetime', required: true },
        { key: 'location',   label: 'Location / Landmark *', type: 'text', required: true, full: true, placeholder: 'e.g. New Baneshwor near Everest Hotel' },
        { key: 'gps',        label: 'GPS Coordinates',   type: 'location', full: true },
        { key: 'pipeMaterial', label: 'Pipe Material',   type: 'select', options: ['HDPE','GI','PVC','DI','AC','MS','Unknown'] },
        { key: 'pipeDiameter', label: 'Pipe Diameter (mm)', type: 'number', placeholder: 'e.g. 110' },
        { key: 'leakType',   label: 'Leakage Type',      type: 'select', options: ['Surface visible','Underground','Joint','Valve','Hydrant','Service connection','Saddle','Ferrule'] },
        { key: 'severity',   label: 'Severity',          type: 'select', options: ['Minor (drip)','Moderate','Major','Burst'] },
        { key: 'estLoss',    label: 'Estimated Loss (L/min)', type: 'number', placeholder: 'Approximate' },
        { key: 'soil',       label: 'Soil / Site Condition', type: 'select', options: ['Dry','Wet','Saturated','Flooded'] },
        { key: 'roadType',   label: 'Surface Type',      type: 'select', options: ['Black-topped road','Gravel road','Earthen','Footpath','Private land','Drain'] },
        { key: 'urgency',    label: 'Repair Urgency',    type: 'select', options: ['Immediate','Within 24 hours','Within a week','Routine'] },
        { key: 'remarks',    label: 'Remarks',           type: 'textarea', full: true },
        { key: 'photos',     label: 'Photo Capture',     type: 'photos', full: true },
      ],
    },

    pressure: {
      store: 'pressure_reports',
      title: 'Pressure Measurement',
      idPrefix: 'PRS',
      exportName: 'KUKL_Pressure_Readings',
      sheetName: 'Pressure',
      fields: [
        { key: 'reportedBy', label: 'Measured By *', type: 'text', required: true },
        { key: 'reportedAt', label: 'Date / Time *', type: 'datetime', required: true },
        { key: 'location',   label: 'Location / Landmark *', type: 'text', required: true, full: true },
        { key: 'gps',        label: 'GPS Coordinates', type: 'location', full: true },
        { key: 'dma',        label: 'DMA / Zone', type: 'text', placeholder: 'e.g. 9.1 (OMU 036)' },
        { key: 'point',      label: 'Measurement Point', type: 'select', options: ['Hydrant','Public tap','Bulk meter','House connection','Pipeline tap','Reservoir outlet'] },
        { key: 'pressure',   label: 'Pressure Reading', type: 'number', required: true, placeholder: 'Value' },
        { key: 'unit',       label: 'Unit', type: 'select', options: ['m head','bar','psi','kPa'] },
        { key: 'supply',     label: 'Supply Status at Reading', type: 'select', options: ['Supplying','Off','Intermittent'] },
        { key: 'pipeDiameter', label: 'Pipe Diameter (mm)', type: 'number' },
        { key: 'elevation',  label: 'Elevation (m, optional)', type: 'number' },
        { key: 'remarks',    label: 'Remarks', type: 'textarea', full: true },
        { key: 'photos',     label: 'Photo Capture', type: 'photos', full: true },
      ],
    },

    area: {
      store: 'area_reports',
      title: 'General Survey Area',
      idPrefix: 'ARE',
      exportName: 'KUKL_Area_Survey',
      sheetName: 'Area Survey',
      fields: [
        { key: 'reportedBy', label: 'Surveyor *', type: 'text', required: true },
        { key: 'reportedAt', label: 'Date / Time *', type: 'datetime', required: true },
        { key: 'area',       label: 'Area / Tole *', type: 'text', required: true, placeholder: 'e.g. New Baneshwor' },
        { key: 'ward',       label: 'Ward Number', type: 'number', placeholder: 'e.g. 10' },
        { key: 'dma',        label: 'DMA', type: 'text', placeholder: 'e.g. 9.1' },
        { key: 'gps',        label: 'GPS Coordinates', type: 'location', full: true },
        { key: 'population', label: 'Approx Population', type: 'number' },
        { key: 'households', label: 'No. of Households', type: 'number' },
        { key: 'connections',label: 'Service Connections', type: 'number' },
        { key: 'source',     label: 'Primary Water Source', type: 'select', options: ['Sundarijal','Melamchi','Bagmati','Bishnumati','Manohara','Tube well','Tanker','Mixed','Other'] },
        { key: 'schedule',   label: 'Supply Schedule', type: 'select', options: ['Daily','Alternate days','Twice a week','Once a week','Irregular','None'] },
        { key: 'duration',   label: 'Supply Duration (hrs/day)', type: 'number' },
        { key: 'tank',       label: 'Storage Tank Present', type: 'yesno' },
        { key: 'tankCap',    label: 'Storage Capacity (L)', type: 'number' },
        { key: 'commonIssues', label: 'Common Issues', type: 'textarea', full: true, placeholder: 'e.g. Low pressure during morning, contamination after rain, illegal connections...' },
        { key: 'complaints', label: 'Public Complaint Summary', type: 'textarea', full: true },
        { key: 'remarks',    label: 'Remarks', type: 'textarea', full: true },
        { key: 'photos',     label: 'Photo Capture', type: 'photos', full: true },
      ],
    },
  };

  // ---------- Helpers ----------
  const $ = (id) => document.getElementById(id);
  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k]);
    }
    for (const c of children) {
      if (c == null) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }
  function genId(prefix) {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${prefix}-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${Math.random().toString(36).slice(2,5).toUpperCase()}`;
  }
  function toast(msg) {
    // Reuse main app toast if available, else a tiny inline notice.
    const existing = document.getElementById('extraToast');
    const node = existing || el('div', { id: 'extraToast', style: 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#000;color:#fff;padding:10px 16px;font-size:12px;letter-spacing:1px;z-index:9999;text-transform:uppercase;' });
    node.textContent = msg;
    if (!existing) document.body.appendChild(node);
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { node.remove(); }, 2200);
  }
  function fmtDateTimeInput(d) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function readFileAsDataURL(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(file);
    });
  }

  // ---------- Render a section ----------
  function renderSection(panel, key) {
    const section = SECTIONS[key];
    if (!section) return;

    // Build the form card
    const formGrid = el('div', { class: 'form-grid' });
    section.fields.forEach(f => {
      const fld = el('div', { class: 'field' + (f.full ? ' full' : '') });
      fld.appendChild(el('label', null, f.label));
      const inputId = `${key}_${f.key}`;
      let input;
      switch (f.type) {
        case 'textarea':
          input = el('textarea', { id: inputId, rows: 3, placeholder: f.placeholder || '' });
          break;
        case 'number':
          input = el('input', { id: inputId, type: 'number', step: 'any', placeholder: f.placeholder || '' });
          break;
        case 'datetime':
          input = el('input', { id: inputId, type: 'datetime-local' });
          input.value = fmtDateTimeInput(new Date());
          break;
        case 'select':
          input = el('select', { id: inputId });
          input.appendChild(el('option', { value: '' }, '— select —'));
          (f.options || []).forEach(o => input.appendChild(el('option', { value: o }, o)));
          break;
        case 'yesno':
          input = el('select', { id: inputId });
          ['', 'Yes', 'No'].forEach((o, i) => input.appendChild(el('option', { value: o }, i === 0 ? '— select —' : o)));
          break;
        case 'location':
          input = buildLocationWidget(inputId);
          break;
        case 'photos':
          input = buildPhotosWidget(inputId);
          break;
        default:
          input = el('input', { id: inputId, type: 'text', placeholder: f.placeholder || '' });
      }
      if (f.required && input.tagName !== 'DIV') input.required = true;
      fld.appendChild(input);
      formGrid.appendChild(fld);
    });

    const btnRow = el('div', { class: 'btn-row', style: 'margin-top:12px;' },
      el('button', { type: 'submit', class: 'btn btn-primary' }, 'SAVE REPORT'),
      el('button', { type: 'reset',  class: 'btn btn-outline' }, 'RESET'),
      el('button', { type: 'button', class: 'btn btn-outline', id: `${key}_export` }, 'EXPORT TO EXCEL'),
    );

    const form = el('form', { id: `${key}_form`, autocomplete: 'off' }, formGrid, btnRow);

    const recordsHost = el('div', { id: `${key}_records`, style: 'margin-top:16px;' });

    const card = el('div', { class: 'card' },
      el('h2', { class: 'card-title' }, section.title),
      form,
      el('div', { class: 'hint', id: `${key}_status` }, 'Records: 0'),
      recordsHost,
    );

    panel.innerHTML = '';
    panel.appendChild(card);

    // Wire up
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const rec = collectForm(key);
      const missing = section.fields.filter(f => f.required && !valuePresent(rec[f.key]));
      if (missing.length) { toast('Fill required: ' + missing.map(m => m.label.replace(/\s*\*$/, '')).join(', ')); return; }
      rec.id = genId(section.idPrefix);
      rec.createdAt = new Date().toISOString();
      try {
        await dbPut(section.store, rec);
        toast('Saved');
        form.reset();
        // Re-render dynamic widgets that lose state on reset
        section.fields.forEach(f => {
          if (f.type === 'datetime') { const e2 = $(`${key}_${f.key}`); if (e2) e2.value = fmtDateTimeInput(new Date()); }
          if (f.type === 'location') { const w = $(`${key}_${f.key}`); if (w && w._reset) w._reset(); }
          if (f.type === 'photos')   { const w = $(`${key}_${f.key}`); if (w && w._reset) w._reset(); }
        });
        await refreshRecords(key);
      } catch (err) {
        console.error(err);
        toast('Save failed');
      }
    });

    $(`${key}_export`).addEventListener('click', () => exportSection(key));

    refreshRecords(key);
  }

  function valuePresent(v) {
    if (v == null) return false;
    if (typeof v === 'string') return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return true;
  }

  // ---------- Location widget ----------
  function buildLocationWidget(inputId) {
    const wrap = el('div', { id: inputId, class: 'extra-loc', style: 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;' });
    const latEl = el('input', { type: 'number', step: 'any', placeholder: 'Latitude',  style: 'flex:1 1 140px;min-width:120px;' });
    const lngEl = el('input', { type: 'number', step: 'any', placeholder: 'Longitude', style: 'flex:1 1 140px;min-width:120px;' });
    const accEl = el('span',  { class: 'hint', style: 'flex:1 1 100%;font-size:11px;' }, 'No GPS yet');
    const btn   = el('button', { type: 'button', class: 'btn btn-outline', style: 'flex:0 0 auto;' }, 'USE MY LOCATION');
    btn.addEventListener('click', () => {
      if (!navigator.geolocation) { toast('Geolocation not supported'); return; }
      btn.disabled = true; btn.textContent = 'LOCATING…';
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          latEl.value = pos.coords.latitude.toFixed(7);
          lngEl.value = pos.coords.longitude.toFixed(7);
          accEl.textContent = `Accuracy ±${pos.coords.accuracy.toFixed(1)} m`;
          btn.disabled = false; btn.textContent = 'UPDATE LOCATION';
        },
        (err) => {
          accEl.textContent = 'GPS error: ' + err.message;
          btn.disabled = false; btn.textContent = 'USE MY LOCATION';
        },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
      );
    });
    wrap.appendChild(latEl); wrap.appendChild(lngEl); wrap.appendChild(btn); wrap.appendChild(accEl);
    wrap._collect = () => {
      const lat = parseFloat(latEl.value);
      const lng = parseFloat(lngEl.value);
      if (!isFinite(lat) || !isFinite(lng)) return null;
      const accMatch = /±([0-9.]+)/.exec(accEl.textContent || '');
      return { lat, lng, acc: accMatch ? parseFloat(accMatch[1]) : null };
    };
    wrap._reset = () => { latEl.value = ''; lngEl.value = ''; accEl.textContent = 'No GPS yet'; btn.textContent = 'USE MY LOCATION'; };
    return wrap;
  }

  // ---------- Photos widget ----------
  function buildPhotosWidget(inputId) {
    const wrap  = el('div', { id: inputId, class: 'extra-photos' });
    const file  = el('input', { type: 'file', accept: 'image/*', multiple: '', capture: 'environment', style: 'display:none;' });
    const btn   = el('button', { type: 'button', class: 'btn btn-outline' }, 'ADD PHOTOS');
    const strip = el('div', { class: 'thumb-strip', style: 'margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;' });
    const empty = el('div', { class: 'thumb-empty', style: 'font-size:11px;letter-spacing:1px;color:#666;text-transform:uppercase;' }, 'No photos yet');
    strip.appendChild(empty);

    const photos = [];
    function rerender() {
      strip.innerHTML = '';
      if (!photos.length) { strip.appendChild(empty); return; }
      photos.forEach((p, idx) => {
        const cell = el('div', { style: 'position:relative;' });
        const img = el('img', { src: p.dataUrl, style: 'width:80px;height:80px;object-fit:cover;border:1px solid #000;' });
        const x   = el('button', { type: 'button', title: 'Remove', style: 'position:absolute;top:-6px;right:-6px;width:20px;height:20px;border:1px solid #000;background:#fff;font-size:12px;line-height:1;cursor:pointer;' }, '×');
        x.addEventListener('click', () => { photos.splice(idx, 1); rerender(); });
        cell.appendChild(img); cell.appendChild(x);
        strip.appendChild(cell);
      });
    }
    btn.addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      for (const f of file.files) {
        if (!/^image\//.test(f.type)) continue;
        try {
          const dataUrl = await readFileAsDataURL(f);
          photos.push({ id: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2,6), dataUrl, time: new Date().toISOString(), name: f.name });
        } catch (e) { console.error(e); }
      }
      file.value = '';
      rerender();
    });
    wrap.appendChild(btn); wrap.appendChild(file); wrap.appendChild(strip);
    wrap._collect = () => photos.slice();
    wrap._reset   = () => { photos.length = 0; rerender(); };
    return wrap;
  }

  // ---------- Collect / list / export ----------
  function collectForm(key) {
    const section = SECTIONS[key];
    const rec = {};
    section.fields.forEach(f => {
      const node = $(`${key}_${f.key}`);
      if (!node) return;
      if (f.type === 'location' || f.type === 'photos') {
        rec[f.key] = node._collect ? node._collect() : null;
      } else if (f.type === 'number') {
        const v = node.value;
        rec[f.key] = v === '' ? null : Number(v);
      } else if (f.type === 'datetime') {
        rec[f.key] = node.value || '';
      } else {
        rec[f.key] = (node.value || '').toString().trim();
      }
    });
    return rec;
  }

  async function refreshRecords(key) {
    const section = SECTIONS[key];
    const host = $(`${key}_records`);
    const status = $(`${key}_status`);
    if (!host) return;
    const all = (await dbAll(section.store)).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    status.textContent = `Records: ${all.length}`;
    host.innerHTML = '';
    if (!all.length) return;

    const table = el('table', { class: 'records-table', style: 'width:100%;border-collapse:collapse;font-size:12px;' });
    const thead = el('thead');
    thead.appendChild(el('tr', null,
      el('th', { style: thStyle() }, 'ID'),
      el('th', { style: thStyle() }, 'Date/Time'),
      el('th', { style: thStyle() }, summaryLabel(key)),
      el('th', { style: thStyle() }, 'Photos'),
      el('th', { style: thStyle() }, ''),
    ));
    table.appendChild(thead);
    const tbody = el('tbody');
    all.forEach(r => {
      const tr = el('tr');
      tr.appendChild(el('td', { style: tdStyle() }, r.id));
      tr.appendChild(el('td', { style: tdStyle() }, (r.createdAt || '').replace('T', ' ').slice(0, 19)));
      tr.appendChild(el('td', { style: tdStyle() }, summaryValue(key, r)));
      tr.appendChild(el('td', { style: tdStyle() }, String((r.photos || []).length)));
      const delBtn = el('button', { type: 'button', class: 'btn btn-outline', style: 'padding:4px 8px;font-size:11px;' }, 'DELETE');
      delBtn.addEventListener('click', async () => {
        if (!confirm('Delete this record?')) return;
        await dbDelete(section.store, r.id);
        await refreshRecords(key);
      });
      tr.appendChild(el('td', { style: tdStyle() }, delBtn));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    host.appendChild(table);
  }
  function thStyle() { return 'border:1px solid #000;padding:6px 8px;background:#000;color:#fff;text-align:left;font-size:11px;letter-spacing:1px;text-transform:uppercase;'; }
  function tdStyle() { return 'border:1px solid #000;padding:6px 8px;vertical-align:top;'; }

  function summaryLabel(key) {
    return ({ chief: 'Location / Issue', leak: 'Location / Severity', pressure: 'Location / Reading', area: 'Area / Ward' })[key] || 'Summary';
  }
  function summaryValue(key, r) {
    if (key === 'chief')    return `${r.location || ''} — ${r.issue || ''}`;
    if (key === 'leak')     return `${r.location || ''} — ${r.severity || ''}`;
    if (key === 'pressure') return `${r.location || ''} — ${r.pressure ?? ''} ${r.unit || ''}`;
    if (key === 'area')     return `${r.area || ''}${r.ward ? ' / Ward ' + r.ward : ''}`;
    return '';
  }

  async function exportSection(key) {
    if (typeof XLSX === 'undefined') { toast('XLSX library not loaded'); return; }
    const section = SECTIONS[key];
    const all = await dbAll(section.store);
    if (!all.length) { toast('No records to export'); return; }

    const rows = all.map((r, i) => {
      const out = { '#': i + 1, 'ID': r.id, 'Saved At': (r.createdAt || '').replace('T', ' ').slice(0, 19) };
      section.fields.forEach(f => {
        if (f.type === 'photos') { out['Photos'] = (r[f.key] || []).length; return; }
        if (f.type === 'location') {
          const g = r[f.key];
          out['Latitude']  = g && isFinite(g.lat) ? g.lat : '';
          out['Longitude'] = g && isFinite(g.lng) ? g.lng : '';
          out['GPS Accuracy (m)'] = g && g.acc != null ? g.acc : '';
          out['Maps Link'] = g && isFinite(g.lat) ? `https://maps.google.com/?q=${g.lat},${g.lng}` : '';
          return;
        }
        out[stripStar(f.label)] = r[f.key] == null ? '' : r[f.key];
      });
      return out;
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    const keys = Object.keys(rows[0]);
    ws['!cols'] = keys.map(k => ({ wch: Math.min(40, Math.max(k.length, ...rows.map(r => String(r[k] ?? '').length))) + 2 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, section.sheetName);
    const fname = `${section.exportName}_${new Date().toISOString().slice(0,10)}.xlsx`;
    XLSX.writeFile(wb, fname);
    toast('Excel exported');
  }
  function stripStar(s) { return (s || '').replace(/\s*\*$/, ''); }

  // ---------- Init ----------
  function init() {
    document.querySelectorAll('[data-extra-section]').forEach(panel => {
      const key = panel.getAttribute('data-extra-section');
      if (!key || !SECTIONS[key]) return;
      // Lazy-render the first time the panel becomes active (or now if already active)
      if (panel.classList.contains('active') && !panel._extraRendered) {
        panel._extraRendered = true;
        renderSection(panel, key);
      }
    });
    // Hook tab clicks to render on demand
    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.tab;
        const panel = document.getElementById('tab-' + key);
        if (panel && panel.hasAttribute('data-extra-section') && !panel._extraRendered) {
          panel._extraRendered = true;
          renderSection(panel, key);
        }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for debugging
  window.KUKLExtra = { SECTIONS, dbAll, dbPut, dbDelete, openDB };
})();
