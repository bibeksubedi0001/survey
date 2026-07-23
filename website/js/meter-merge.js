/* Customer File Builder — merge exported meter-reading workbooks by DMA.
 *
 * Each exported reading file (e.g. "Export(67).xlsx") uses the standard
 * customer-reading layout:
 *   Sl. | Con No | Customer No | Area No | Name | Address | Phone No |
 *   Prev Reading | Present Reading | Consumption | Observation | Gis(Bill) | Gis(C)
 *
 * Files are grouped by the ZONE code in the "Area No" column — the text before
 * the first dash (e.g. "35kha-15-04" -> "35kha"). Every row is bucketed by its
 * own zone, then zones are mapped to a DMA name. Two zones sharing the same DMA
 * name are merged into one workbook. The result is a clean, well-formatted
 * customer-reading workbook per DMA, ready to feed into
 *   NRW Report -> "Customer reading file (.xlsx)".
 *
 * Requires SheetJS (XLSX) available globally (browser) or on globalThis (Node).
 */
(function (global) {
  'use strict';

  // Canonical output column order (matches what nrw-builder.js expects).
  const HEADERS = [
    'Sl.', 'Con No', 'Customer No', 'Area No', 'Name', 'Address', 'Phone No',
    'Prev Reading', 'Present Reading', 'Consumption', 'Observation', 'Gis(Bill)', 'Gis(C)',
  ];

  const COL_WIDTHS = [
    { wch: 5 }, { wch: 14 }, { wch: 13 }, { wch: 14 }, { wch: 24 }, { wch: 20 },
    { wch: 13 }, { wch: 13 }, { wch: 15 }, { wch: 13 }, { wch: 18 }, { wch: 10 }, { wch: 10 },
  ];

  // Header indices that must be present for a file to count as a reading export.
  const IDX = HEADERS.reduce((m, h, i) => { m[h] = i; return m; }, {});

  // ---------- helpers ----------
  function normHeader(v) {
    return String(v == null ? '' : v).toLowerCase().replace(/[\s.]/g, '');
  }
  // Pre-computed normalized lookup: normalized header text -> canonical index.
  const HEADER_LOOKUP = HEADERS.reduce((m, h, i) => { m[normHeader(h)] = i; return m; }, {});

  function areaPrefix(v) {
    if (v == null) return '';
    const s = String(v).trim();
    if (!s) return '';
    const dash = s.indexOf('-');
    return (dash >= 0 ? s.slice(0, dash) : s).trim();
  }

  // Split an Area No into its zone prefix and the first "book" number after it.
  //   "35kha-15-04" -> { prefix: '35kha', num: 15 }      "9c-7" -> { prefix: '9c', num: 7 }
  function parseArea(v) {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s) return null;
    const toks = s.split('-');
    const prefix = (toks[0] || '').trim().toLowerCase().replace(/\s+/g, '');
    const num = parseInt(toks[1], 10);
    if (!prefix || isNaN(num)) return null;
    return { prefix, num };
  }
  function zoneLabel(v) {
    const p = parseArea(v);
    if (p) return p.prefix + '-' + p.num;
    const s = v == null ? '' : String(v).trim();
    return s || '(blank)';
  }

  // Area-No -> DMA mapping, transcribed directly from "DMA wise area allocation.xlsx"
  // (Sno/DMA/Area/Reading-Days table). Each rule matches a zone prefix plus either
  // an explicit set of book numbers (`nums`) or an inclusive range (`min`..`max`).
  //
  // A handful of prefixes are assigned to more than one DMA for overlapping book
  // numbers in the source spreadsheet itself (32b: 2.2 & 4.1.2; 32d: 3.4 & 9.2;
  // 32g: 3.3, 9.1 & 9.2). Per field confirmation, rows in an overlapping range are
  // included in *every* matching DMA's output file (not just the first match) —
  // see classifyAreaAll() below.
  const DMA_RULES = [
    // DMA 1.2
    { dma: 'dma 1.2',   prefix: '30a',    min: 1,  max: 29 },
    { dma: 'dma 1.2',   prefix: '33ka',   min: 1,  max: 29 },
    // DMA 2.1
    { dma: 'dma 2.1',   prefix: '30c',    min: 1,  max: 8 },
    // DMA 2.2
    { dma: 'dma 2.2',   prefix: '32b',    min: 1,  max: 15 },
    { dma: 'dma 2.2',   prefix: '30b',    min: 1,  max: 29 },
    { dma: 'dma 2.2',   prefix: '32a',    min: 1,  max: 29 },
    { dma: 'dma 2.2',   prefix: '32c',    min: 1,  max: 3 },
    // DMA 2.3
    { dma: 'dma 2.3',   prefix: '9c',     min: 1,  max: 20 },
    // DMA 2.4
    { dma: 'dma 2.4',   prefix: '9c',     min: 22, max: 29 },
    { dma: 'dma 2.4',   prefix: '9a',     min: 1,  max: 22 },
    { dma: 'dma 2.4',   prefix: '9chhut', min: 2,  max: 13 },
    // DMA 3.1
    { dma: 'dma 3.1',   prefix: '10b',    min: 1,  max: 29 },
    // DMA 3.2
    { dma: 'dma 3.2',   prefix: '34ka',   min: 1,  max: 29 },
    { dma: 'dma 3.2',   prefix: '34kha',  min: 1,  max: 15 },
    // DMA 3.3
    { dma: 'dma 3.3',   prefix: '31c',    min: 1,  max: 29 },
    { dma: 'dma 3.3',   prefix: '32g',    min: 1,  max: 29 },
    { dma: 'dma 3.3',   prefix: '34gha',  min: 1,  max: 11 },
    { dma: 'dma 3.3',   prefix: '10kha',  nums: [8] },
    { dma: 'dma 3.3',   prefix: '34kha',  min: 16, max: 29 },
    // DMA 3.4
    { dma: 'dma 3.4',   prefix: '32d',    min: 1,  max: 5 },
    { dma: 'dma 3.4',   prefix: '9a',     min: 25, max: 29 },
    { dma: 'dma 3.4',   prefix: '9b',     min: 1,  max: 6 },
    // DMA 3.5
    { dma: 'dma 3.5',   prefix: '9b',     min: 8,  max: 29 },
    { dma: 'dma 3.5',   prefix: '9chhut', min: 24, max: 29 },
    // DMA 4.1.2 — overlaps DMA 2.2 on 32b books 3-15
    { dma: 'dma 4.1.2', prefix: '32b',    min: 3,  max: 15 },
    // DMA 9.1 — overlaps DMA 3.3 on 32g books 1-18
    { dma: 'dma 9.1',   prefix: '32g',    min: 1,  max: 18 },
    { dma: 'dma 9.1',   prefix: '32f',    min: 1,  max: 29 },
    { dma: 'dma 9.1',   prefix: '35kha',  min: 1,  max: 17 },
    { dma: 'dma 9.1',   prefix: '35ga',   min: 1,  max: 8 },
    // DMA 9.2 — overlaps DMA 3.4 on 32d books 1-5, and DMA 3.3 / 9.1 on 32g books 18-29
    { dma: 'dma 9.2',   prefix: '32d',    min: 1,  max: 29 },
    { dma: 'dma 9.2',   prefix: '32g',    min: 18, max: 29 },
    { dma: 'dma 9.2',   prefix: '32e',    min: 1,  max: 29 },
    { dma: 'dma 9.2',   prefix: '35',     min: 1,  max: 29 },
    { dma: 'dma 9.2',   prefix: '35a',    min: 1,  max: 29 },
  ];

  // Every DMA whose rule set matches this Area No (usually one, occasionally more
  // than one when the source table assigns the same books to two DMAs).
  function classifyAreaAll(v) {
    const p = parseArea(v);
    if (!p) return [];
    const out = [];
    for (const rule of DMA_RULES) {
      if (rule.prefix !== p.prefix) continue;
      const hit = rule.nums ? rule.nums.indexOf(p.num) >= 0 : (p.num >= rule.min && p.num <= rule.max);
      if (hit && out.indexOf(rule.dma) === -1) out.push(rule.dma);
    }
    return out;
  }

  // Back-compat single-match helper (first matching DMA only).
  function classifyArea(v) {
    const all = classifyAreaAll(v);
    return all.length ? all[0] : null;
  }

  function sanitizeFileName(name) {
    const base = String(name == null ? '' : name).trim().replace(/[\\/:*?"<>|]+/g, '_');
    return base || 'dma';
  }
  function sanitizeSheetName(name) {
    const base = String(name == null ? '' : name).trim().replace(/[\\/:*?[\]]+/g, '_');
    return (base || 'Reading').slice(0, 31);
  }

  function isEmptyRow(row) {
    // Empty if Con No, Customer No and Name are all blank (also drops "Total" rows).
    const blank = (v) => v == null || String(v).trim() === '';
    return blank(row[IDX['Con No']]) && blank(row[IDX['Customer No']]) && blank(row[IDX['Name']]);
  }

  // ---------- pure: turn one parsed sheet (AOA) into a normalized record ----------
  // aoa: array-of-arrays from XLSX.utils.sheet_to_json(ws, {header:1, defval:null}).
  function fileToRecord(name, aoa) {
    if (!Array.isArray(aoa) || aoa.length < 2) {
      return { name, ok: false, error: 'no data rows', rows: [] };
    }
    const header = aoa[0] || [];
    // Map canonical index -> source column index.
    const srcForTarget = new Array(HEADERS.length).fill(-1);
    for (let c = 0; c < header.length; c++) {
      const key = normHeader(header[c]);
      if (key in HEADER_LOOKUP && srcForTarget[HEADER_LOOKUP[key]] === -1) {
        srcForTarget[HEADER_LOOKUP[key]] = c;
      }
    }
    // Must be able to group (Area No) and identify customers + consumption.
    const hasArea = srcForTarget[IDX['Area No']] >= 0;
    const hasId   = srcForTarget[IDX['Con No']] >= 0 || srcForTarget[IDX['Customer No']] >= 0;
    const hasCons = srcForTarget[IDX['Consumption']] >= 0;
    if (!hasArea || !hasId || !hasCons) {
      return { name, ok: false, error: 'not a meter-reading export (missing Area No / Consumption columns)', rows: [] };
    }

    const rows = [];
    for (let r = 1; r < aoa.length; r++) {
      const src = aoa[r] || [];
      const out = new Array(HEADERS.length).fill(null);
      for (let t = 0; t < HEADERS.length; t++) {
        const sc = srcForTarget[t];
        out[t] = sc >= 0 ? (src[sc] == null ? null : src[sc]) : null;
      }
      if (isEmptyRow(out)) continue;
      rows.push(out);
    }
    return { name, ok: true, error: null, rows };
  }

  // ---------- pure: fingerprint a row for duplicate detection (ignores Sl.) ----------
  // Sl. is a position-derived serial number that gets re-sequenced on every export
  // and again on output — two rows/files that are identical except for row ORDER
  // (which shifts Sl.) must still be recognized as the same customer record.
  function rowKey(row) {
    return row.slice(1).map(v => (v == null ? '' : String(v).trim().toLowerCase())).join('\u0001');
  }

  // ---------- pure: drop files & rows that are exact re-exports of something already read ----------
  // Two-stage, both order-insensitive and Sl.-agnostic:
  //   1. Whole-file dupes: a file whose entire row set (as a multiset) matches an
  //      earlier file's is dropped outright (e.g. the same book exported twice).
  //   2. Row-level dupes: within what's left, if the *same* customer row (identical
  //      in every column but Sl.) still appears more than once — even split across
  //      two otherwise-different files — only the first occurrence is kept, so a
  //      customer's consumption is never silently double-counted downstream.
  // Returns the same records (mutated in place for .rows) plus counts for the log.
  function dedupeRecords(records) {
    const seenFileKey = new Set();
    const kept = [];
    const duplicateFiles = [];
    for (const rec of records) {
      if (!rec.ok || !rec.rows.length) { kept.push(rec); continue; }
      const fileKey = rec.rows.map(rowKey).sort().join('\u0002');
      if (seenFileKey.has(fileKey)) { duplicateFiles.push(rec.name); continue; }
      seenFileKey.add(fileKey);
      kept.push(rec);
    }
    const seenRow = new Set();
    let duplicateRows = 0;
    for (const rec of kept) {
      if (!rec.ok || !rec.rows.length) continue;
      const uniqueRows = [];
      for (const row of rec.rows) {
        const k = rowKey(row);
        if (seenRow.has(k)) { duplicateRows++; continue; }
        seenRow.add(k);
        uniqueRows.push(row);
      }
      rec.rows = uniqueRows;
    }
    return { records: kept, duplicateFiles, duplicateRows };
  }

  // ---------- pure: data-quality scan over a set of merged rows ----------
  // Flags things worth a human's attention without ever silently altering data:
  //   negative      — Present Reading < Prev Reading (rollover, meter swap, typo)
  //   blankName     — a real Con No/Customer No with no Name on file
  //   conflict      — the same Con No appears twice with genuinely different data
  //                   (dedupeRecords already removed *identical* repeats, so any
  //                   Con No seen twice here is a real conflict worth reviewing)
  //   outlier       — Consumption far above the group's own median (soft heuristic)
  function analyzeRows(rows) {
    const issues = { negative: [], blankName: [], conflict: [], outlier: [] };
    const cons = [];
    for (const row of rows) {
      const c = parseFloat(row[IDX['Consumption']]);
      if (!isNaN(c)) cons.push(c);
    }
    cons.sort((a, b) => a - b);
    const median = cons.length ? cons[Math.floor(cons.length / 2)] : 0;
    const outlierCap = Math.max(200, median * 6);

    const firstSeen = new Map();
    for (const row of rows) {
      const conNo = row[IDX['Con No']];
      const name = row[IDX['Name']];
      const prev = parseFloat(row[IDX['Prev Reading']]);
      const pres = parseFloat(row[IDX['Present Reading']]);
      const consVal = parseFloat(row[IDX['Consumption']]);

      if (!isNaN(prev) && !isNaN(pres) && pres < prev) issues.negative.push(row);
      if (conNo != null && String(conNo).trim() && !(name != null && String(name).trim())) issues.blankName.push(row);
      if (!isNaN(consVal) && consVal > outlierCap) issues.outlier.push(row);

      const idKey = conNo != null ? String(conNo).trim().toLowerCase() : '';
      if (idKey) {
        if (firstSeen.has(idKey)) issues.conflict.push(row);
        else firstSeen.set(idKey, row);
      }
    }
    return issues;
  }

  // ---------- pure: roll up per-DMA outputs into dashboard-friendly stats ----------
  function computeStats(outputs) {
    const files = new Set();
    let totalRows = 0;
    let totalConsumption = 0;
    const byDma = outputs.map(o => {
      let consumption = 0;
      for (const row of o.rows) {
        const c = parseFloat(row[IDX['Consumption']]);
        if (!isNaN(c)) consumption += c;
      }
      for (const f of o.files) files.add(f);
      totalRows += o.rows.length;
      totalConsumption += consumption;
      return { name: o.dmaName, rows: o.rows.length, files: o.files.size, consumption };
    });
    return { totalDmas: outputs.length, totalFiles: files.size, totalRows, totalConsumption, byDma };
  }

  // ---------- pure: classify every row into one or more DMAs, or a leftover zone ----------
  // Matched rows are bucketed by DMA (a row lands in *every* DMA whose rule matches
  // its Area No — see classifyAreaAll — so overlapping-book rows are duplicated on
  // purpose). Unmatched rows are bucketed per zone so the user can assign each
  // leftover individually. `duplicatedRows` counts rows that matched more than one
  // DMA, purely for the summary log.
  function groupByDma(records) {
    const dmaGroups = new Map();   // dmaKey -> group
    const leftover  = new Map();   // 'unmatched:<zone>' -> group
    const skipped = [];
    let duplicatedRows = 0;

    function addTo(map, key, seed, row, fileName, zl) {
      let g = map.get(key);
      if (!g) { g = seed(); map.set(key, g); }
      g.rows.push(row);
      g.files.add(fileName);
      g.zones.set(zl, (g.zones.get(zl) || 0) + 1);
    }

    for (const rec of records) {
      if (!rec.ok) { skipped.push({ name: rec.name, error: rec.error }); continue; }
      for (const row of rec.rows) {
        const area = row[IDX['Area No']];
        const dmas = classifyAreaAll(area);
        const zl   = zoneLabel(area);
        if (dmas.length > 1) duplicatedRows++;
        if (dmas.length) {
          for (const dma of dmas) {
            const key = dma.toLowerCase();
            addTo(dmaGroups, key,
              () => ({ key, kind: 'dma', display: dma, defaultName: dma, matched: true, rows: [], files: new Set(), zones: new Map() }),
              row, rec.name, zl);
          }
        } else {
          const key = 'unmatched:' + zl.toLowerCase();
          addTo(leftover, key,
            () => ({ key, kind: 'unmatched', display: zl, defaultName: '', matched: false, rows: [], files: new Set(), zones: new Map() }),
            row, rec.name, zl);
        }
      }
    }
    const byName = (a, b) => a.display.localeCompare(b.display, undefined, { numeric: true, sensitivity: 'base' });
    const dmaList  = Array.from(dmaGroups.values()).sort(byName);
    const leftList = Array.from(leftover.values()).sort(byName);
    return { groups: dmaList.concat(leftList), skipped, duplicatedRows };
  }

  // ---------- pure: apply (optional) name overrides, returning merged outputs ----------
  // mapping: { groupKey: 'outputName' }. Absent -> group.defaultName. Blank -> skipped.
  function assignDmas(groups, mapping) {
    mapping = mapping || {};
    const byDma = new Map();   // nameKey -> { dmaName, rows:[], files:Set, zones:Map }
    for (const g of groups) {
      const has = Object.prototype.hasOwnProperty.call(mapping, g.key);
      const fallback = (g.defaultName != null ? g.defaultName : g.display);
      const dmaName = (has ? String(mapping[g.key]).trim() : fallback);
      if (!dmaName) continue;   // no name -> excluded from output
      const dmaKey = dmaName.toLowerCase();
      let o = byDma.get(dmaKey);
      if (!o) { o = { dmaName, rows: [], files: new Set(), zones: new Map() }; byDma.set(dmaKey, o); }
      for (const row of g.rows) o.rows.push(row);
      for (const f of g.files) o.files.add(f);
      for (const [z, c] of g.zones) o.zones.set(z, (o.zones.get(z) || 0) + c);
    }
    return Array.from(byDma.values()).sort((a, b) =>
      a.dmaName.localeCompare(b.dmaName, undefined, { numeric: true, sensitivity: 'base' }));
  }

  // ---------- pure: build a workbook from merged rows ----------
  function buildWorkbook(dmaName, rows) {
    const aoa = [HEADERS.slice()];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].slice();
      r[0] = i + 1;            // re-sequence Sl.
      aoa.push(r);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = COL_WIDTHS.slice();
    const lastRow = rows.length + 1;
    ws['!autofilter'] = { ref: 'A1:' + XLSX.utils.encode_cell({ r: lastRow - 1, c: HEADERS.length - 1 }) };
    ws['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sanitizeSheetName(dmaName));
    return wb;
  }

  // ---------- public API ----------
  const API = {
    HEADERS,
    DMA_RULES,
    fileToRecord,
    groupByDma,
    assignDmas,
    buildWorkbook,
    classifyArea,
    classifyAreaAll,
    parseArea,
    zoneLabel,
    areaPrefix,
    sanitizeFileName,
    sanitizeSheetName,
    rowKey,
    dedupeRecords,
    analyzeRows,
    computeStats,
  };


  global.KUKLMerge = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;

  // ============================================================
  // Browser UI wiring (skipped under Node / no DOM)
  // ============================================================
  if (typeof document === 'undefined') return;

  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }
  function zonesText(map) {
    return Array.from(map.keys())
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      .join(', ');
  }

  function initUI() {
    const filesIn        = $('mergeFiles');
    const folderIn       = $('mergeFolder');
    const clearBtn       = $('mergeClear');
    const cancelBtn      = $('mergeCancel');
    const genBtn         = $('mergeGenerate');
    const genCombinedBtn = $('mergeGenerateCombined');
    const issuesBtn      = $('mergeDownloadIssues');
    const mapHost        = $('mergeMapHost');
    const preview        = $('mergePreview');
    const logEl          = $('mergeLog');
    const progressEl     = $('mergeProgress');
    const progressFill   = $('mergeProgressFill');
    const progressText   = $('mergeProgressText');
    const statsHost       = $('mergeStats');
    const qualityHost     = $('mergeQuality');
    const dmaToolbar      = $('mergeDmaToolbar');
    const dmaFilterInput  = $('mergeDmaFilter');
    const forgetBtn       = $('mergeForgetNames');
    if (!filesIn || !genBtn) return;   // tool not on this page

    let groups = [];        // current grouped zones
    let skipped = [];       // files that were ignored
    let busy = false;       // a read or generate pass is in progress
    let cancelRequested = false;
    let lastOutputs = [];       // last computed per-DMA outputs (post name-mapping)
    let lastIssueEntries = [];  // flattened data-quality rows for the issues download
    let dmaFilterText = '';     // Detected-DMAs search box value
    let dmaSort = { col: 'display', dir: 1 };
    let previewSort = { col: 'dmaName', dir: 1 };

    function log(msg, isError) {
      if (!logEl) return;
      logEl.style.color = isError ? '#a8001a' : '';
      logEl.textContent = msg;
    }

    // ---- remembered output names for zones that didn't auto-match a DMA ----
    // Scoped to *unmatched* zones only — a matched DMA's name comes straight from
    // the allocation table and must never be silently overridden by a stale
    // value saved in a previous session.
    const REMEMBER_PREFIX = 'kuklMerge.zoneName.';
    function rememberedName(key) {
      try { return localStorage.getItem(REMEMBER_PREFIX + key) || ''; } catch (e) { return ''; }
    }
    function rememberName(key, value) {
      try {
        if (value) localStorage.setItem(REMEMBER_PREFIX + key, value);
        else localStorage.removeItem(REMEMBER_PREFIX + key);
      } catch (e) { /* localStorage unavailable (private browsing etc.) — ignore */ }
    }
    function forgetRememberedNames() {
      try {
        const toRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.indexOf(REMEMBER_PREFIX) === 0) toRemove.push(k);
        }
        toRemove.forEach(k => localStorage.removeItem(k));
      } catch (e) { /* ignore */ }
      renderMap();
      log('Forgot all remembered unmatched-zone names.');
    }

    // Batch size processed before yielding to the event loop (keeps the tab
    // responsive — progress bar, Cancel click, scrolling — across 1000+ files).
    const YIELD_EVERY = 8;

    function setBusy(isBusy) {
      busy = isBusy;
      filesIn.disabled = isBusy;
      if (folderIn) folderIn.disabled = isBusy;
      if (cancelBtn) cancelBtn.hidden = !isBusy;
      if (isBusy) cancelRequested = false;
      else if (progressEl) progressEl.hidden = true;
    }

    function setProgress(done, total, label) {
      if (!progressEl) return;
      progressEl.hidden = false;
      const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
      if (progressFill) progressFill.style.width = pct + '%';
      if (progressText) progressText.textContent = `${label} — ${done.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`;
    }

    function currentMapping() {
      const map = {};
      mapHost.querySelectorAll('.merge-dma').forEach(inp => {
        map[inp.getAttribute('data-prefix')] = inp.value;
      });
      return map;
    }

    // ---- generic click-to-sort helper shared by both tables ----
    function sortRows(rows, getters, sort) {
      const get = getters[sort.col] || getters[Object.keys(getters)[0]];
      return rows.slice().sort((a, b) => {
        const va = get(a), vb = get(b);
        const cmp = (typeof va === 'number' && typeof vb === 'number')
          ? va - vb
          : String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
        return cmp * sort.dir;
      });
    }
    function sortArrow(sort, col) {
      return sort.col === col ? (sort.dir === 1 ? ' \u25B2' : ' \u25BC') : '';
    }

    function renderPreview() {
      const outputs = API.assignDmas(groups, currentMapping());
      lastOutputs = outputs;
      genBtn.disabled = outputs.length === 0;
      if (genCombinedBtn) genCombinedBtn.disabled = outputs.length === 0;

      if (preview) {
        if (!outputs.length) {
          preview.innerHTML = '';
        } else {
          const sorted = sortRows(outputs, {
            dmaName: o => o.dmaName,
            zones: o => zonesText(o.zones),
            files: o => o.files.size,
            rows: o => o.rows.length,
          }, previewSort);
          const rowsHtml = sorted.map(o =>
            `<tr>
               <td><b>${escapeHtml(API.sanitizeFileName(o.dmaName))}.xlsx</b></td>
               <td>${escapeHtml(zonesText(o.zones))}</td>
               <td class="num">${o.files.size}</td>
               <td class="num">${o.rows.length.toLocaleString()}</td>
               <td class="merge-dl-cell"><button type="button" class="btn btn-outline btn-sm merge-dl-one" data-dma="${escapeHtml(o.dmaName)}">DOWNLOAD</button></td>
             </tr>`).join('');
          preview.innerHTML =
            `<div class="nrw-preview">
               <h3>Output preview &mdash; ${outputs.length} file${outputs.length === 1 ? '' : 's'} will be created</h3>
               <div class="nrw-table-wrap nrw-scroll">
                 <table class="nrw-tbl">
                   <thead><tr>
                     <th data-sort="dmaName" class="sortable">Output file${sortArrow(previewSort, 'dmaName')}</th>
                     <th data-sort="zones" class="sortable">Merged zones${sortArrow(previewSort, 'zones')}</th>
                     <th data-sort="files" class="sortable num">Src files${sortArrow(previewSort, 'files')}</th>
                     <th data-sort="rows" class="sortable num">Rows${sortArrow(previewSort, 'rows')}</th>
                     <th>Download</th>
                   </tr></thead>
                   <tbody>${rowsHtml}</tbody>
                 </table>
               </div>
             </div>`;
          preview.querySelectorAll('th.sortable').forEach(th => {
            th.addEventListener('click', () => {
              const col = th.getAttribute('data-sort');
              previewSort = { col, dir: (previewSort.col === col ? -previewSort.dir : 1) };
              renderPreview();
            });
          });
          preview.querySelectorAll('.merge-dl-one').forEach(btn => {
            btn.addEventListener('click', () => downloadOne(btn.getAttribute('data-dma')));
          });
        }
      }

      renderStats(outputs);
      renderQuality(outputs);
    }

    function renderStats(outputs) {
      if (!statsHost) return;
      if (!outputs.length) { statsHost.innerHTML = ''; return; }
      const stats = API.computeStats(outputs);
      const maxRows = Math.max(1, ...stats.byDma.map(d => d.rows));
      const bars = stats.byDma.slice().sort((a, b) => b.rows - a.rows).map(d => `
        <div class="merge-bar-row">
          <div class="merge-bar-label" title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</div>
          <div class="merge-bar-track"><div class="merge-bar-fill" style="width:${Math.max(2, Math.round(d.rows / maxRows * 100))}%"></div></div>
          <div class="merge-bar-value">${d.rows.toLocaleString()}</div>
        </div>`).join('');
      statsHost.innerHTML =
        `<div class="merge-stats">
           <h3>Summary</h3>
           <div class="merge-stat-cards">
             <div class="merge-stat-card"><span class="merge-stat-num">${stats.totalFiles.toLocaleString()}</span><span class="merge-stat-lbl">Source files used</span></div>
             <div class="merge-stat-card"><span class="merge-stat-num">${stats.totalDmas.toLocaleString()}</span><span class="merge-stat-lbl">Output DMA files</span></div>
             <div class="merge-stat-card"><span class="merge-stat-num">${stats.totalRows.toLocaleString()}</span><span class="merge-stat-lbl">Customer rows</span></div>
             <div class="merge-stat-card"><span class="merge-stat-num">${Math.round(stats.totalConsumption).toLocaleString()}</span><span class="merge-stat-lbl">Total consumption</span></div>
           </div>
           <div class="merge-bars">${bars}</div>
         </div>`;
    }

    function renderQuality(outputs) {
      if (!qualityHost) return;
      if (!outputs.length) {
        qualityHost.innerHTML = '';
        lastIssueEntries = [];
        if (issuesBtn) issuesBtn.disabled = true;
        return;
      }
      const entries = [];   // { reason, dma, row }
      const totals = { negative: 0, blankName: 0, conflict: 0, outlier: 0 };
      const labels = {
        negative: 'Present < Prev reading',
        blankName: 'Con No with no Name',
        conflict: 'Same Con No, conflicting data',
        outlier: 'Unusually high consumption',
      };
      for (const o of outputs) {
        const issues = API.analyzeRows(o.rows);
        for (const key of Object.keys(labels)) {
          for (const row of issues[key]) entries.push({ reason: labels[key], dma: o.dmaName, row });
          totals[key] += issues[key].length;
        }
      }
      lastIssueEntries = entries;
      if (issuesBtn) issuesBtn.disabled = entries.length === 0;
      const totalIssues = totals.negative + totals.blankName + totals.conflict + totals.outlier;
      if (!totalIssues) {
        qualityHost.innerHTML = `<div class="merge-quality merge-quality-ok">\u2713 No data-quality issues detected across ${outputs.length} output file(s).</div>`;
        return;
      }
      const chip = (n, label) => n ? `<span class="merge-chip">${n.toLocaleString()} &times; ${escapeHtml(label)}</span>` : '';
      qualityHost.innerHTML =
        `<div class="merge-quality">
           <h3>Data Quality &mdash; ${totalIssues.toLocaleString()} row(s) flagged for review</h3>
           <div class="merge-chips">
             ${chip(totals.negative, labels.negative)}
             ${chip(totals.blankName, labels.blankName)}
             ${chip(totals.conflict, labels.conflict)}
             ${chip(totals.outlier, labels.outlier)}
           </div>
           <p class="hint">These rows are still included in the generated files &mdash; nothing is changed
             automatically. Click <b>DOWNLOAD ISSUES REPORT</b> below for one workbook listing every
             flagged row with its reason, for a quick field review.</p>
         </div>`;
    }

    function renderMap() {
      if (dmaToolbar) dmaToolbar.hidden = !groups.length;
      if (!groups.length) {
        mapHost.innerHTML = '';
        genBtn.disabled = true;
        if (genCombinedBtn) genCombinedBtn.disabled = true;
        renderPreview();
        return;
      }
      const q = dmaFilterText.trim().toLowerCase();
      const filtered = !q ? groups : groups.filter(g =>
        g.display.toLowerCase().indexOf(q) >= 0 || zonesText(g.zones).toLowerCase().indexOf(q) >= 0);
      const sorted = sortRows(filtered, {
        display: g => g.display,
        zones: g => zonesText(g.zones),
        files: g => g.files.size,
        rows: g => g.rows.length,
      }, dmaSort);

      const body = sorted.map(g => {
        const unmatched = g.matched === false;
        const value = g.defaultName || (unmatched ? rememberedName(g.key) : '');
        const ph = unmatched ? 'type a DMA to include' : '';
        const label = unmatched
          ? '<span class="merge-warn">unmatched</span>'
          : '<code>' + escapeHtml(g.display) + '</code>';
        return `<tr class="${unmatched ? 'merge-unmatched' : ''}">
           <td>${label}</td>
           <td>${escapeHtml(zonesText(g.zones))}</td>
           <td class="num">${g.files.size}</td>
           <td class="num">${g.rows.length.toLocaleString()}</td>
           <td><input class="merge-dma" type="text" data-prefix="${escapeHtml(g.key)}" data-unmatched="${unmatched ? '1' : ''}"
                      value="${escapeHtml(value)}" placeholder="${ph}" autocomplete="off" spellcheck="false" /></td>
         </tr>`;
      }).join('');
      const emptyNote = !sorted.length
        ? `<tr><td colspan="5" class="muted">No DMA/zone matches "${escapeHtml(dmaFilterText)}".</td></tr>` : '';

      mapHost.innerHTML =
        `<div class="merge-map">
           <h3>Detected DMAs &mdash; auto-classified from Area No</h3>
           <div class="nrw-table-wrap nrw-scroll">
             <table class="nrw-tbl">
               <thead><tr>
                 <th data-sort="display" class="sortable">DMA${sortArrow(dmaSort, 'display')}</th>
                 <th data-sort="zones" class="sortable">Zones (prefix&#8209;book)${sortArrow(dmaSort, 'zones')}</th>
                 <th data-sort="files" class="sortable num">Files${sortArrow(dmaSort, 'files')}</th>
                 <th data-sort="rows" class="sortable num">Rows${sortArrow(dmaSort, 'rows')}</th>
                 <th>Output name</th>
               </tr></thead>
               <tbody>${body || emptyNote}</tbody>
             </table>
           </div>
           <p class="hint">Rows are mapped to DMAs automatically from the full Area-No allocation table
             (1.2, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1.2, 9.1, 9.2). A few book ranges are
             shared by two DMAs in that table (e.g. <code>32b</code> books 3&ndash;15 &rarr; both 2.2 and
             4.1.2) &mdash; those rows are included in both output files on purpose.
             Edit an <b>Output name</b> to rename or merge two rows; clear it to skip those rows.
             <b>Unmatched</b> rows are blank by default &mdash; type a DMA name to fold them in
             (remembered automatically for next time you see that zone).</p>
         </div>`;
      mapHost.querySelectorAll('.merge-dma').forEach(inp => {
        inp.addEventListener('input', () => {
          if (inp.getAttribute('data-unmatched') === '1') rememberName(inp.getAttribute('data-prefix'), inp.value.trim());
          renderPreview();
        });
      });
      mapHost.querySelectorAll('th.sortable').forEach(th => {
        th.addEventListener('click', () => {
          const col = th.getAttribute('data-sort');
          dmaSort = { col, dir: (dmaSort.col === col ? -dmaSort.dir : 1) };
          renderMap();
        });
      });
      renderPreview();
    }

    async function handleFiles(fileList) {
      if (busy) { log('Still processing the previous batch — click CANCEL first if you want to start over.', true); return; }
      const picked = Array.from(fileList || [])
        .filter(f => /\.xls[xm]?$/i.test(f.name) && !/^~\$/.test(f.name));
      if (!picked.length) { log('No .xlsx files found in the selection.', true); return; }
      if (typeof XLSX === 'undefined') {
        log('Excel library (SheetJS) is not loaded. Refresh the page and try again.', true);
        return;
      }

      // De-duplicate by name+size+modified time — guards against picking the same
      // folder twice, OS re-listing, etc. Matters most once you're past ~1000 files.
      const seen = new Set();
      const files = [];
      let dupSkipped = 0;
      for (const f of picked) {
        const key = f.name + '|' + f.size + '|' + (f.lastModified || 0);
        if (seen.has(key)) { dupSkipped++; continue; }
        seen.add(key);
        files.push(f);
      }

      const total = files.length;
      setBusy(true);
      genBtn.disabled = true;
      setProgress(0, total, 'Reading');
      log('Reading ' + total.toLocaleString() + ' file' + (total === 1 ? '' : 's') +
          (dupSkipped ? ` (${dupSkipped} duplicate${dupSkipped === 1 ? '' : 's'} skipped)` : '') + '…');

      const records = [];
      let cancelledAt = -1;
      try {
        for (let i = 0; i < total; i++) {
          if (cancelRequested) { cancelledAt = i; break; }
          const f = files[i];
          try {
            const buf = await f.arrayBuffer();
            // dense:true keeps large sheets as arrays internally — faster parse,
            // lower memory, which matters when reading hundreds/thousands of files.
            const wb = XLSX.read(buf, { type: 'array', cellDates: false, dense: true });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const aoa = ws ? XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false }) : [];
            records.push(API.fileToRecord(f.name, aoa));
          } catch (err) {
            // One corrupt/unreadable file must never abort the whole 1000-file batch.
            records.push({ name: f.name, ok: false, error: (err && err.message) || String(err), rows: [] });
          }
          if ((i + 1) % YIELD_EVERY === 0 || i === total - 1) {
            setProgress(i + 1, total, 'Reading');
            await sleep(0);   // yield so the tab stays responsive (Cancel, scrolling, repaint)
          }
        }
      } finally {
        setBusy(false);
      }

      if (cancelledAt >= 0) {
        log(`Cancelled after reading ${cancelledAt.toLocaleString()} of ${total.toLocaleString()} file(s). ` +
            'Select files again to restart.');
        genBtn.disabled = true;
        return;
      }

      // Drop whole files / rows that are exact re-exports of something already
      // read (order- and Sl.-agnostic — see dedupeRecords doc comment) BEFORE
      // classifying, so a re-exported book never gets double-counted in a DMA.
      const dedup = API.dedupeRecords(records);
      const dedupedRecords = dedup.records;

      const res = API.groupByDma(dedupedRecords);
      groups = res.groups;
      skipped = res.skipped;

      const okCount = dedupedRecords.filter(r => r.ok).length;
      const dmaGroups = groups.filter(g => g.matched !== false);
      const unmatchedGroups = groups.filter(g => g.matched === false);
      const totalRows = groups.reduce((s, g) => s + g.rows.length, 0);
      const unmatchedRows = unmatchedGroups.reduce((s, g) => s + g.rows.length, 0);
      const lines = [
        `Read ${okCount.toLocaleString()} of ${total.toLocaleString()} file(s) — ${totalRows.toLocaleString()} reading rows.`,
        `Classified into ${dmaGroups.length} DMA(s): ${dmaGroups.map(g => g.display).join(', ') || '—'}.`,
      ];
      if (dedup.duplicateFiles.length) {
        lines.push('\u2672 ' + dedup.duplicateFiles.length.toLocaleString() + ' file(s) were an exact re-export of ' +
          'another file (same customers, any row order) and were skipped: ' +
          dedup.duplicateFiles.slice(0, 20).join(', ') + (dedup.duplicateFiles.length > 20 ? ', …' : '') + '.');
      }
      if (dedup.duplicateRows) {
        lines.push('\u2672 ' + dedup.duplicateRows.toLocaleString() + ' additional duplicate row(s) (same customer, ' +
          'same reading, repeated across files) were collapsed to one.');
      }
      if (res.duplicatedRows) {
        lines.push('\u2139 ' + res.duplicatedRows.toLocaleString() + ' row(s) fall in an Area-No range shared by ' +
          'two DMAs in the allocation table and were included in both output files (by design).');
      }
      if (unmatchedRows) {
        lines.push('\u26A0 ' + unmatchedRows.toLocaleString() + ' row(s) matched no rule: ' +
          unmatchedGroups.map(g => g.display + ' (' + g.rows.length + ')').join(', ') +
          ' — skipped unless you give them a DMA name below.');
      }
      if (skipped.length) {
        lines.push('Ignored ' + skipped.length.toLocaleString() + ' file(s):');
        const shown = skipped.slice(0, 50);
        for (const s of shown) lines.push('  • ' + s.name + ' — ' + s.error);
        if (skipped.length > shown.length) lines.push(`  … and ${skipped.length - shown.length} more.`);
      }
      lines.push('Review the table below, then click GENERATE MERGED FILES.');
      log(lines.join('\n'));
      renderMap();
    }

    // Download a single DMA's workbook straight from the preview table, without
    // having to generate the whole set. `dmaName` matches an entry in lastOutputs.
    function downloadOne(dmaName) {
      if (busy) { log('Still busy — please wait.', true); return; }
      if (typeof XLSX === 'undefined') { log('Excel library (SheetJS) is not loaded.', true); return; }
      const outputs = API.assignDmas(groups, currentMapping());
      const o = outputs.find(x => x.dmaName === dmaName);
      if (!o) { log('That DMA is no longer available — refresh the list.', true); return; }
      try {
        const wb = API.buildWorkbook(o.dmaName, o.rows);
        const fileName = API.sanitizeFileName(o.dmaName) + '.xlsx';
        XLSX.writeFile(wb, fileName);
        log(`Saved ${fileName} — ${o.rows.length.toLocaleString()} rows (${zonesText(o.zones)}).`);
      } catch (err) {
        console.error(err);
        log('Error: ' + ((err && err.message) || String(err)), true);
      }
    }

    async function generate() {
      if (busy) { log('Still busy — please wait.', true); return; }
      if (!groups.length) { log('Select meter-reading files first.', true); return; }
      if (typeof XLSX === 'undefined') { log('Excel library (SheetJS) is not loaded.', true); return; }
      const outputs = API.assignDmas(groups, currentMapping());
      if (!outputs.length) { log('Nothing to generate.', true); return; }

      setBusy(true);
      genBtn.disabled = true;
      if (genCombinedBtn) genCombinedBtn.disabled = true;
      setProgress(0, outputs.length, 'Building');
      log('Building ' + outputs.length + ' workbook' + (outputs.length === 1 ? '' : 's') + '…');
      let cancelledAt = -1;
      try {
        const saved = [];
        for (let i = 0; i < outputs.length; i++) {
          if (cancelRequested) { cancelledAt = i; break; }
          const o = outputs[i];
          const wb = API.buildWorkbook(o.dmaName, o.rows);
          const fileName = API.sanitizeFileName(o.dmaName) + '.xlsx';
          XLSX.writeFile(wb, fileName);
          saved.push(`${fileName} — ${o.rows.length.toLocaleString()} rows (${zonesText(o.zones)})`);
          setProgress(i + 1, outputs.length, 'Building');
          if (i < outputs.length - 1) await sleep(450);   // let each download dispatch
        }
        if (cancelledAt >= 0) {
          log(`Cancelled after saving ${cancelledAt.toLocaleString()} of ${outputs.length.toLocaleString()} file(s):\n` +
              saved.map(s => '  • ' + s).join('\n'));
        } else {
          log('Saved ' + saved.length + ' file(s):\n' + saved.map(s => '  • ' + s).join('\n') +
              '\n\nFeed each file into NRW Report → Customer reading file.');
        }
      } catch (err) {
        console.error(err);
        log('Error: ' + ((err && err.message) || String(err)), true);
      } finally {
        setBusy(false);
        genBtn.disabled = false;
        if (genCombinedBtn) genCombinedBtn.disabled = false;
      }
    }

    // Alternative output: every DMA as its own sheet in ONE workbook, for users
    // who'd rather open a single file than juggle a dozen separate downloads.
    function uniqueSheetName(name, used) {
      let candidate = API.sanitizeSheetName(name);
      let n = 1;
      while (used.has(candidate.toLowerCase())) {
        n++;
        const suffix = '_' + n;
        candidate = candidate.slice(0, 31 - suffix.length) + suffix;
      }
      used.add(candidate.toLowerCase());
      return candidate;
    }

    async function generateCombined() {
      if (busy) { log('Still busy — please wait.', true); return; }
      if (!groups.length) { log('Select meter-reading files first.', true); return; }
      if (typeof XLSX === 'undefined') { log('Excel library (SheetJS) is not loaded.', true); return; }
      const outputs = API.assignDmas(groups, currentMapping());
      if (!outputs.length) { log('Nothing to generate.', true); return; }

      setBusy(true);
      genBtn.disabled = true;
      genCombinedBtn.disabled = true;
      log('Building one combined workbook — ' + outputs.length + ' sheet' + (outputs.length === 1 ? '' : 's') + '…');
      try {
        const wb = XLSX.utils.book_new();
        const used = new Set();
        let totalRows = 0;
        for (const o of outputs) {
          const single = API.buildWorkbook(o.dmaName, o.rows);
          const ws = single.Sheets[single.SheetNames[0]];
          XLSX.utils.book_append_sheet(wb, ws, uniqueSheetName(o.dmaName, used));
          totalRows += o.rows.length;
          await sleep(0);   // yield between sheets so very large batches don't freeze the tab
        }
        XLSX.writeFile(wb, 'All_DMAs_Merged.xlsx');
        log(`Saved All_DMAs_Merged.xlsx — ${outputs.length} sheet(s), ${totalRows.toLocaleString()} total rows.\n\n` +
            'Open the sheet you need, or feed the whole workbook into NRW Report one tab at a time.');
      } catch (err) {
        console.error(err);
        log('Error: ' + ((err && err.message) || String(err)), true);
      } finally {
        setBusy(false);
        genBtn.disabled = false;
        genCombinedBtn.disabled = false;
      }
    }

    function downloadIssues() {
      if (!lastIssueEntries.length) { log('No data-quality issues to export.', true); return; }
      if (typeof XLSX === 'undefined') { log('Excel library (SheetJS) is not loaded.', true); return; }
      const aoa = [['Reason', 'DMA'].concat(API.HEADERS)];
      for (const e of lastIssueEntries) aoa.push([e.reason, e.dma].concat(e.row));
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 30 }, { wch: 12 }].concat(new Array(API.HEADERS.length).fill({ wch: 14 }));
      ws['!autofilter'] = { ref: 'A1:' + XLSX.utils.encode_cell({ r: aoa.length - 1, c: aoa[0].length - 1 }) };
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Issues');
      XLSX.writeFile(wb, 'Customer_File_Builder_Issues.xlsx');
      log('Saved Customer_File_Builder_Issues.xlsx — ' + lastIssueEntries.length.toLocaleString() + ' flagged row(s).');
    }

    function clearAll() {
      cancelRequested = true;   // in case a read/generate is still winding down
      groups = []; skipped = []; lastOutputs = []; lastIssueEntries = [];
      dmaFilterText = ''; if (dmaFilterInput) dmaFilterInput.value = '';
      dmaSort = { col: 'display', dir: 1 };
      previewSort = { col: 'dmaName', dir: 1 };
      filesIn.value = ''; if (folderIn) folderIn.value = '';
      mapHost.innerHTML = '';
      if (preview) preview.innerHTML = '';
      if (statsHost) statsHost.innerHTML = '';
      if (qualityHost) qualityHost.innerHTML = '';
      if (dmaToolbar) dmaToolbar.hidden = true;
      genBtn.disabled = true;
      if (genCombinedBtn) genCombinedBtn.disabled = true;
      if (issuesBtn) issuesBtn.disabled = true;
      if (progressEl) progressEl.hidden = true;
      log('No files selected yet.');
    }

    filesIn.addEventListener('change', () => handleFiles(filesIn.files));
    if (folderIn) folderIn.addEventListener('change', () => handleFiles(folderIn.files));
    clearBtn && clearBtn.addEventListener('click', clearAll);
    cancelBtn && cancelBtn.addEventListener('click', () => { cancelRequested = true; });
    genBtn.addEventListener('click', generate);
    genCombinedBtn && genCombinedBtn.addEventListener('click', generateCombined);
    issuesBtn && issuesBtn.addEventListener('click', downloadIssues);
    dmaFilterInput && dmaFilterInput.addEventListener('input', () => {
      dmaFilterText = dmaFilterInput.value;
      renderMap();
    });
    forgetBtn && forgetBtn.addEventListener('click', forgetRememberedNames);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUI);
  } else {
    initUI();
  }
})(typeof window !== 'undefined' ? window : globalThis);
