/* NRW Baishakh Report Builder
 * Mirrors the Python pipeline used to generate 9.1_baisakh.xlsx:
 *   - reads customer reading workbook + SCADA workbook
 *   - inserts billable consumption column (cons===0 → 5, else cons as-is)
 *   - appends grand-total row, daily SCADA block, and meter-status summary
 * Requires SheetJS (XLSX) loaded globally.
 */
(function () {
  'use strict';

  const STATUS_TEMPLATE = [
    [1,  'Door Lock'],
    [2,  'Meter Block'],
    [3,  'Meter Burried'],
    [4,  'Meter Damaged'],
    [5,  'House not found'],
    [6,  'No Water Supply'],
    [7,  'Meter Removed(No Meter)'],
    [8,  'Low Water Supply'],
    [9,  'Dog Presence'],
    [10, 'Meter Sheild Broken'],
    [11, 'Temporary hole block'],
    [12, 'Permanent hole block'],
    [13, 'Service Line disconnect'],
    [14, 'House Collapse(Earthquake)'],
    [15, 'Unmetered'],
    [16, 'Reading'],
    [17, 'No Reading'],
    [18, 'Dual Record'],
    [19, 'PID'],
    [56, 'Self Reading'],
    [76, 'Access Billing'],
  ];

  // ---------- SheetJS helpers ----------
  function getCell(ws, r, c) {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    return cell ? cell.v : undefined;
  }
  function setCell(ws, r, c, value, opts) {
    const ref = XLSX.utils.encode_cell({ r, c });
    if (value === null || value === undefined || value === '') {
      delete ws[ref];
      return;
    }
    let t;
    if (value instanceof Date) t = 'd';
    else if (typeof value === 'number') t = 'n';
    else if (typeof value === 'boolean') t = 'b';
    else t = 's';
    const cell = { t, v: value };
    if (t === 'd') cell.z = (opts && opts.fmt) || 'yyyy-mm-dd';
    if (opts && opts.bold) {
      // SheetJS community edition strips styles on save; harmless to set anyway.
      cell.s = { font: { bold: true } };
    }
    ws[ref] = cell;
  }
  function extendRange(ws, lastRow, lastCol) {
    const cur = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref'])
                           : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
    cur.s.r = Math.min(cur.s.r, 0);
    cur.s.c = Math.min(cur.s.c, 0);
    cur.e.r = Math.max(cur.e.r, lastRow);
    cur.e.c = Math.max(cur.e.c, lastCol);
    ws['!ref'] = XLSX.utils.encode_range(cur);
  }
  function insertColumn(ws, c0) {
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let c = range.e.c; c >= c0; c--) {
      for (let r = range.s.r; r <= range.e.r; r++) {
        const oldRef = XLSX.utils.encode_cell({ r, c });
        const newRef = XLSX.utils.encode_cell({ r, c: c + 1 });
        if (ws[oldRef]) {
          ws[newRef] = ws[oldRef];
          delete ws[oldRef];
        } else {
          delete ws[newRef];
        }
      }
    }
    range.e.c += 1;
    ws['!ref'] = XLSX.utils.encode_range(range);
  }

  // ---------- File I/O ----------
  async function readWorkbook(file) {
    const buf = await file.arrayBuffer();
    // cellDates:false — keep dates as Excel serials to avoid timezone drift.
    return XLSX.read(buf, { type: 'array', cellDates: false });
  }

  // Calendar-day key from an Excel serial number (1900 date system).
  // Uses XLSX.SSF.parse_date_code so no timezone math is involved.
  function serialToYMD(serial) {
    if (typeof serial !== 'number') return null;
    const p = XLSX.SSF.parse_date_code(serial);
    if (!p) return null;
    return { y: p.y, m: p.m, d: p.d };
  }
  function ymdKey({ y, m, d }) { return y * 10000 + m * 100 + d; }
  function dateToKey(date) {
    return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
  }
  // Excel 1900 date system serial. Treats ymd as a calendar date with no TZ.
  function ymdToSerial({ y, m, d }) {
    const epoch = Date.UTC(1899, 11, 30); // 1899-12-30
    const target = Date.UTC(y, m - 1, d);
    return Math.round((target - epoch) / 86400000);
  }
  function setDateYMD(ws, r, c, ymd, opts) {
    const ref = XLSX.utils.encode_cell({ r, c });
    const cell = { t: 'n', v: ymdToSerial(ymd), z: (opts && opts.fmt) || 'yyyy-mm-dd' };
    if (opts && opts.bold) cell.s = { font: { bold: true } };
    ws[ref] = cell;
  }

  function findDmaCol(sheet, dma, headerRow) {
    // headerRow is 0-based (typically 7 for Excel row 8)
    const target = dma.trim().toLowerCase();
    const range = XLSX.utils.decode_range(sheet['!ref']);
    for (let c = 0; c <= range.e.c; c++) {
      const v = getCell(sheet, headerRow, c);
      if (typeof v !== 'string') continue;
      const s = v.trim().toLowerCase();
      if (s === target ||
          s.startsWith(target + ' ') ||
          s.startsWith(target + '(')) {
        return c;
      }
    }
    return -1;
  }

  function collectDailyForRange(sheet, dmaCol, startDate, endDate) {
    const out = [];
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const startKey = dateToKey(startDate);
    const endKey   = dateToKey(endDate);
    // Data rows start at row index 8 (Excel row 9). Date is col 0.
    for (let r = 8; r <= range.e.r; r++) {
      const raw = getCell(sheet, r, 0);
      if (typeof raw !== 'number') continue;       // dates kept as Excel serials
      const ymd = serialToYMD(raw);
      if (!ymd) continue;
      const k = ymdKey(ymd);
      if (k < startKey || k > endKey) continue;
      const v = getCell(sheet, r, dmaCol);
      out.push([ymd, typeof v === 'number' ? v : 0]);
    }
    return out;
  }

  // ---------- Core build ----------
  // Pure compute: parses inputs, builds modified workbook + structured summary.
  // Does NOT write any file. Caller decides whether to download.
  async function computeReport({ customerFile, scadaFile, dmaName, dateStart, dateEnd }) {
    if (!customerFile) throw new Error('Customer reading file is required.');
    if (!scadaFile)    throw new Error('SCADA workbook is required.');
    if (!dmaName || !dmaName.trim()) throw new Error('DMA name is required (e.g. "9.1").');
    if (!(dateStart instanceof Date) || !(dateEnd instanceof Date) || dateStart > dateEnd) {
      throw new Error('Invalid date range.');
    }
    dmaName = dmaName.trim();

    const custWB  = await readWorkbook(customerFile);
    const scadaWB = await readWorkbook(scadaFile);

    const wsName = custWB.SheetNames[0];
    const ws = custWB.Sheets[wsName];
    if (!ws || !ws['!ref']) throw new Error('Customer sheet is empty.');
    const initialRange = XLSX.utils.decode_range(ws['!ref']);

    // Find last data row
    let last = initialRange.e.r;
    while (last > 0) {
      let any = false;
      for (let c = 0; c <= initialRange.e.c; c++) {
        const v = getCell(ws, last, c);
        if (v !== undefined && v !== null && v !== '') { any = true; break; }
      }
      if (any) break;
      last--;
    }

    // Column layout for source customer sheet (0-based)
    const CONS_COL = 9;   // J - Consumption

    // Insert blank "Billable" column at K (index 10); pushes Observation, Gis(Bill), Gis(C) right.
    insertColumn(ws, 10);
    const BILL_COL = 10;
    const OBS_COL  = 11;

    // Populate billable + aggregate totals + observation counts
    let totalCons = 0;
    let totalBill = 0;
    const counts = new Map();
    for (let r = 1; r <= last; r++) {
      const cons = getCell(ws, r, CONS_COL);
      let bill;
      if (typeof cons === 'number') {
        // Only consumption of exactly 0 is bumped to the minimum billable (5).
        // Values 1-4 are billed as-is (do NOT round up to 5).
        bill = cons === 0 ? 5 : cons;
        totalCons += cons;
        totalBill += bill;
      } else {
        // Blank / non-numeric consumption still bills the minimum (5); include it
        // in the grand total so the column sum matches the printed total row.
        bill = 5;
        totalBill += 5;
      }
      setCell(ws, r, BILL_COL, bill);

      const obs = getCell(ws, r, OBS_COL);
      if (obs !== undefined && obs !== null && String(obs).trim() !== '') {
        const key = String(obs).trim();
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }

    // Grand-total row immediately after last customer
    const totalRow = last + 1;
    setCell(ws, totalRow, 8, 'Total', { bold: true });
    setCell(ws, totalRow, CONS_COL, totalCons, { bold: true });
    setCell(ws, totalRow, BILL_COL, totalBill, { bold: true });
    extendRange(ws, totalRow, OBS_COL);

    // ---------- SCADA extraction ----------
    // Sheet-name independent: scan every sheet, read its date column (col 0,
    // rows 9+) and the DMA column (header row 8), and keep the daily values
    // whose date falls inside [dateStart, dateEnd]. The calendar month comes
    // from the data itself, so this works whether sheets are named by month
    // ("April"/"May ") or generically ("OMU - Volumes"). A trailing "Total"
    // row is ignored automatically because its date cell is not numeric.
    const ds = new Date(dateStart.getFullYear(), dateStart.getMonth(), dateStart.getDate());
    const de = new Date(dateEnd.getFullYear(),   dateEnd.getMonth(),   dateEnd.getDate());

    const byDay = new Map();   // dateKey -> [ymd, value]; first sheet to supply a day wins
    let headerSheet = null;
    let headerCol   = -1;

    for (const sheetName of scadaWB.SheetNames) {
      const sheet = scadaWB.Sheets[sheetName];
      if (!sheet || !sheet['!ref']) continue;
      const dmaCol = findDmaCol(sheet, dmaName, 7);
      if (dmaCol < 0) continue;
      if (headerSheet === null) { headerSheet = sheet; headerCol = dmaCol; }
      for (const entry of collectDailyForRange(sheet, dmaCol, ds, de)) {
        const k = ymdKey(entry[0]);
        if (!byDay.has(k)) byDay.set(k, entry);
      }
    }

    if (headerSheet === null) {
      throw new Error(`DMA "${dmaName}" not found in any SCADA sheet (DMA names are read from row 8).`);
    }

    // chronological order
    const daily = [...byDay.values()].sort((a, b) => ymdKey(a[0]) - ymdKey(b[0]));

    const dailyTotal = daily.reduce((s, [, v]) => s + (v || 0), 0);

    // DMA header label (e.g. "9.1 (OMU 036)")
    const dmaLabel = (getCell(headerSheet, 7, headerCol) || dmaName).toString();

    // ---------- Daily SCADA block ----------
    const hdr = totalRow + 2; // one blank gap row between total and header

    setCell(ws, hdr, 4, 'Day',            { bold: true });
    setCell(ws, hdr, 5, dmaLabel,         { bold: true });
    setCell(ws, hdr, 8, 'ID',             { bold: true });
    setCell(ws, hdr, 9, 'Meter Status',   { bold: true });

    for (let i = 0; i < daily.length; i++) {
      const r = hdr + 1 + i;
      const [ymd, v] = daily[i];
      setDateYMD(ws, r, 4, ymd);
      setCell(ws, r, 5, v);
    }
    const dateTotalRow = hdr + 1 + daily.length;
    setCell(ws, dateTotalRow, 4, 'Total', { bold: true });
    setCell(ws, dateTotalRow, 5, dailyTotal, { bold: true });

    // Meter-status table in cols I, J, K (rows hdr+1 ..)
    let statusTotal = 0;
    for (let i = 0; i < STATUS_TEMPLATE.length; i++) {
      const [sid, name] = STATUS_TEMPLATE[i];
      const r = hdr + 1 + i;
      setCell(ws, r, 8, sid);
      setCell(ws, r, 9, name);
      const cnt = counts.get(name) || 0;
      setCell(ws, r, 10, cnt);
      statusTotal += cnt;
    }
    const statusTotalRow = hdr + 1 + STATUS_TEMPLATE.length;
    setCell(ws, statusTotalRow, 9, 'Total ',     { bold: true });
    setCell(ws, statusTotalRow, 10, statusTotal, { bold: true });

    extendRange(ws, Math.max(dateTotalRow, statusTotalRow), 13);

    // Detect observations that didn't map into our template (informational only)
    const mappedSet = new Set(STATUS_TEMPLATE.map(t => t[1]));
    const unmapped = {};
    for (const [k, v] of counts.entries()) {
      if (!mappedSet.has(k)) unmapped[k] = v;
    }

    return {
      wb: custWB,
      summary: {
        sheet: wsName,
        customerCount: last,             // rows 2..(last+1) in 1-based Excel
        totalCons,
        totalBill,
        daily,                           // [[{y,m,d}, value], ...]
        dailyCount: daily.length,
        dailyTotal,
        status: STATUS_TEMPLATE.map(([id, name]) => ({ id, name, count: counts.get(name) || 0 })),
        statusTotal,
        nrwVolume: dailyTotal - totalBill,
        nrwPercent: dailyTotal > 0 ? ((dailyTotal - totalBill) / dailyTotal) * 100 : null,
        unmapped,
        dmaLabel,
      },
    };
  }

  // Thin wrapper: compute + download.
  async function buildReport(opts) {
    const { wb, summary } = await computeReport(opts);
    XLSX.writeFile(wb, opts.outputName);
    return summary;
  }

  // ---------- UI wiring ----------
  function $(id) { return document.getElementById(id); }

  function detectDmaFromName(name) {
    // Strip extension and extract leading dotted-numeric pattern, e.g. "9.1" or "4.1.2"
    const base = name.replace(/\.[^./\\]+$/, '');
    const m = base.match(/(\d+(?:\.\d+)+)/);
    return m ? m[1] : '';
  }

  function parseDateInput(value) {
    if (!value) return null;
    const [y, m, d] = value.split('-').map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
  }

  function log(msg, isError) {
    const el = $('nrwLog');
    if (!el) return;
    el.style.color = isError ? '#a8001a' : '';
    el.textContent = msg;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function fmtNum(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '0';
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  function ymdToISO(y) {
    const pad = (v) => String(v).padStart(2, '0');
    return y.y + '-' + pad(y.m) + '-' + pad(y.d);
  }

  function fileFingerprint(f) {
    return f ? (f.name + '|' + f.size + '|' + f.lastModified) : '';
  }

  function renderPreview(host, summary) {
    if (!host) return;
    const s = summary;
    const dailyRows = s.daily.map(([ymd, v]) =>
      `<tr><td>${ymdToISO(ymd)}</td><td class="num">${fmtNum(v)}</td></tr>`
    ).join('');
    const statusRows = s.status.map(row =>
      `<tr><td class="num">${row.id}</td><td>${escapeHtml(row.name)}</td><td class="num">${fmtNum(row.count)}</td></tr>`
    ).join('');
    const unmappedKeys = Object.keys(s.unmapped || {});
    const unmappedHtml = unmappedKeys.length
      ? `<div class="nrw-unmapped"><h4>Unmapped observations (not counted in status table)</h4><ul>${
          unmappedKeys.map(k => `<li><b>${escapeHtml(k)}</b>: ${fmtNum(s.unmapped[k])}</li>`).join('')
        }</ul></div>`
      : '';

    const nrwPctText = (s.nrwPercent == null) ? '—' : (s.nrwPercent.toFixed(2) + '%');
    const nrwCls = (s.nrwPercent == null) ? 'nrw-kpi-neutral'
                 : (s.nrwPercent >= 40 ? 'nrw-kpi-bad'
                 : (s.nrwPercent >= 25 ? 'nrw-kpi-warn' : 'nrw-kpi-good'));

    host.innerHTML =
      `<div class="nrw-preview">
        <h3>Summary preview &mdash; ${escapeHtml(s.dmaLabel)}</h3>
        <div class="nrw-kpis">
          <div class="nrw-kpi"><span>Customer rows</span><b>${fmtNum(s.customerCount)}</b></div>
          <div class="nrw-kpi"><span>Total consumption</span><b>${fmtNum(s.totalCons)}</b></div>
          <div class="nrw-kpi"><span>Total billable</span><b>${fmtNum(s.totalBill)}</b></div>
          <div class="nrw-kpi"><span>Daily SCADA total</span><b>${fmtNum(s.dailyTotal)}</b><i>${fmtNum(s.dailyCount)} days</i></div>
          <div class="nrw-kpi"><span>Meter-status total</span><b>${fmtNum(s.statusTotal)}</b></div>
          <div class="nrw-kpi nrw-kpi-hl ${nrwCls}"><span>NRW %</span><b>${nrwPctText}</b><i>NRW vol: ${fmtNum(s.nrwVolume)}</i></div>
        </div>
        <div class="nrw-tables">
          <div class="nrw-table-wrap">
            <h4>Daily SCADA &mdash; ${escapeHtml(s.dmaLabel)}</h4>
            <div class="nrw-scroll">
              <table class="nrw-tbl">
                <thead><tr><th>Day</th><th class="num">${escapeHtml(s.dmaLabel)}</th></tr></thead>
                <tbody>${dailyRows || '<tr><td colspan="2" class="muted">No SCADA data in range.</td></tr>'}</tbody>
                <tfoot><tr><th>Total</th><th class="num">${fmtNum(s.dailyTotal)}</th></tr></tfoot>
              </table>
            </div>
          </div>
          <div class="nrw-table-wrap">
            <h4>Meter Status Summary</h4>
            <div class="nrw-scroll">
              <table class="nrw-tbl">
                <thead><tr><th class="num">ID</th><th>Meter Status</th><th class="num">Count</th></tr></thead>
                <tbody>${statusRows}</tbody>
                <tfoot><tr><th colspan="2">Total</th><th class="num">${fmtNum(s.statusTotal)}</th></tr></tfoot>
              </table>
            </div>
          </div>
        </div>
        ${unmappedHtml}
      </div>`;
  }

  function init() {
    const custIn   = $('nrwCustFile');
    const scadaIn  = $('nrwScadaFile');
    const dmaIn    = $('nrwDma');
    const outIn    = $('nrwOut');
    const startIn  = $('nrwStart');
    const endIn    = $('nrwEnd');
    const genBtn   = $('nrwGenerate');
    const resetBtn = $('nrwReset');
    const preview  = $('nrwPreview');
    if (!custIn || !genBtn) return; // tab not on this page

    // Auto-preview state
    let lastFingerprint = '';
    let cached = null;        // { wb, summary, fingerprint }
    let previewRunId = 0;     // guards out-of-order async results

    function currentFingerprint() {
      return [
        fileFingerprint(custIn.files && custIn.files[0]),
        fileFingerprint(scadaIn.files && scadaIn.files[0]),
        (dmaIn.value || '').trim(),
        startIn.value, endIn.value,
      ].join('::');
    }

    async function refreshPreview() {
      if (!preview) return;
      const cf = custIn.files && custIn.files[0];
      const sf = scadaIn.files && scadaIn.files[0];
      const dma = (dmaIn.value || '').trim();
      const ds = parseDateInput(startIn.value);
      const de = parseDateInput(endIn.value);
      if (!cf || !sf || !dma || !ds || !de || ds > de) {
        preview.innerHTML = '';
        cached = null;
        lastFingerprint = '';
        return;
      }
      const fp = currentFingerprint();
      if (fp === lastFingerprint) return;
      lastFingerprint = fp;
      const myRun = ++previewRunId;

      preview.innerHTML = '<div class="nrw-preview"><p class="hint">Building preview…</p></div>';
      try {
        const result = await computeReport({
          customerFile: cf, scadaFile: sf, dmaName: dma,
          dateStart: ds, dateEnd: de,
        });
        if (myRun !== previewRunId) return; // superseded
        cached = { wb: result.wb, summary: result.summary, fingerprint: fp };
        renderPreview(preview, result.summary);
        log('Preview ready. Click GENERATE REPORT to download the .xlsx.');
      } catch (err) {
        if (myRun !== previewRunId) return;
        cached = null;
        preview.innerHTML = '';
        log('Preview failed: ' + (err && err.message ? err.message : String(err)), true);
      }
    }

    // Trigger preview on any input change
    [custIn, scadaIn, dmaIn, startIn, endIn].forEach(el => {
      el.addEventListener('change', refreshPreview);
      el.addEventListener('input',  refreshPreview);
    });

    custIn.addEventListener('change', () => {
      const f = custIn.files && custIn.files[0];
      if (!f) return;
      const dma = detectDmaFromName(f.name);
      if (dma && !dmaIn.value.trim()) dmaIn.value = dma;
      if (!outIn.value.trim()) {
        outIn.value = (dma || 'dma') + '_baisakh.xlsx';
      }
      refreshPreview();
    });

    resetBtn && resetBtn.addEventListener('click', () => {
      custIn.value = '';
      scadaIn.value = '';
      dmaIn.value = '';
      outIn.value = '';
      cached = null;
      lastFingerprint = '';
      if (preview) preview.innerHTML = '';
      log('Select both files to begin.');
    });

    genBtn.addEventListener('click', async () => {
      if (typeof XLSX === 'undefined') {
        log('Excel library (SheetJS) is not loaded. Refresh the page and try again.', true);
        return;
      }
      const customerFile = custIn.files && custIn.files[0];
      const scadaFile    = scadaIn.files && scadaIn.files[0];
      const dmaName      = (dmaIn.value || '').trim();
      const dateStart    = parseDateInput(startIn.value);
      const dateEnd      = parseDateInput(endIn.value);
      let outputName     = (outIn.value || '').trim();
      if (!outputName) {
        outputName = (dmaName || 'dma') + '_baisakh.xlsx';
      } else if (!/\.xlsx$/i.test(outputName)) {
        outputName += '.xlsx';
      }

      genBtn.disabled = true;
      log('Building report…');
      try {
        let stats;
        const fp = currentFingerprint();
        if (cached && cached.fingerprint === fp) {
          XLSX.writeFile(cached.wb, outputName);
          stats = cached.summary;
        } else {
          stats = await buildReport({
            customerFile, scadaFile, dmaName,
            dateStart, dateEnd, outputName,
          });
        }
        const lines = [
          `Saved: ${outputName}`,
          `DMA: ${stats.dmaLabel}`,
          `Customer rows: ${stats.customerCount}`,
          `Total consumption: ${stats.totalCons}    Total billable: ${stats.totalBill}`,
          `Daily SCADA entries: ${stats.dailyCount}    Sum: ${stats.dailyTotal}`,
          `NRW volume: ${stats.nrwVolume}    NRW %: ${stats.nrwPercent == null ? '—' : stats.nrwPercent.toFixed(2) + '%'}`,
          `Meter-status total: ${stats.statusTotal}`,
        ];
        if (stats.unmapped && Object.keys(stats.unmapped).length) {
          lines.push('Unmapped observations (not counted in status table):');
          for (const k of Object.keys(stats.unmapped)) {
            lines.push(`  • ${k}: ${stats.unmapped[k]}`);
          }
        }
        log(lines.join('\n'));
        // After download the cached wb has been written; invalidate so re-clicking recomputes
        cached = null;
        lastFingerprint = '';
      } catch (err) {
        console.error(err);
        log('Error: ' + (err && err.message ? err.message : String(err)), true);
      } finally {
        genBtn.disabled = false;
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for testing / debugging
  window.NRWBuilder = { buildReport, computeReport };
})();
