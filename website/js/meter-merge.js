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

  // Area-No -> DMA mapping (from the field note). Each rule matches a zone prefix
  // plus either an explicit set of book numbers (`nums`) or an inclusive range
  // (`min`..`max`). First matching rule wins.
  const DMA_RULES = [
    { dma: 'dma 3.4',   prefix: '32d',   nums: [1, 2, 3, 4, 5] },
    { dma: 'dma 3.4',   prefix: '9a',    nums: [25, 26, 27, 29] },
    { dma: 'dma 3.4',   prefix: '9b',    nums: [1, 2, 3, 4, 5, 6] },
    { dma: 'dma 9.1',   prefix: '32g',   min: 1,  max: 18 },
    { dma: 'dma 9.1',   prefix: '32f',   min: 1,  max: 27 },
    { dma: 'dma 9.1',   prefix: '35kha', min: 1,  max: 17 },
    { dma: 'dma 9.1',   prefix: '35ga',  min: 1,  max: 8 },
    { dma: 'dma 4.1.2', prefix: '32b',   min: 3,  max: 15 },
    { dma: 'dma 2.3',   prefix: '9c',    min: 1,  max: 20 },
    { dma: 'dma 2.4',   prefix: '9c',    min: 22, max: 29 },
    { dma: 'dma 2.4',   prefix: '9a',    min: 1,  max: 22 },
    { dma: 'dma 3.5',   prefix: '9b',    min: 8,  max: 29 },
  ];

  function classifyArea(v) {
    const p = parseArea(v);
    if (!p) return null;
    for (const rule of DMA_RULES) {
      if (rule.prefix !== p.prefix) continue;
      if (rule.nums) { if (rule.nums.indexOf(p.num) >= 0) return rule.dma; }
      else if (p.num >= rule.min && p.num <= rule.max) return rule.dma;
    }
    return null;
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

  // ---------- pure: classify every row into a DMA (matched) or a leftover zone ----------
  // Matched rows are bucketed by DMA; unmatched rows are bucketed per zone so the
  // user can assign each leftover individually.
  function groupByDma(records) {
    const dmaGroups = new Map();   // dmaKey -> group
    const leftover  = new Map();   // 'unmatched:<zone>' -> group
    const skipped = [];
    for (const rec of records) {
      if (!rec.ok) { skipped.push({ name: rec.name, error: rec.error }); continue; }
      for (const row of rec.rows) {
        const area = row[IDX['Area No']];
        const dma  = classifyArea(area);
        const zl   = zoneLabel(area);
        let g;
        if (dma) {
          const key = dma.toLowerCase();
          g = dmaGroups.get(key);
          if (!g) { g = { key, kind: 'dma', display: dma, defaultName: dma, matched: true, rows: [], files: new Set(), zones: new Map() }; dmaGroups.set(key, g); }
        } else {
          const key = 'unmatched:' + zl.toLowerCase();
          g = leftover.get(key);
          if (!g) { g = { key, kind: 'unmatched', display: zl, defaultName: '', matched: false, rows: [], files: new Set(), zones: new Map() }; leftover.set(key, g); }
        }
        g.rows.push(row);
        g.files.add(rec.name);
        g.zones.set(zl, (g.zones.get(zl) || 0) + 1);
      }
    }
    const byName = (a, b) => a.display.localeCompare(b.display, undefined, { numeric: true, sensitivity: 'base' });
    const dmaList  = Array.from(dmaGroups.values()).sort(byName);
    const leftList = Array.from(leftover.values()).sort(byName);
    return { groups: dmaList.concat(leftList), skipped };
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
    parseArea,
    zoneLabel,
    areaPrefix,
    sanitizeFileName,
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
    const filesIn  = $('mergeFiles');
    const folderIn = $('mergeFolder');
    const clearBtn = $('mergeClear');
    const genBtn   = $('mergeGenerate');
    const mapHost  = $('mergeMapHost');
    const preview  = $('mergePreview');
    const logEl    = $('mergeLog');
    if (!filesIn || !genBtn) return;   // tool not on this page

    let groups = [];      // current grouped zones
    let skipped = [];     // files that were ignored

    function log(msg, isError) {
      if (!logEl) return;
      logEl.style.color = isError ? '#a8001a' : '';
      logEl.textContent = msg;
    }

    function currentMapping() {
      const map = {};
      mapHost.querySelectorAll('.merge-dma').forEach(inp => {
        map[inp.getAttribute('data-prefix')] = inp.value;
      });
      return map;
    }

    function renderPreview() {
      if (!preview) return;
      if (!groups.length) { preview.innerHTML = ''; return; }
      const outputs = API.assignDmas(groups, currentMapping());
      genBtn.disabled = outputs.length === 0;
      const rowsHtml = outputs.map(o =>
        `<tr>
           <td><b>${escapeHtml(API.sanitizeFileName(o.dmaName))}.xlsx</b></td>
           <td>${escapeHtml(zonesText(o.zones))}</td>
           <td class="num">${o.files.size}</td>
           <td class="num">${o.rows.length}</td>
         </tr>`).join('');
      preview.innerHTML =
        `<div class="nrw-preview">
           <h3>Output preview &mdash; ${outputs.length} file${outputs.length === 1 ? '' : 's'} will be created</h3>
           <div class="nrw-table-wrap nrw-scroll">
             <table class="nrw-tbl">
               <thead><tr><th>Output file</th><th>Merged zones</th><th class="num">Src files</th><th class="num">Rows</th></tr></thead>
               <tbody>${rowsHtml}</tbody>
             </table>
           </div>
         </div>`;
    }

    function renderMap() {
      if (!groups.length) {
        mapHost.innerHTML = '';
        genBtn.disabled = true;
        return;
      }
      const body = groups.map(g => {
        const unmatched = g.matched === false;
        const ph = unmatched ? 'type a DMA to include' : '';
        const label = unmatched
          ? '<span class="merge-warn">unmatched</span>'
          : '<code>' + escapeHtml(g.display) + '</code>';
        return `<tr class="${unmatched ? 'merge-unmatched' : ''}">
           <td>${label}</td>
           <td>${escapeHtml(zonesText(g.zones))}</td>
           <td class="num">${g.files.size}</td>
           <td class="num">${g.rows.length}</td>
           <td><input class="merge-dma" type="text" data-prefix="${escapeHtml(g.key)}"
                      value="${escapeHtml(g.defaultName)}" placeholder="${ph}" autocomplete="off" spellcheck="false" /></td>
         </tr>`;
      }).join('');
      mapHost.innerHTML =
        `<div class="merge-map">
           <h3>Detected DMAs &mdash; auto-classified from Area No</h3>
           <div class="nrw-table-wrap nrw-scroll">
             <table class="nrw-tbl">
               <thead><tr><th>DMA</th><th>Zones (prefix&#8209;book)</th><th class="num">Files</th><th class="num">Rows</th><th>Output name</th></tr></thead>
               <tbody>${body}</tbody>
             </table>
           </div>
           <p class="hint">Rows are mapped to DMAs automatically from the Area-No rules
             (e.g. <code>35ga</code>/<code>35kha</code> &rarr; 9.1, <code>32b</code> books 3&ndash;15 &rarr; 4.1.2).
             Edit an <b>Output name</b> to rename or merge two rows; clear it to skip those rows.
             <b>Unmatched</b> rows are blank by default &mdash; type a DMA name to fold them in.</p>
         </div>`;
      mapHost.querySelectorAll('.merge-dma').forEach(inp => {
        inp.addEventListener('input', renderPreview);
      });
      renderPreview();
    }

    async function handleFiles(fileList) {
      const files = Array.from(fileList || [])
        .filter(f => /\.xls[xm]?$/i.test(f.name) && !/^~\$/.test(f.name));
      if (!files.length) { log('No .xlsx files found in the selection.', true); return; }
      if (typeof XLSX === 'undefined') {
        log('Excel library (SheetJS) is not loaded. Refresh the page and try again.', true);
        return;
      }
      log('Reading ' + files.length + ' file' + (files.length === 1 ? '' : 's') + '…');
      const records = [];
      for (const f of files) {
        try {
          const buf = await f.arrayBuffer();
          const wb = XLSX.read(buf, { type: 'array', cellDates: false });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const aoa = ws ? XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false }) : [];
          records.push(API.fileToRecord(f.name, aoa));
        } catch (err) {
          records.push({ name: f.name, ok: false, error: (err && err.message) || String(err), rows: [] });
        }
      }
      const res = API.groupByDma(records);
      groups = res.groups;
      skipped = res.skipped;

      const okCount = records.filter(r => r.ok).length;
      const dmaGroups = groups.filter(g => g.matched !== false);
      const unmatchedGroups = groups.filter(g => g.matched === false);
      const totalRows = groups.reduce((s, g) => s + g.rows.length, 0);
      const unmatchedRows = unmatchedGroups.reduce((s, g) => s + g.rows.length, 0);
      const lines = [
        `Read ${okCount} of ${files.length} file(s) — ${totalRows} reading rows.`,
        `Classified into ${dmaGroups.length} DMA(s): ${dmaGroups.map(g => g.display).join(', ') || '—'}.`,
      ];
      if (unmatchedRows) {
        lines.push('\u26A0 ' + unmatchedRows + ' row(s) matched no rule: ' +
          unmatchedGroups.map(g => g.display + ' (' + g.rows.length + ')').join(', ') +
          ' — skipped unless you give them a DMA name below.');
      }
      if (skipped.length) {
        lines.push('Ignored ' + skipped.length + ' file(s):');
        for (const s of skipped) lines.push('  • ' + s.name + ' — ' + s.error);
      }
      lines.push('Review the table below, then click GENERATE MERGED FILES.');
      log(lines.join('\n'));
      renderMap();
    }

    async function generate() {
      if (!groups.length) { log('Select meter-reading files first.', true); return; }
      if (typeof XLSX === 'undefined') { log('Excel library (SheetJS) is not loaded.', true); return; }
      const outputs = API.assignDmas(groups, currentMapping());
      if (!outputs.length) { log('Nothing to generate.', true); return; }

      genBtn.disabled = true;
      log('Building ' + outputs.length + ' workbook' + (outputs.length === 1 ? '' : 's') + '…');
      try {
        const saved = [];
        for (let i = 0; i < outputs.length; i++) {
          const o = outputs[i];
          const wb = API.buildWorkbook(o.dmaName, o.rows);
          const fileName = API.sanitizeFileName(o.dmaName) + '.xlsx';
          XLSX.writeFile(wb, fileName);
          saved.push(`${fileName} — ${o.rows.length} rows (${zonesText(o.zones)})`);
          if (i < outputs.length - 1) await sleep(450);   // let each download dispatch
        }
        log('Saved ' + saved.length + ' file(s):\n' + saved.map(s => '  • ' + s).join('\n') +
            '\n\nFeed each file into NRW Report → Customer reading file.');
      } catch (err) {
        console.error(err);
        log('Error: ' + ((err && err.message) || String(err)), true);
      } finally {
        genBtn.disabled = false;
      }
    }

    function clearAll() {
      groups = []; skipped = [];
      filesIn.value = ''; if (folderIn) folderIn.value = '';
      mapHost.innerHTML = '';
      if (preview) preview.innerHTML = '';
      genBtn.disabled = true;
      log('No files selected yet.');
    }

    filesIn.addEventListener('change', () => handleFiles(filesIn.files));
    if (folderIn) folderIn.addEventListener('change', () => handleFiles(folderIn.files));
    clearBtn && clearBtn.addEventListener('click', clearAll);
    genBtn.addEventListener('click', generate);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUI);
  } else {
    initUI();
  }
})(typeof window !== 'undefined' ? window : globalThis);
