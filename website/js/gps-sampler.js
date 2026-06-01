/* KUKL GPS Sampler — best-of-N high-accuracy capture panel.
   Exposes: window.KUKLGps.createPanel({ container, title, autoStart }) → API.
   API:  getGps()  -> { lat, lng, acc, samples, capturedAt } | null
         setGps(g) -> populate from saved record (read-only display)
         reset()
         root      -> DOM element
*/
(function () {
  'use strict';

  const SAMPLE_WINDOW_MS = 15000; // collect for ~15 s (longer for better L5 convergence)
  const MAX_SAMPLES      = 20;   // increased for dual-freq high-rate chips
  const TARGET_L5        = 1;    // L5 phones can achieve ≤1m
  const TARGET_L1        = 2.5;  // single-freq fallback

  function fmt(n, d) { return (n === null || n === undefined || isNaN(n)) ? '—' : Number(n).toFixed(d); }
  function nowISO()   { return new Date().toISOString(); }

  function createPanel(opts) {
    opts = opts || {};
    const container = opts.container;
    const title     = opts.title || 'GPS LOCATION';
    if (!container) throw new Error('KUKLGps.createPanel: container required');

    const root = document.createElement('div');
    root.className = 'card gps-panel-card';
    root.innerHTML = `
      <h3 class="card-title gps-panel-title">
        <span>${title}</span>
        <span class="gps-panel-status" data-role="status">IDLE</span>
      </h3>
      <div class="gps-grid">
        <div class="gps-cell"><label>Latitude</label><output data-role="lat">—</output></div>
        <div class="gps-cell"><label>Longitude</label><output data-role="lng">—</output></div>
        <div class="gps-cell"><label>Accuracy (m)</label><output data-role="acc">—</output></div>
        <div class="gps-cell"><label>Best (m)</label><output data-role="best">—</output></div>
        <div class="gps-cell"><label>Samples</label><output data-role="samples">0</output></div>
        <div class="gps-cell wide"><label>Captured At</label><output data-role="captured">—</output></div>
      </div>
      <div class="gps-actions">
        <button type="button" class="btn btn-primary" data-role="capture">📍 CAPTURE LOCATION</button>
        <button type="button" class="btn btn-outline" data-role="stop" hidden>STOP</button>
        <button type="button" class="btn btn-ghost"   data-role="clear" hidden>CLEAR</button>
      </div>
      <p class="gps-hint" data-role="hint">Tap CAPTURE LOCATION for a 15-second dual-freq GNSS fix (L1+L5 if supported).</p>
    `;
    container.appendChild(root);

    const $ = sel => root.querySelector(`[data-role="${sel}"]`);
    const els = {
      status:   $('status'),
      lat:      $('lat'),
      lng:      $('lng'),
      acc:      $('acc'),
      best:     $('best'),
      samples:  $('samples'),
      captured: $('captured'),
      capture:  $('capture'),
      stop:     $('stop'),
      clear:    $('clear'),
      hint:     $('hint'),
    };

    let watchId   = null;
    let timerId   = null;
    let samples   = [];
    let bestFix   = null;     // {lat,lng,acc}
    let finalGps  = null;     // committed reading
    let capturing = false;

    function setStatus(text, cls) {
      els.status.textContent = text;
      els.status.classList.remove('ok','warn','err','run');
      if (cls) els.status.classList.add(cls);
    }

    function render() {
      const cur = bestFix || (samples.length ? samples[samples.length - 1] : null);
      els.lat.textContent     = cur ? fmt(cur.lat, 6) : '—';
      els.lng.textContent     = cur ? fmt(cur.lng, 6) : '—';
      els.acc.textContent     = cur ? fmt(cur.acc, 1) : '—';
      els.best.textContent    = bestFix ? fmt(bestFix.acc, 1) : '—';
      els.samples.textContent = String(samples.length);
      els.captured.textContent = finalGps ? new Date(finalGps.capturedAt).toLocaleString() : '—';
    }

    function detectBand() {
      if (samples.length < 3) return '';
      const sub2 = samples.filter(s => s.acc < 2).length;
      if (sub2 >= 2) return ' [DUAL-FREQ L1+L5]';
      return ' [SINGLE-FREQ L1]';
    }

    function stopCapture(commit) {
      if (!capturing) return;
      capturing = false;
      if (watchId !== null && navigator.geolocation) {
        try { navigator.geolocation.clearWatch(watchId); } catch (_) {}
      }
      watchId = null;
      if (timerId) { clearTimeout(timerId); timerId = null; }
      els.stop.hidden = true;
      els.capture.hidden = false;
      els.clear.hidden = false;

      if (commit && bestFix) {
        finalGps = {
          lat: +bestFix.lat.toFixed(7),
          lng: +bestFix.lng.toFixed(7),
          acc: +bestFix.acc.toFixed(2),
          samples: samples.length,
          capturedAt: nowISO(),
        };
        setStatus('CAPTURED', 'ok');
        const band = detectBand();
        els.hint.textContent = `Locked best fix (±${finalGps.acc} m from ${finalGps.samples} samples)${band}`;
        if (typeof opts.onCapture === 'function') {
          try { opts.onCapture({ ...finalGps }, { hint: els.hint, root }); }
          catch (e) { console.warn('[KUKLGps] onCapture handler failed', e); }
        }
      } else if (!bestFix) {
        setStatus('NO FIX', 'err');
        els.hint.textContent = 'No GPS fix obtained. Move outdoors and retry.';
      } else {
        setStatus('STOPPED', 'warn');
      }
      render();
    }

    function startCapture() {
      if (capturing) return;
      if (!navigator.geolocation) {
        setStatus('NO GPS', 'err');
        els.hint.textContent = 'Geolocation is not supported on this device.';
        return;
      }
      samples  = [];
      bestFix  = null;
      finalGps = null;
      capturing = true;
      setStatus('SAMPLING…', 'run');
      els.hint.textContent = 'Collecting dual-freq GNSS samples — hold device steady, sky visible.';
      els.capture.hidden = true;
      els.stop.hidden    = false;
      els.clear.hidden   = true;
      render();

      watchId = navigator.geolocation.watchPosition(
        pos => {
          const c = pos.coords || {};
          if (typeof c.latitude !== 'number' || typeof c.longitude !== 'number') return;
          if (!isFinite(c.accuracy) || c.accuracy <= 0) return;
          const s = { lat: c.latitude, lng: c.longitude, acc: c.accuracy };
          samples.push(s);
          if (!bestFix || s.acc < bestFix.acc) bestFix = s;
          // Auto-lock early if L5-quality achieved (best < 1m with 3+ samples)
          const thresh = (bestFix.acc < 2 && samples.length >= 5) ? TARGET_L5 : TARGET_L1;
          if (bestFix.acc <= thresh && samples.length >= 5) stopCapture(true);
          else if (samples.length >= MAX_SAMPLES) stopCapture(true);
          else render();
        },
        err => {
          setStatus('ERR ' + (err && err.code), 'err');
          els.hint.textContent = (err && err.message) || 'Geolocation error.';
          stopCapture(false);
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
      );

      timerId = setTimeout(() => stopCapture(true), SAMPLE_WINDOW_MS);
    }

    function reset() {
      stopCapture(false);
      samples = [];
      bestFix = null;
      finalGps = null;
      setStatus('IDLE');
      els.hint.textContent = 'Tap CAPTURE LOCATION for a 15-second dual-freq GNSS fix (L1+L5 if supported).';
      els.clear.hidden = true;
      render();
    }

    function setGps(g) {
      if (!g || typeof g.lat !== 'number') { reset(); return; }
      finalGps = {
        lat: g.lat, lng: g.lng,
        acc: g.acc ?? null,
        samples: g.samples ?? 0,
        capturedAt: g.capturedAt || nowISO(),
      };
      bestFix = { lat: g.lat, lng: g.lng, acc: g.acc ?? 0 };
      samples = new Array(g.samples || 0).fill(bestFix);
      setStatus('SAVED', 'ok');
      els.hint.textContent = 'Loaded saved location. Tap CAPTURE LOCATION to refresh.';
      els.clear.hidden = false;
      els.capture.hidden = false;
      els.stop.hidden = true;
      render();
    }

    els.capture.addEventListener('click', startCapture);
    els.stop.addEventListener('click', () => stopCapture(true));
    els.clear.addEventListener('click', reset);

    reset();
    if (opts.autoStart) setTimeout(startCapture, 250);

    return {
      root,
      getGps: () => finalGps ? { ...finalGps } : null,
      setGps,
      reset,
      isCapturing: () => capturing,
      _els: els,
    };
  }

  window.KUKLGps = { createPanel };
})();
