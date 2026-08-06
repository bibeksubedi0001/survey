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

  // ---------- Bikram Sambat (Nepali) months ----------
  // The report period is one Nepali month (1st..last), so the SCADA date
  // auto-fill must snap to BS month boundaries, never to raw file coverage.
  // Month lengths transcribed from the standard BS calendar dataset
  // (verified: Baishakh 2083 = 2026-04-14..2026-05-14, the app's original
  // default; Ashar 2083 = 2026-06-15..2026-07-16).
  const BS_MONTH_NAMES = ['Baishakh', 'Jestha', 'Ashar', 'Shrawan', 'Bhadra', 'Ashwin',
                          'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra'];
  const BS_FIRST_YEAR = 2081;                       // Baishakh 1, 2081 = 2024-04-13
  const BS_TABLE = {
    2081: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31],
    2082: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2083: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2084: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
    2085: [30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31],
    2086: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
    2087: [31, 31, 32, 31, 31, 31, 30, 30, 29, 30, 30, 30],
    2088: [30, 31, 32, 32, 30, 31, 30, 30, 29, 30, 30, 30],
    2089: [30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 30, 30],
    2090: [30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 30, 30],
  };
  let _bsMonths = null;
  function bsMonths() {
    if (_bsMonths) return _bsMonths;
    const out = [];
    let s = ymdToSerial({ y: 2024, m: 4, d: 13 });  // Baishakh 1, 2081
    for (let y = BS_FIRST_YEAR; BS_TABLE[y]; y++) {
      for (let m = 0; m < 12; m++) {
        const len = BS_TABLE[y][m];
        out.push({ label: BS_MONTH_NAMES[m] + ' ' + y, startSerial: s, endSerial: s + len - 1 });
        s += len;
      }
    }
    return (_bsMonths = out);
  }
  // Best BS month for a SCADA coverage window: the LATEST month fully inside
  // the coverage; if none is complete, the month with the most covered days.
  function pickBsMonthForCoverage(cov) {
    const lo = ymdToSerial(cov.min), hi = ymdToSerial(cov.max);
    let best = null;
    for (const mo of bsMonths()) {
      const overlap = Math.min(mo.endSerial, hi) - Math.max(mo.startSerial, lo) + 1;
      if (overlap <= 0) continue;
      const complete = mo.startSerial >= lo && mo.endSerial <= hi;
      if (!best ||
          (complete && (!best.complete || mo.startSerial > best.mo.startSerial)) ||
          (!complete && !best.complete && overlap >= best.overlap)) {
        best = { mo, overlap, complete };
      }
    }
    return best;
  }

  function findDmaCol(sheet, dma, headerRow) {
    // headerRow is 0-based (typically 7 for Excel row 8).
    // Try the name as typed first, then with any "dma " prefix stripped
    // (Customer File Builder outputs are named "dma 9.1"; SCADA headers
    // are plain "9.1 (OMU 036)").
    const raw = String(dma == null ? '' : dma).trim().toLowerCase();
    const stripped = stripDmaPrefix(dma).toLowerCase();
    const targets = raw === stripped ? [raw] : [raw, stripped];
    const range = XLSX.utils.decode_range(sheet['!ref']);
    for (const target of targets) {
      if (!target) continue;
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
    }
    return -1;
  }

  // "dma 9.1" / "DMA_9.1" -> "9.1" (Customer File Builder outputs are named
  // "dma <name>"; SCADA headers are plain "9.1 (OMU 036)").
  function stripDmaPrefix(s) {
    const t = String(s == null ? '' : s).trim();
    const out = t.replace(/^dma[\s_.-]+/i, '').trim();
    return out || t;
  }

  // Locate the SCADA header row: the row whose date column is labelled "Day"
  // (scans the top-left corner so layout shifts between exports don't matter).
  // Returns { r: headerRowIdx, c: dateColIdx } or null.
  function findScadaHeader(sheet) {
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const maxR = Math.min(range.e.r, 30);
    const maxC = Math.min(range.e.c, 6);
    for (let r = 0; r <= maxR; r++) {
      for (let c = 0; c <= maxC; c++) {
        const v = getCell(sheet, r, c);
        if (typeof v === 'string' && v.trim().toLowerCase() === 'day') return { r, c };
      }
    }
    return null;
  }

  // Overall calendar coverage of a SCADA workbook's date column(s).
  // Returns { min: ymd, max: ymd } or null when no sheet looks like SCADA data.
  function scadaCoverage(wb) {
    let min = null, max = null;
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name];
      if (!sheet || !sheet['!ref']) continue;
      const pos = findScadaHeader(sheet);
      if (!pos) continue;
      const range = XLSX.utils.decode_range(sheet['!ref']);
      for (let r = pos.r + 1; r <= range.e.r; r++) {
        const ymd = serialToYMD(getCell(sheet, r, pos.c));
        if (!ymd) continue;
        if (min === null || ymdKey(ymd) < ymdKey(min)) min = ymd;
        if (max === null || ymdKey(ymd) > ymdKey(max)) max = ymd;
      }
    }
    return min ? { min, max } : null;
  }

  function collectDailyForRange(sheet, dmaCol, startDate, endDate, dataStartRow, dateCol) {
    const out = [];
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const startKey = dateToKey(startDate);
    const endKey   = dateToKey(endDate);
    // Data rows start right below the header row. A trailing "Total" row is
    // skipped automatically because its date cell is not numeric.
    for (let r = dataStartRow; r <= range.e.r; r++) {
      const raw = getCell(sheet, r, dateCol);
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

    // Column layout for source customer sheet (0-based). Located from the
    // header row so both raw exports and Customer File Builder outputs work;
    // falls back to the canonical layout (J=Consumption, K=Observation).
    function findCustomerCol(label, fallback) {
      for (let c = 0; c <= initialRange.e.c; c++) {
        const v = getCell(ws, 0, c);
        if (typeof v !== 'string') continue;
        if (v.trim().toLowerCase().replace(/[\s.]+/g, '') === label) return c;
      }
      return fallback;
    }
    let CONS_COL   = findCustomerCol('consumption', 9);   // J
    const obsSrc   = findCustomerCol('observation', 10);  // K

    // Insert blank "Billable" column right before Observation (canonically at
    // K/index 10); pushes Observation, Gis(Bill), Gis(C) right.
    insertColumn(ws, obsSrc);
    const BILL_COL = obsSrc;
    const OBS_COL  = obsSrc + 1;
    if (obsSrc <= CONS_COL) CONS_COL += 1;

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
    setCell(ws, totalRow, Math.max(0, CONS_COL - 1), 'Total', { bold: true });
    setCell(ws, totalRow, CONS_COL, totalCons, { bold: true });
    setCell(ws, totalRow, BILL_COL, totalBill, { bold: true });
    extendRange(ws, totalRow, OBS_COL);

    // ---------- SCADA extraction ----------
    // Sheet-name independent: scan every sheet, locate its "Day" header row
    // (falls back to Excel row 8, the standard OMU layout), read the date
    // column and the DMA column, and keep the daily values whose date falls
    // inside [dateStart, dateEnd]. The calendar month comes from the data
    // itself, so this works whether sheets are named by month ("April"/"May ")
    // or generically ("OMU - Volumes", "July"/"June"). A trailing "Total" row
    // is ignored automatically because its date cell is not numeric.
    const ds = new Date(dateStart.getFullYear(), dateStart.getMonth(), dateStart.getDate());
    const de = new Date(dateEnd.getFullYear(),   dateEnd.getMonth(),   dateEnd.getDate());

    const byDay = new Map();   // dateKey -> [ymd, value]; first sheet to supply a day wins
    let headerSheet = null;
    let headerCol   = -1;
    let headerRow   = 7;
    let covMin = null, covMax = null;      // coverage of the sheets holding this DMA
    const availHeaders = [];               // for the "not found" error message

    for (const sheetName of scadaWB.SheetNames) {
      const sheet = scadaWB.Sheets[sheetName];
      if (!sheet || !sheet['!ref']) continue;
      const pos = findScadaHeader(sheet);
      const hdrRow  = pos ? pos.r : 7;   // fall back to the classic layout (Excel row 8)
      const dateCol = pos ? pos.c : 0;
      const dmaCol = findDmaCol(sheet, dmaName, hdrRow);
      if (dmaCol < 0) {
        // Remember what DMA headers this sheet offers (helps the error message).
        if (pos && availHeaders.length < 60) {
          const rng = XLSX.utils.decode_range(sheet['!ref']);
          for (let c = 0; c <= rng.e.c; c++) {
            const v = getCell(sheet, hdrRow, c);
            if (typeof v !== 'string') continue;
            const t = v.trim();
            if (t && !/^(day|total)$/i.test(t) && availHeaders.indexOf(t) === -1) availHeaders.push(t);
          }
        }
        continue;
      }
      if (headerSheet === null) { headerSheet = sheet; headerCol = dmaCol; headerRow = hdrRow; }
      const rng = XLSX.utils.decode_range(sheet['!ref']);
      for (let r = hdrRow + 1; r <= rng.e.r; r++) {
        const ymd = serialToYMD(getCell(sheet, r, dateCol));
        if (!ymd) continue;
        if (covMin === null || ymdKey(ymd) < ymdKey(covMin)) covMin = ymd;
        if (covMax === null || ymdKey(ymd) > ymdKey(covMax)) covMax = ymd;
      }
      for (const entry of collectDailyForRange(sheet, dmaCol, ds, de, hdrRow + 1, dateCol)) {
        const k = ymdKey(entry[0]);
        if (!byDay.has(k)) byDay.set(k, entry);
      }
    }

    if (headerSheet === null) {
      const avail = availHeaders.length
        ? ' Available DMA columns: ' + availHeaders.join(', ') +
          (availHeaders.length >= 60 ? ', \u2026' : '') + '.'
        : '';
      throw new Error(`DMA "${dmaName}" not found in any SCADA sheet (DMA names are read from the "Day" header row).${avail}`);
    }

    // chronological order
    const daily = [...byDay.values()].sort((a, b) => ymdKey(a[0]) - ymdKey(b[0]));

    const dailyTotal = daily.reduce((s, [, v]) => s + (v || 0), 0);

    // DMA header label (e.g. "9.1 (OMU 036)")
    const dmaLabel = (getCell(headerSheet, headerRow, headerCol) || dmaName).toString();

    if (daily.length === 0) {
      const covText = covMin
        ? ` This workbook's SCADA data covers ${ymdToISO(covMin)} to ${ymdToISO(covMax)}.`
        : '';
      throw new Error(
        `No SCADA rows for "${dmaLabel}" between ${dateToISO(ds)} and ${dateToISO(de)}.${covText} Adjust the date range.`);
    }

    // Requested period vs. days actually present in the SCADA workbook.
    // NRW % is only meaningful when both sides cover the SAME period, so a
    // shortfall here is surfaced prominently in the preview/log.
    const dsSerial = ymdToSerial({ y: ds.getFullYear(), m: ds.getMonth() + 1, d: ds.getDate() });
    const deSerial = ymdToSerial({ y: de.getFullYear(), m: de.getMonth() + 1, d: de.getDate() });
    const requestedDays = deSerial - dsSerial + 1;
    const missingDays = requestedDays - daily.length;
    const bsMatch = bsMonths().find(mo => mo.startSerial === dsSerial && mo.endSerial === deSerial) || null;

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
        startISO: dateToISO(ds),
        endISO: dateToISO(de),
        requestedDays,
        missingDays,
        periodLabel: bsMatch ? bsMatch.label : null,   // e.g. "Ashar 2083"
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
    // Strip extension and any Customer File Builder "dma " prefix, then extract
    // a dotted-numeric pattern, e.g. "9.1" or "4.1.2".
    const base = name.replace(/\.[^./\\]+$/, '').trim();
    const noPrefix = base.replace(/^dma[\s_.-]+/i, '').trim();
    const m = noPrefix.match(/(\d+(?:\.\d+)+)/);
    if (m) return m[1];
    // "dma 7B-A.xlsx" -> "7B-A" (only when an explicit dma prefix was present)
    if (noPrefix && noPrefix !== base) return noPrefix;
    return '';
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
  function dateToISO(d) {
    return ymdToISO({ y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() });
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

    const periodLine =
      `<p class="nrw-period">Period: ${s.periodLabel ? '<b>' + escapeHtml(s.periodLabel) + '</b> · ' : ''}` +
      `${s.startISO} → ${s.endISO} · ${fmtNum(s.requestedDays)} days</p>`;
    const missingHtml = (s.missingDays > 0)
      ? `<div class="nrw-warnbox"><b>\u26a0 ${fmtNum(s.missingDays)} day(s) have no SCADA data</b> — ` +
        `the workbook covers only ${fmtNum(s.dailyCount)} of ${fmtNum(s.requestedDays)} days in this period, ` +
        `so the SCADA total (and NRW %) under-counts supplied water.</div>`
      : '';

    host.innerHTML =
      `<div class="nrw-preview">
        <h3>Summary preview &mdash; ${escapeHtml(s.dmaLabel)}</h3>
        ${periodLine}
        <div class="nrw-kpis">
          <div class="nrw-kpi"><span>Customer rows</span><b>${fmtNum(s.customerCount)}</b></div>
          <div class="nrw-kpi"><span>Total consumption</span><b>${fmtNum(s.totalCons)}</b></div>
          <div class="nrw-kpi"><span>Total billable</span><b>${fmtNum(s.totalBill)}</b></div>
          <div class="nrw-kpi ${s.missingDays > 0 ? 'nrw-kpi-warn' : ''}"><span>Daily SCADA total</span><b>${fmtNum(s.dailyTotal)}</b><i>${fmtNum(s.dailyCount)} of ${fmtNum(s.requestedDays)} days</i></div>
          <div class="nrw-kpi"><span>Meter-status total</span><b>${fmtNum(s.statusTotal)}</b></div>
          <div class="nrw-kpi nrw-kpi-hl ${nrwCls}"><span>NRW %</span><b>${nrwPctText}</b><i>NRW vol: ${fmtNum(s.nrwVolume)}</i></div>
        </div>
        ${missingHtml}
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

    // When a SCADA workbook is picked, read its date coverage and — if the
    // current range misses the data entirely (e.g. default Baishakh dates vs.
    // a June/July "OMU - Volumes" export) — snap to the NEPALI (BS) month the
    // file covers, never to the raw file span: NRW % must compare one billing
    // month of consumption against the SAME month of SCADA supply.
    scadaIn.addEventListener('change', async () => {
      const f = scadaIn.files && scadaIn.files[0];
      if (!f || typeof XLSX === 'undefined') return;
      try {
        const cov = scadaCoverage(await readWorkbook(f));
        if (!cov) return;
        const minISO = ymdToISO(cov.min), maxISO = ymdToISO(cov.max);
        const ds = parseDateInput(startIn.value);
        const de = parseDateInput(endIn.value);
        const outside = !ds || !de ||
          dateToKey(de) < ymdKey(cov.min) || dateToKey(ds) > ymdKey(cov.max);
        const pick = outside ? pickBsMonthForCoverage(cov) : null;
        if (pick) {
          const mStart = serialToYMD(pick.mo.startSerial);
          const mEnd   = serialToYMD(pick.mo.endSerial);
          startIn.value = ymdToISO(mStart);
          endIn.value   = ymdToISO(mEnd);
          lastFingerprint = '';   // force preview rebuild with the new dates
          log(`SCADA data covers ${minISO} to ${maxISO}. Date range set to ` +
              `${pick.mo.label} (${ymdToISO(mStart)} \u2192 ${ymdToISO(mEnd)})` +
              (pick.complete ? '' : ' \u2014 note: this month is only PARTLY covered by the file') +
              ' \u2014 adjust if needed.');
        } else {
          log(`SCADA data covers ${minISO} to ${maxISO}.`);
        }
        refreshPreview();
      } catch (e) { /* non-fatal: preview will surface real errors */ }
    });

    resetBtn && resetBtn.addEventListener('click', () => {
      custIn.value = '';
      scadaIn.value = '';
      dmaIn.value = '';
      outIn.value = '';
      startIn.value = startIn.defaultValue;   // restore HTML default dates
      endIn.value   = endIn.defaultValue;
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
          `Period: ${stats.startISO} \u2192 ${stats.endISO}` +
            (stats.periodLabel ? ` (${stats.periodLabel})` : '') +
            ` \u2014 SCADA days found: ${stats.dailyCount}/${stats.requestedDays}`,
          `Customer rows: ${stats.customerCount}`,
          `Total consumption: ${stats.totalCons}    Total billable: ${stats.totalBill}`,
          `Daily SCADA entries: ${stats.dailyCount}    Sum: ${stats.dailyTotal}`,
          `NRW volume: ${stats.nrwVolume}    NRW %: ${stats.nrwPercent == null ? '—' : stats.nrwPercent.toFixed(2) + '%'}`,
          `Meter-status total: ${stats.statusTotal}`,
        ];
        if (stats.missingDays > 0) {
          lines.push(`\u26a0 ${stats.missingDays} day(s) in the period have no SCADA data \u2014 NRW % may under-count supplied water.`);
        }
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
  window.NRWBuilder = { buildReport, computeReport, scadaCoverage, detectDmaFromName,
                        stripDmaPrefix, bsMonths, pickBsMonthForCoverage };
})();
