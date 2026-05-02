// ─────────────────────────────────────────────────────────────────
//  Mapleproof — retailer.js  (mobile-first)
//  - Manual entry is the DEFAULT (works without camera)
//  - Camera is an opt-in mode the cashier turns on with a button
//  - Result modal shows for 19 seconds then auto-clears
//  - No "next customer" button — auto re-arms after countdown
// ─────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  const RESULT_DURATION_MS = 19_000;
  const DUPLICATE_DEBOUNCE = 1_500;

  // ── DOM ────────────────────────────────────────────────────────
  const modeManualBtn   = document.getElementById('mode-manual');
  const modeCameraBtn   = document.getElementById('mode-camera');
  const modeUploadBtn   = document.getElementById('mode-upload');
  const sectionManual   = document.getElementById('section-manual');
  const sectionCamera   = document.getElementById('section-camera');
  const sectionUpload   = document.getElementById('section-upload');

  const cameraPrompt    = document.getElementById('camera-prompt');
  const cameraActive    = document.getElementById('camera-active');
  const startCameraBtn  = document.getElementById('start-camera-btn');
  const stopCameraBtn   = document.getElementById('stop-camera-btn');
  const video           = document.getElementById('retailer-video');

  const manualInput     = document.getElementById('manual-token');
  const manualBtn       = document.getElementById('manual-lookup');

  const uploadInput     = document.getElementById('retailer-upload-input');
  const uploadThumb     = document.getElementById('retailer-upload-thumb');
  const uploadStatus    = document.getElementById('retailer-upload-status');

  const overlay         = document.getElementById('result-overlay');
  const card            = document.getElementById('result-card');
  const toneStrip       = document.getElementById('res-tone-strip');
  const titleEl         = document.getElementById('res-title');
  const subtitleEl      = document.getElementById('res-subtitle');
  const photoEl         = document.getElementById('res-photo');
  const ageEl           = document.getElementById('res-age-badge');
  const statusEl        = document.getElementById('res-status');
  const matchEl         = document.getElementById('res-match');
  const scansEl         = document.getElementById('res-scans');
  const flagsWrap       = document.getElementById('res-flags-wrap');
  const flagsList       = document.getElementById('res-flags-list');
  const countdownNum    = document.getElementById('countdown-num');
  const countdownArc    = document.getElementById('countdown-prog');

  let codeReader = null;
  let lastScannedToken = '';
  let lastScannedAt = 0;
  let countdownTimer = null;
  let clearTimer = null;

  // ── MODE TOGGLE (3 modes: manual, camera, upload) ──────────────
  function setMode(mode) {
    [modeManualBtn, modeCameraBtn, modeUploadBtn].forEach(b => b?.classList.remove('active'));
    [sectionManual, sectionCamera, sectionUpload].forEach(s => s?.classList.remove('active'));
    if (mode === 'manual') {
      modeManualBtn?.classList.add('active');
      sectionManual?.classList.add('active');
      stopCamera();
      setTimeout(() => manualInput.focus(), 50);
    } else if (mode === 'camera') {
      modeCameraBtn?.classList.add('active');
      sectionCamera?.classList.add('active');
    } else if (mode === 'upload') {
      modeUploadBtn?.classList.add('active');
      sectionUpload?.classList.add('active');
      stopCamera();
    }
  }
  modeManualBtn?.addEventListener('click', () => setMode('manual'));
  modeCameraBtn?.addEventListener('click', () => setMode('camera'));
  modeUploadBtn?.addEventListener('click', () => setMode('upload'));

  // ── UPLOAD MODE — scan a photo of the customer's pass barcode ──
  async function handleUploadedPassImage(file) {
    if (!file) return;
    if (uploadStatus) uploadStatus.querySelector('span').textContent = 'Reading barcode…';
    try {
      // Resize for speed
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const img = new Image();
          img.onload = () => {
            const maxDim = 1400;
            let w = img.width, h = img.height;
            if (w > maxDim || h > maxDim) {
              const s = Math.min(maxDim / w, maxDim / h);
              w = Math.round(w * s); h = Math.round(h * s);
            }
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            c.getContext('2d').drawImage(img, 0, 0, w, h);
            resolve(c.toDataURL('image/jpeg', 0.9));
          };
          img.onerror = reject;
          img.src = reader.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      // Show thumbnail preview
      if (uploadThumb) {
        uploadThumb.classList.add('has-image');
        uploadThumb.style.backgroundImage = `url('${dataUrl}')`;
      }

      // ZXing — try to detect a Code 128 (or any 1D barcode) in the image
      if (!window.ZXing) throw new Error('Barcode library not loaded.');
      const hints = new Map();
      hints.set(window.ZXing.DecodeHintType.POSSIBLE_FORMATS, [
        window.ZXing.BarcodeFormat.CODE_128,
        window.ZXing.BarcodeFormat.CODE_39,
        window.ZXing.BarcodeFormat.QR_CODE
      ]);
      hints.set(window.ZXing.DecodeHintType.TRY_HARDER, true);

      const reader = new window.ZXing.BrowserMultiFormatReader(hints);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
      const result = await reader.decodeFromImageElement(img);
      const text = result.getText();
      if (uploadStatus) uploadStatus.querySelector('span').textContent = `Found: ${text}`;
      lookupToken(text);
    } catch (err) {
      console.error('[retailer] upload decode failed:', err);
      if (uploadStatus) uploadStatus.querySelector('span').textContent =
        'Could not read a barcode from that photo. Try a clearer, well-lit photo, or type the code manually.';
    }
  }
  uploadInput?.addEventListener('change', e => handleUploadedPassImage(e.target.files[0]));

  // ── MANUAL ENTRY ───────────────────────────────────────────────
  function doManualLookup() {
    const t = (manualInput.value || '').toUpperCase().trim();
    if (!t) {
      manualInput.focus();
      return;
    }
    lookupToken(t);
  }
  manualBtn.addEventListener('click', doManualLookup);
  manualInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doManualLookup();
    }
  });
  manualInput.addEventListener('input', () => {
    manualInput.value = manualInput.value.toUpperCase();
  });

  // ── CAMERA SCANNER (opt-in) ────────────────────────────────────
  startCameraBtn.addEventListener('click', startCamera);
  stopCameraBtn.addEventListener('click', stopCamera);

  function startCamera() {
    if (!window.ZXing) {
      alert('Barcode library failed to load. Please refresh the page.');
      return;
    }
    cameraPrompt.hidden = true;
    cameraActive.hidden = false;

    const hints = new Map();
    hints.set(window.ZXing.DecodeHintType.POSSIBLE_FORMATS, [
      window.ZXing.BarcodeFormat.CODE_128,
      window.ZXing.BarcodeFormat.CODE_39,
      window.ZXing.BarcodeFormat.QR_CODE
    ]);
    hints.set(window.ZXing.DecodeHintType.TRY_HARDER, true);

    codeReader = new window.ZXing.BrowserMultiFormatReader(hints);

    codeReader.decodeFromVideoDevice(undefined, 'retailer-video', (result, err) => {
      if (result) {
        const text = result.getText();
        const now = Date.now();
        if (text === lastScannedToken && now - lastScannedAt < DUPLICATE_DEBOUNCE) return;
        lastScannedToken = text;
        lastScannedAt = now;
        lookupToken(text);
      }
    }).catch(err => {
      console.error('Camera failed:', err);
      cameraPrompt.hidden = false;
      cameraActive.hidden = true;
      alert('Could not access camera. Make sure you granted camera permission, or use manual entry instead.');
    });
  }

  function stopCamera() {
    if (codeReader) {
      try { codeReader.reset(); } catch {}
      codeReader = null;
    }
    cameraPrompt.hidden = false;
    cameraActive.hidden = true;
  }

  // ── LOOKUP ─────────────────────────────────────────────────────
  async function lookupToken(rawToken) {
    const token = String(rawToken || '').toUpperCase().trim();
    console.log('[mapleproof] Looking up token:', token);

    if (!token) {
      showError('Please enter a barcode.');
      return;
    }

    if (!/^[A-Z0-9]{6,16}$/.test(token)) {
      showError(`Invalid format: "${token}" — expected 6–16 letters and numbers.`);
      return;
    }

    try {
      const resp = await fetch(`/api/pass/${encodeURIComponent(token)}`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
      console.log('[mapleproof] Response status:', resp.status);

      let data;
      try {
        data = await resp.json();
      } catch (e) {
        showError(`Server returned non-JSON response (status ${resp.status}).`);
        return;
      }

      console.log('[mapleproof] Response data:', data);

      if (resp.status === 404 || (!resp.ok && !data.ok)) {
        showResult({
          tone: 'denied',
          title: 'Pass not found',
          subtitle: data.error || `No record for "${token}". Check ID directly.`,
          photo: '', age: '—', status: 'Not registered', scans: '—',
          flags: ['UNKNOWN_PASS']
        });
        return;
      }

      if (!resp.ok || !data.ok) {
        showError(data.error || `Lookup failed (status ${resp.status}).`);
        return;
      }

      const r = data.publicRecord;
      const isExpired   = r.expiryStatus === 'expired';
      const isUnder     = r.ageBadge === '18+' || r.ageBadge === 'UNDER';
      const matchStatus = r.faceMatchStatus || 'unknown';
      const matchScore  = r.faceMatchScore;
      const matchFail   = matchStatus === 'fail';
      const matchWeak   = matchStatus === 'weak';

      const tone = (isExpired || isUnder || matchFail)
        ? 'denied'
        : ((matchWeak || (r.flags && r.flags.length)) ? 'warning' : 'approved');

      let matchText = '—';
      if (matchScore !== null && matchScore !== undefined) {
        const pct = Math.round(matchScore * 100);
        matchText = matchStatus === 'strong' ? `${pct}% ✓`
                  : matchStatus === 'weak'   ? `${pct}% (weak)`
                  : matchStatus === 'fail'   ? `${pct}% ✗`
                  : `${pct}%`;
      }

      showResult({
        tone,
        title: tone === 'approved' ? 'Verified'
              : tone === 'warning' ? 'Verified — see alerts'
              : 'NOT VERIFIED',
        subtitle: tone === 'approved'
              ? 'Photo match confirmed'
              : tone === 'warning'
              ? 'Cashier discretion advised'
              : (matchFail ? 'Photo does not match ID' : 'Cashier discretion required'),
        photo: r.faceImage,
        age: r.ageBadge,
        status: r.verified ? 'Registered & verified' : 'Registered · check ID',
        match: matchText,
        matchStatus,
        scans: String(r.scanCount || 1),
        flags: r.flags || []
      });
    } catch (err) {
      console.error('[mapleproof] Network error:', err);
      showError('Network error: ' + (err.message || 'unable to reach server'));
    }
  }

  function showError(msg) {
    showResult({
      tone: 'denied',
      title: 'Lookup failed',
      subtitle: msg,
      photo: '', age: '—', status: '—', match: '—', matchStatus: 'unknown', scans: '—',
      flags: []
    });
  }

  // ── RENDER RESULT ──────────────────────────────────────────────
  function showResult(r) {
    card.classList.remove('tone-approved', 'tone-warning', 'tone-denied');
    card.classList.add(`tone-${r.tone}`);

    titleEl.textContent      = r.title;
    subtitleEl.textContent   = r.subtitle;
    photoEl.src              = r.photo || '';
    photoEl.style.display    = r.photo ? 'block' : 'none';
    ageEl.textContent        = r.age;
    statusEl.textContent     = r.status;
    scansEl.textContent      = r.scans;

    if (matchEl) {
      matchEl.textContent = r.match || '—';
      matchEl.style.color =
        r.matchStatus === 'strong' ? '#1f6f48'
      : r.matchStatus === 'weak'   ? '#b85510'
      : r.matchStatus === 'fail'   ? '#c8362b'
      : '';
    }

    if (r.flags && r.flags.length) {
      flagsWrap.hidden = false;
      flagsList.innerHTML = r.flags.map(f => `<li>${flagDescription(f)}</li>`).join('');
    } else {
      flagsWrap.hidden = true;
      flagsList.innerHTML = '';
    }

    overlay.hidden = false;
    overlay.scrollTop = 0;

    // Audible feedback
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = r.tone === 'approved' ? 880 : 320;
      o.connect(g); g.connect(ctx.destination);
      g.gain.value = 0.05;
      o.start();
      setTimeout(() => { o.stop(); ctx.close(); }, 120);
    } catch {}

    startCountdown();
  }

  function startCountdown() {
    clearCountdown();
    const total = RESULT_DURATION_MS / 1000;
    const start = Date.now();
    const CIRC  = 2 * Math.PI * 20;
    countdownArc.setAttribute('stroke-dasharray', CIRC);
    countdownArc.setAttribute('stroke-dashoffset', '0');
    countdownNum.textContent = String(total);

    countdownTimer = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      const remaining = Math.max(0, total - elapsed);
      countdownNum.textContent = Math.ceil(remaining);
      countdownArc.setAttribute('stroke-dashoffset', String(CIRC * (elapsed / total)));
      if (remaining <= 0) clearResult();
    }, 100);

    clearTimer = setTimeout(clearResult, RESULT_DURATION_MS);
  }

  function clearCountdown() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (clearTimer)     { clearTimeout(clearTimer); clearTimer = null; }
  }

  function clearResult() {
    clearCountdown();
    overlay.hidden = true;
    lastScannedToken = '';
    manualInput.value = '';
    if (sectionManual.classList.contains('active')) {
      setTimeout(() => manualInput.focus(), 50);
    }
  }

  // Allow tap outside the card OR ESC to dismiss
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) clearResult();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) clearResult();
  });

  // ── HELPERS ────────────────────────────────────────────────────
  function flagDescription(flag) {
    switch (flag) {
      case 'UNDER_LEGAL_AGE':   return 'Customer is under the legal age tier';
      case 'CLOSE_TO_LIMIT':    return 'Age is close to legal minimum — check ID carefully';
      case 'ID_EXPIRED':        return 'Government ID is EXPIRED — refuse sale';
      case 'ID_EXPIRING_SOON':  return 'Government ID expires within 30 days';
      case 'JUST_REGISTERED':   return 'Customer registered less than 5 minutes ago';
      case 'UNKNOWN_PASS':      return 'Barcode is not in the system';
      case 'PHOTO_MATCH_FAIL':  return 'Selfie does NOT match ID photo — verify visually';
      case 'PHOTO_MATCH_WEAK':  return 'Selfie / ID photo match is weak — verify visually';
      case 'NO_LIVENESS_CHECK': return 'No liveness check performed at registration';
      default:                  return flag;
    }
  }

  // ── BOOT ──────────────────────────────────────────────────────
  // Focus the manual input by default for USB barcode scanners (HID typing)
  manualInput.focus();
})();
