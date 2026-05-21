/* KUKL Media Widgets
   Reusable building blocks so any tab can offer the same facilities
   as the main "NEW SURVEY" tab:
     - createCameraWidget : live video preview, photo snap with GPS/time
       overlay stamp, file-upload fallback, thumb strip with remove.
     - attachVoiceInput   : adds a microphone button to any textarea that
       streams speech-to-text via the Web Speech API.

   Self-contained — no dependencies on app.js or extra-sections.js.
*/
(function () {
  'use strict';

  // ---------- Tiny DOM helper ----------
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
  function toast(msg) {
    const t = document.getElementById('toast');
    if (t) {
      t.textContent = msg;
      t.classList.add('show');
      clearTimeout(toast._t);
      toast._t = setTimeout(() => t.classList.remove('show'), 2200);
      return;
    }
    // Fallback floating toast
    let n = document.getElementById('mwToast');
    if (!n) {
      n = el('div', { id: 'mwToast', style: 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#000;color:#fff;padding:10px 16px;font-size:12px;letter-spacing:1px;z-index:9999;text-transform:uppercase;' });
      document.body.appendChild(n);
    }
    n.textContent = msg;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => n.remove(), 2200);
  }

  // ---------- Geolocation (one-shot, low overhead) ----------
  function currentGps() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
        ()  => resolve(null),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 5000 }
      );
    });
  }

  // ---------- Camera widget ----------
  /**
   * createCameraWidget({ container, getId, getGps })
   *   container : HTMLElement to mount inside
   *   getId     : optional function returning a string ID stamped on photo
   *   getGps    : optional function returning { lat, lng, acc } (overrides geolocation)
   *
   * Returns: { getPhotos, reset, stop, root }
   */
  function createCameraWidget(opts) {
    const { container, getId, getGps } = opts || {};
    if (!container) throw new Error('createCameraWidget: container is required');

    const photos = [];   // [{ id, dataUrl, time, gps }]
    let stream = null;
    let facing = 'environment';

    // ----- DOM -----
    const video   = el('video', { autoplay: '', playsinline: '', muted: '' });
    const canvas  = el('canvas', { hidden: '' });
    const overlay = el('div', { class: 'cam-overlay' }, 'CAMERA OFF');

    const btnStart  = el('button', { type: 'button', class: 'btn' }, 'START CAMERA');
    const btnSwitch = el('button', { type: 'button', class: 'btn', disabled: '' }, 'SWITCH');
    const btnSnap   = el('button', { type: 'button', class: 'btn btn-primary', disabled: '' }, 'CAPTURE PHOTO');
    const btnStop   = el('button', { type: 'button', class: 'btn', disabled: '' }, 'STOP');

    const file      = el('input', { type: 'file', accept: 'image/*', multiple: '', hidden: '' });
    const uploadLbl = el('label', { class: 'btn btn-outline' }, 'UPLOAD', file);

    const controls  = el('div', { class: 'btn-row' }, btnStart, btnSwitch, btnSnap, btnStop, uploadLbl);
    const stage     = el('div', { class: 'camera-stage' }, video, canvas, overlay);
    const strip     = el('div', { class: 'thumb-strip' });

    const root = el('div', { class: 'mw-camera' }, controls, stage, strip);
    container.appendChild(root);

    function emptyStripNote() {
      return el('div', { class: 'thumb-empty' }, 'No photos captured yet.');
    }

    function renderStrip() {
      strip.innerHTML = '';
      if (!photos.length) { strip.appendChild(emptyStripNote()); return; }
      photos.forEach((p, idx) => {
        const thumb = el('div', { class: 'thumb' });
        const img   = el('img', { src: p.dataUrl, alt: '' });
        const x     = el('button', { type: 'button', class: 'del', title: 'Remove' }, '×');
        x.addEventListener('click', () => { photos.splice(idx, 1); renderStrip(); });
        thumb.appendChild(img);
        thumb.appendChild(x);
        strip.appendChild(thumb);
      });
    }
    renderStrip();

    // ----- Camera control -----
    async function startCam() {
      try {
        if (stream) stopCam();
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        video.srcObject = stream;
        await video.play().catch(() => {});
        overlay.style.display = 'none';
        btnStart.disabled = true; btnSnap.disabled = false; btnStop.disabled = false; btnSwitch.disabled = false;
      } catch (err) {
        console.error(err);
        toast('Camera unavailable: ' + (err.message || err.name));
      }
    }
    function stopCam() {
      if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
      video.srcObject = null;
      overlay.style.display = '';
      btnStart.disabled = false; btnSnap.disabled = true; btnStop.disabled = true; btnSwitch.disabled = true;
    }
    async function switchCam() {
      facing = (facing === 'environment') ? 'user' : 'environment';
      await startCam();
    }

    async function snap() {
      if (!stream) { toast('Camera not started'); return; }
      const w = video.videoWidth || 1280;
      const h = video.videoHeight || 720;
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, w, h);

      // Resolve gps + id for stamp
      const gps = (typeof getGps === 'function' ? getGps() : null) || await currentGps();
      const id  = typeof getId === 'function' ? (getId() || '') : '';
      const now = new Date();
      const stampLines = [
        `${now.toISOString().replace('T', ' ').slice(0, 19)}  ${id}`,
        gps && isFinite(gps.lat)
          ? `GPS  ${gps.lat.toFixed(6)}, ${gps.lng.toFixed(6)}  ±${(gps.acc || 0).toFixed(1)}m`
          : 'GPS  unavailable',
      ];

      const bandH = Math.max(56, Math.floor(h / 18));
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(0, h - bandH, w, bandH);
      ctx.fillStyle = '#fff';
      const fontSize = Math.max(14, Math.floor(w / 70));
      ctx.font = `bold ${fontSize}px monospace`;
      ctx.fillText(stampLines[0], 12, h - bandH + fontSize + 4);
      ctx.fillText(stampLines[1], 12, h - 12);

      const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
      photos.push({
        id: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        dataUrl,
        time: now.toISOString(),
        gps: gps || null,
      });
      renderStrip();
      toast('Photo captured');
    }

    // ----- File upload fallback -----
    file.addEventListener('change', async () => {
      for (const f of file.files) {
        if (!/^image\//.test(f.type)) continue;
        try {
          const dataUrl = await readAsDataURL(f);
          photos.push({
            id: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            dataUrl,
            time: new Date().toISOString(),
            gps: null,
            name: f.name,
          });
        } catch (e) { console.error(e); }
      }
      file.value = '';
      renderStrip();
    });

    btnStart .addEventListener('click', startCam);
    btnSwitch.addEventListener('click', switchCam);
    btnSnap  .addEventListener('click', snap);
    btnStop  .addEventListener('click', stopCam);

    return {
      root,
      getPhotos: () => photos.slice(),
      reset: () => { photos.length = 0; renderStrip(); },
      stop:  () => stopCam(),
    };
  }

  function readAsDataURL(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload  = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(file);
    });
  }

  // ---------- Voice (Speech-to-text) ----------
  /**
   * attachVoiceInput(textarea, { lang })
   *   textarea : HTMLTextAreaElement | HTMLInputElement
   *   lang     : BCP-47 code (default 'en-US')
   *
   * Inserts a ● MIC button right after the textarea. While recording,
   * interim results stream into the textarea; final results are kept.
   *
   * Returns: { stop, isSupported }
   */
  function attachVoiceInput(textarea, options) {
    const lang = (options && options.lang) || 'en-US';
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

    const btn = el('button', { type: 'button', class: 'btn btn-mini mw-mic', title: 'Voice to text' }, '● MIC');
    if (!SR) {
      btn.disabled = true;
      btn.title = 'Speech recognition not supported';
    }
    if (textarea && textarea.parentNode) {
      textarea.parentNode.insertBefore(btn, textarea.nextSibling);
    }
    if (!SR) return { stop: () => {}, isSupported: false };

    let rec = null;
    let active = false;
    let baseText = '';

    function start() {
      if (active) return;
      rec = new SR();
      rec.lang = lang;
      rec.interimResults = true;
      rec.continuous = true;
      baseText = textarea.value.trim();
      rec.onresult = (ev) => {
        let interim = '';
        let final   = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i];
          if (r.isFinal) final += r[0].transcript;
          else interim += r[0].transcript;
        }
        const merged = [baseText, (final + interim).trim()].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        textarea.value = merged;
        if (final) baseText = merged;
      };
      rec.onend = () => { active = false; btn.classList.remove('mw-mic-active'); btn.textContent = '● MIC'; };
      rec.onerror = (e) => { toast('Mic: ' + (e.error || 'error')); };
      rec.start();
      active = true;
      btn.classList.add('mw-mic-active');
      btn.textContent = '■ STOP';
    }
    function stop() {
      if (rec && active) { try { rec.stop(); } catch {} }
      active = false;
    }
    btn.addEventListener('click', () => active ? stop() : start());
    return { stop, isSupported: true };
  }

  // ---------- Export ----------
  window.KUKLMedia = {
    createCameraWidget,
    attachVoiceInput,
    currentGps,
  };
})();
