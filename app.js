// ─────────────────────────────────────────────────────────────────
//  Mapleproof — app.js  (customer kiosk, v10 — worldwide IDs)
//  Flow: home → ID details (manual, any country) + ID photo upload
//        → liveness check → Trulioo verification (mocked) → pass
//
//  KEY v10 CHANGES:
//   - No PDF417 barcode scanning. Manual entry supports passports etc.
//   - ID photo is used ONLY for face matching, then discarded. Never
//     sent to the server, never stored.
//   - Trulioo identity-verification step (currently SIMULATED — always
//     succeeds — until a real Trulioo contract is in place).
//   - Pass card shows only the verified selfie + face-match %.
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────
//  EMBEDDED CODE 128 BARCODE GENERATOR (self-contained, no CDN)
// ─────────────────────────────────────────────────────────────────
const CODE128_PATTERNS = [
  "11011001100","11001101100","11001100110","10010011000","10010001100",
  "10001001100","10011001000","10011000100","10001100100","11001001000",
  "11001000100","11000100100","10110011100","10011011100","10011001110",
  "10111001100","10011101100","10011100110","11001110010","11001011100",
  "11001001110","11011100100","11001110100","11101101110","11101001100",
  "11100101100","11100100110","11101100100","11100110100","11100110010",
  "11011011000","11011000110","11000110110","10100011000","10001011000",
  "10001000110","10110001000","10001101000","10001100010","11010001000",
  "11000101000","11000100010","10110111000","10110001110","10001101110",
  "10111011000","10111000110","10001110110","11101110110","11010001110",
  "11000101110","11011101000","11011100010","11011101110","11101011000",
  "11101000110","11100010110","11101101000","11101100010","11100011010",
  "11101111010","11001000010","11110001010","10100110000","10100001100",
  "10010110000","10010000110","10000101100","10000100110","10110010000",
  "10110000100","10011010000","10011000010","10000110100","10000110010",
  "11000010010","11001010000","11110111010","11000010100","10001111010",
  "10100111100","10010111100","10010011110","10111100100","10011110100",
  "10011110010","11110100100","11110010100","11110010010","11011011110",
  "11011110110","11110110110","10101111000","10100011110","10001011110",
  "10111101000","10111100010","11110101000","11110100010","10111011110",
  "10111101110","11101011110","11110101110","11010000100","11010010000",
  "11010011100","1100011101011"  // index 106 = STOP
];

function renderCode128(svgEl, text, opts = {}) {
  const o = Object.assign({
    barWidth: 3.4, height: 96, margin: 18,
    showText: true, fontSize: 14, textMargin: 6,
    background: '#ffffff', lineColor: '#000000',
    fontFamily: 'JetBrains Mono, monospace'
  }, opts);

  const START_B = 104, STOP = 106;
  const codes = [START_B];
  for (const ch of text) {
    const cc = ch.charCodeAt(0);
    if (cc < 32 || cc > 127) throw new Error('Code 128 B: char out of range');
    codes.push(cc - 32);
  }
  let sum = START_B;
  for (let i = 1; i < codes.length; i++) sum += codes[i] * i;
  codes.push(sum % 103);
  codes.push(STOP);

  let pattern = '';
  for (const c of codes) pattern += CODE128_PATTERNS[c];

  const totalW = pattern.length * o.barWidth + o.margin * 2;
  const totalH = o.height + (o.showText ? o.fontSize + o.textMargin : 0) + o.margin;

  while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
  svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svgEl.setAttribute('width',  totalW);
  svgEl.setAttribute('height', totalH);
  svgEl.setAttribute('viewBox', `0 0 ${totalW} ${totalH}`);

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('width', totalW);
  bg.setAttribute('height', totalH);
  bg.setAttribute('fill', o.background);
  svgEl.appendChild(bg);

  let x = o.margin;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '1') {
      const r = document.createElementNS(SVG_NS, 'rect');
      r.setAttribute('x', x);
      r.setAttribute('y', o.margin / 2);
      r.setAttribute('width', o.barWidth);
      r.setAttribute('height', o.height);
      r.setAttribute('fill', o.lineColor);
      svgEl.appendChild(r);
    }
    x += o.barWidth;
  }

  if (o.showText) {
    const txt = document.createElementNS(SVG_NS, 'text');
    txt.setAttribute('x', totalW / 2);
    txt.setAttribute('y', o.height + o.margin / 2 + o.fontSize + 2);
    txt.setAttribute('text-anchor', 'middle');
    txt.setAttribute('font-family', o.fontFamily);
    txt.setAttribute('font-size', o.fontSize);
    txt.setAttribute('font-weight', '600');
    txt.setAttribute('fill', o.lineColor);
    txt.setAttribute('letter-spacing', '2');
    txt.textContent = text;
    svgEl.appendChild(txt);
  }
}

// ── ID TYPE CONFIG (accepted Canadian documents) ──────────────────
const ID_TYPE_LABELS = {
  ontario_dl:         "Ontario Driver's Licence",
  passport_ca:        'Canadian Passport',
  citizenship_card:   'Canadian Citizenship Card',
  caf_id:             'Canadian Armed Forces ID Card',
  indian_status:      'Secure Certificate of Indian Status',
  pr_card:            'Permanent Resident Card',
  ontario_photo_card: 'Ontario Photo Card'
};

// Keywords expected on each document. The upload must contain enough of
// these (plus a face and a date) or it is rejected as "not a valid ID".
const ID_TYPE_KEYWORDS = {
  ontario_dl:         ['ONTARIO','DRIVER','LICENCE','LICENSE','PERMIS','CONDUIRE','DL'],
  passport_ca:        ['PASSPORT','PASSEPORT','CANADA','TYPE P','P<CAN'],
  citizenship_card:   ['CITIZENSHIP','CITOYENNETE','CITOYENNETÉ','CANADA','CITIZEN'],
  caf_id:             ['CANADIAN ARMED FORCES','ARMED FORCES','FORCES','DEFENCE','DEFENSE','NATIONAL DEFENCE','MILITARY','CAF'],
  indian_status:      ['INDIAN STATUS','SECURE CERTIFICATE','STATUS','INDIAN','CERTIFICATE','CANADA'],
  pr_card:            ['PERMANENT RESIDENT','RESIDENT','RÉSIDENT','RESIDENT PERMANENT','CANADA','PR'],
  ontario_photo_card: ['ONTARIO','PHOTO CARD','PHOTO','CARD']
};

// ── STATE ──────────────────────────────────────────────────────────
const state = {
  faceImageData:  '',           // verified live selfie (from liveness)
  idPhotoImage:   '',           // unused in Trulioo flow (kept for compatibility)
  docFront:       '',           // ID document front (sent to Trulioo, not stored by us)
  docBack:        '',           // ID document back (optional)
  faceMatchScore: null,
  liveDescriptor: null,
  livenessChallenges: null,
  token:          '',
  // Trulioo owns ID capture & verification; these stay mostly empty.
  idDetails: {
    idType: '', firstName: '', lastName: '', dob: '',
    idNumber: '', expiry: '', country: 'CA'
  },
  truliooVerified:  false,
  truliooSimulated: false,
  truliooReference: null,
  serverPublicRecord: null
};

// ── STREAMS ────────────────────────────────────────────────────────
let selfieStream = null;

// ── DOM ────────────────────────────────────────────────────────────
const selfieVideo  = document.getElementById('selfie-video');
const selfieCanvas = document.getElementById('selfie-canvas');

// ── PHASE NAVIGATION ──────────────────────────────────────────────
// 0=home, 1=ID details, 2=liveness, 3=pass
const PHASE_IDS = ['phase-home', 'phase-scan', 'phase-selfie', 'phase-pass'];
function showPhase(n) {
  document.querySelectorAll('.phase').forEach(el => {
    const isActive = el.id === PHASE_IDS[n];
    el.classList.toggle('active', isActive);
    if (isActive) {
      el.classList.remove('entering');
      void el.offsetWidth;
      el.classList.add('entering');
    }
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function stopStream(stream) { if (stream) stream.getTracks().forEach(t => t.stop()); }

// ── Resize a File to a max dimension, return JPEG data URL ──
function resizeImageFile(file, maxDim = 1600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = Math.min(maxDim / width, maxDim / height);
          width  = Math.round(width  * scale);
          height = Math.round(height * scale);
        }
        const c = document.createElement('canvas');
        c.width = width; c.height = height;
        c.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Age helper ─────────────────────────────────────────────────────
function calculateAge(dob) {
  if (!dob) return null;
  const d = new Date(`${dob}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

// ─────────────────────────────────────────────────────────────────
//  FACE MATCHING — browser-side via face-api.js (FREE)
// ─────────────────────────────────────────────────────────────────
const FACE_MODEL_URL = 'https://justadudewhohacks.github.io/face-api.js/models';
let faceApiReady = false;
let faceApiLoading = null;

function loadFaceApiModels() {
  if (faceApiReady) return Promise.resolve();
  if (faceApiLoading) return faceApiLoading;
  if (typeof faceapi === 'undefined') {
    console.warn('[face-match] face-api.js not loaded — skipping face matching.');
    return Promise.resolve();
  }
  faceApiLoading = (async () => {
    try {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODEL_URL)
      ]);
      faceApiReady = true;
      console.log('[face-match] models loaded ✓');
    } catch (err) {
      console.error('[face-match] model load failed:', err);
    }
  })();
  return faceApiLoading;
}

async function dataUrlToImage(dataUrl) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
  return img;
}

/** Compare two face images → similarity in [0,1], or null if no face found. */
async function compareFaces(selfieDataUrl, idPhotoDataUrl) {
  if (!selfieDataUrl || !idPhotoDataUrl) return null;
  await loadFaceApiModels();
  if (!faceApiReady) return null;
  try {
    const [selfieImg, idImg] = await Promise.all([
      dataUrlToImage(selfieDataUrl),
      dataUrlToImage(idPhotoDataUrl)
    ]);
    const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.4 });
    const [selfieDetect, idDetect] = await Promise.all([
      faceapi.detectSingleFace(selfieImg, opts).withFaceLandmarks().withFaceDescriptor(),
      faceapi.detectSingleFace(idImg, opts).withFaceLandmarks().withFaceDescriptor()
    ]);
    if (!selfieDetect || !idDetect) {
      console.warn('[face-match] no face in', !selfieDetect ? 'selfie' : 'ID photo');
      return null;
    }
    const distance = faceapi.euclideanDistance(selfieDetect.descriptor, idDetect.descriptor);
    const similarity = Math.max(0, Math.min(1, 1 - distance));
    console.log(`[face-match] distance=${distance.toFixed(3)} similarity=${similarity.toFixed(3)}`);
    return similarity;
  } catch (err) {
    console.error('[face-match] error:', err);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
//  TRULIOO CUSTOMER API — ID DOCUMENT + SELFIE LIVENESS
//  ─────────────────────────────────────────────────────────────────
//  Flow: Phase 1 collects the ID document image(s) → Phase 2 captures a
//  liveness selfie → both are posted to /api/trulioo/document-verify,
//  which runs the real Trulioo Customer API (authorize → create txn →
//  upload front/back/live → verify → result). SIM mode returns a
//  clearly-flagged synthetic pass so the trial still works.
// ─────────────────────────────────────────────────────────────────
let truliooCfg = null;

async function loadTruliooConfig() {
  if (truliooCfg) return truliooCfg;
  try {
    const r = await fetch('/api/trulioo/config');
    truliooCfg = await r.json();
  } catch (_) {
    truliooCfg = { live: false, mode: 'simulation' };
  }
  return truliooCfg;
}

// Submit the collected ID document(s) + liveness selfie to Trulioo.
// Called automatically after the liveness step succeeds.
async function submitTruliooDocVerify() {
  const savingSection = document.getElementById('saving-section');
  const savingMsg     = savingSection ? savingSection.querySelector('p') : null;
  const progress      = document.getElementById('trulioo-progress');
  const steps = [1,2,3,4].map(n => document.getElementById('tv-step-'+n));

  if (progress) progress.hidden = false;
  steps.forEach(s => s && s.classList.remove('active','done'));
  if (savingMsg) savingMsg.textContent = 'Verifying your identity with Trulioo…';

  // Animate the first three steps while the request runs
  let animating = true;
  (async () => {
    for (let i = 0; i < 3 && animating; i++) {
      steps[i]?.classList.add('active');
      await new Promise(r => setTimeout(r, 900));
      steps[i]?.classList.remove('active');
      steps[i]?.classList.add('done');
    }
  })();

  let data;
  try {
    const resp = await fetch('/api/trulioo/document-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idType:        state.idDetails.idType,
        idCountry:     'CA',
        documentFront: state.docFront,
        documentBack:  state.docBack || undefined,
        selfie:        state.faceImageData,
        consent:       true,
        isUS:          false
      })
    });
    data = await resp.json();
  } catch (err) {
    data = { ok: false, error: 'Could not reach the verification service.' };
  }

  animating = false;

  if (!data.ok || !data.verified) {
    if (progress) progress.hidden = true;
    throw new Error(data.error ||
      'Trulioo could not verify your identity. Please retake clear photos and try again.');
  }

  steps[3]?.classList.add('active','done');
  state.truliooVerified  = true;
  state.truliooReference = data.reference || null;
  state.truliooSimulated = !!data.simulated;
  // Use any details Trulioo extracted from the document
  if (data.person) {
    state.idDetails.firstName = data.person.firstName || state.idDetails.firstName;
    state.idDetails.lastName  = data.person.lastName  || state.idDetails.lastName;
    state.idDetails.dob       = data.person.dob       || state.idDetails.dob;
    state.idDetails.country   = data.person.country   || 'CA';
  }
  await new Promise(r => setTimeout(r, 500));
  if (progress) progress.hidden = true;
}

// ─────────────────────────────────────────────────────────────────
//  PHASE 1 — IDENTITY VERIFICATION (API flow OR Web SDK flow)
// ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const startBtn   = document.getElementById('start-btn');
  const backBtn2   = document.getElementById('back-home-btn-2');
  if (startBtn) startBtn.addEventListener('click', () => { showPhase(1); initVerifyPhase(); });
  if (backBtn2) backBtn2.addEventListener('click', () => showPhase(0));

  // Shared
  const statusEl   = document.getElementById('trulioo-status-text');
  const consent    = document.getElementById('consent-check');
  const badge      = document.getElementById('trulioo-mode-badge');
  const flowApiEl  = document.getElementById('flow-api');
  const flowSdkEl  = document.getElementById('flow-sdk');

  // API-flow elements
  const idTypeSel   = document.getElementById('id-type-select');
  const frontInput  = document.getElementById('doc-front-input');
  const backInput   = document.getElementById('doc-back-input');
  const frontThumb  = document.getElementById('doc-front-thumb');
  const backThumb   = document.getElementById('doc-back-thumb');
  const continueBtn = document.getElementById('doc-continue-btn');

  // SDK-flow elements
  const idTypeSelSdk = document.getElementById('id-type-select-sdk');
  const sdkStartBtn  = document.getElementById('sdk-start-btn');
  const sdkStartRow  = document.getElementById('sdk-start-row');
  const sdkMount     = document.getElementById('trulioo-sdk');

  let activeFlow = 'api';

  async function initVerifyPhase() {
    const cfg = await loadTruliooConfig();
    activeFlow = (cfg.flow === 'sdk') ? 'sdk' : 'api';
    if (badge) {
      badge.textContent = cfg.live ? 'Secured by Trulioo' : 'Trulioo · Simulation (trial)';
      badge.classList.toggle('sim', !cfg.live);
    }
    const sdk = activeFlow === 'sdk';
    if (flowApiEl)  flowApiEl.hidden  = sdk;
    if (flowSdkEl)  flowSdkEl.hidden  = !sdk;
    if (continueBtn) continueBtn.style.display = sdk ? 'none' : '';
    if (statusEl) statusEl.textContent = sdk
      ? 'Select your ID type, then start Trulioo verification.'
      : 'Select your ID type, then add a clear photo of your ID.';
  }

  // ───────── API FLOW ─────────
  function refreshApi() {
    const ready = !!(idTypeSel && idTypeSel.value && state.docFront &&
                     consent && consent.checked);
    if (continueBtn) continueBtn.disabled = !ready;
    if (!statusEl || activeFlow !== 'api') return;
    if (!idTypeSel.value)        statusEl.textContent = 'Select your ID type to begin.';
    else if (!state.docFront)    statusEl.textContent = 'Add a clear photo of the front of your ID.';
    else if (consent && !consent.checked) statusEl.textContent = 'Please accept the consent notice to continue.';
    else                         statusEl.textContent = '✓ Ready. Continue to the liveness check.';
  }

  async function handleUpload(input, thumb, which) {
    const f = input.files && input.files[0];
    if (!f) return;
    if (!f.type || !f.type.startsWith('image/')) {
      if (statusEl) statusEl.textContent = 'That is not an image. Please upload a photo of your ID only.';
      input.value = ''; return;
    }
    const dataUrl = await resizeImageFile(f, 1800, 0.92);
    if (which === 'front') state.docFront = dataUrl;
    else                   state.docBack  = dataUrl;
    if (thumb) {
      thumb.classList.add('has-image');
      thumb.style.backgroundImage = `url('${dataUrl}')`;
      thumb.parentElement?.classList.add('has-image');
    }
    refreshApi();
  }

  idTypeSel?.addEventListener('change', refreshApi);
  consent?.addEventListener('change', () => { refreshApi(); refreshSdk(); });
  frontInput?.addEventListener('change', () => handleUpload(frontInput, frontThumb, 'front'));
  backInput?.addEventListener('change',  () => handleUpload(backInput,  backThumb,  'back'));

  continueBtn?.addEventListener('click', () => {
    if (!idTypeSel.value || !state.docFront) return;
    state.idDetails.idType  = idTypeSel.value;
    state.idDetails.country = 'CA';
    if (statusEl) statusEl.textContent = '✓ ID received. Continuing to the liveness check…';
    setTimeout(() => showPhase(2), 400);
  });

  // ───────── SDK FLOW ─────────
  function refreshSdk() {
    const ready = !!(idTypeSelSdk && idTypeSelSdk.value && consent && consent.checked);
    if (sdkStartBtn) sdkStartBtn.disabled = !ready;
    if (!statusEl || activeFlow !== 'sdk') return;
    if (!idTypeSelSdk.value) statusEl.textContent = 'Select your ID type to begin.';
    else if (consent && !consent.checked) statusEl.textContent = 'Please accept the consent notice to continue.';
    else statusEl.textContent = '✓ Ready. Tap “Start Trulioo verification”.';
  }
  idTypeSelSdk?.addEventListener('change', refreshSdk);

  async function proceedAfterSdk(transactionId) {
    if (statusEl) statusEl.textContent = 'Confirming your verification…';
    try {
      const r = await fetch('/api/trulioo/sdk-result', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionId })
      });
      const data = await r.json();
      if (!data.ok || !data.verified) {
        if (statusEl) statusEl.textContent =
          (data && data.error) || 'Trulioo could not verify your identity. Please try again.';
        if (sdkStartRow) sdkStartRow.style.display = '';
        if (sdkStartBtn) { sdkStartBtn.disabled = false; sdkStartBtn.textContent = 'Try again'; }
        return;
      }
      state.truliooVerified  = true;
      state.truliooReference = data.reference || transactionId || null;
      state.truliooSimulated = !!data.simulated;
      state.idDetails.idType = idTypeSelSdk.value || state.idDetails.idType;
      state.idDetails.country = 'CA';
      if (data.person) {
        state.idDetails.firstName = data.person.firstName || '';
        state.idDetails.lastName  = data.person.lastName  || '';
        state.idDetails.dob       = data.person.dob       || '';
      }
      if (statusEl) statusEl.textContent = '✓ Identity verified. Continuing to your selfie…';
      // Still capture a Mapleproof liveness selfie for the pass photo.
      setTimeout(() => showPhase(2), 600);
    } catch (err) {
      if (statusEl) statusEl.textContent = 'Could not reach the verification service. Please retry.';
      if (sdkStartRow) sdkStartRow.style.display = '';
    }
  }

  async function launchTruliooSdk(shortCode) {
    // Pull the official Web SDK from the CDN (ESM).
    const mod = await import('https://cdn.jsdelivr.net/npm/@trulioo/docv/+esm');
    const Trulioo = mod.Trulioo || (mod.default && mod.default.Trulioo);
    const event   = mod.event   || (mod.default && mod.default.event);
    if (!Trulioo) throw new Error('Trulioo Web SDK failed to load');

    const theme = Trulioo.workflowTheme()
      .setLogoSource(location.origin + '/logo-mark.png')
      .setPrimaryButtonColor('#d4a838')
      .setPrimaryButtonTextColor('#0c0a06')
      .build();

    const workflow = Trulioo.workflow()
      .setShortCode(shortCode)
      .setTheme(theme);

    const callbacks = new event.adapters.ListenerCallback({
      onComplete: (success) => proceedAfterSdk(success && success.transactionId),
      onError:    (err) => {
        if (statusEl) statusEl.textContent =
          'Verification error' + (err && err.code ? ` (code ${err.code})` : '') + '. Please try again.';
        if (sdkStartRow) sdkStartRow.style.display = '';
        if (sdkStartBtn) { sdkStartBtn.disabled = false; sdkStartBtn.textContent = 'Try again'; }
      },
      onException: (ex) => {
        console.error('[trulioo sdk] exception', ex);
        if (statusEl) statusEl.textContent = 'Unexpected error. Please try again.';
        if (sdkStartRow) sdkStartRow.style.display = '';
        if (sdkStartBtn) { sdkStartBtn.disabled = false; sdkStartBtn.textContent = 'Try again'; }
      }
    });
    const cbOpt = Trulioo.event().setCallbacks(callbacks);
    await Trulioo.initialize(workflow);
    await Trulioo.launch('trulioo-sdk', cbOpt);
  }

  async function runSimSdk() {
    // Simulation: brief progress, then synthetic success
    if (sdkMount) {
      sdkMount.innerHTML =
        '<div class="trulioo-sim-card" style="margin:0 auto">' +
        '<div class="trulioo-sim-logo"><img src="/logo-mark.png" width="34" height="34" alt="">' +
        '<span>Trulioo Identity Verification</span></div>' +
        '<div class="trulioo-progress">' +
        '<div class="trulioo-step done"><span class="trulioo-dot"></span> Document captured</div>' +
        '<div class="trulioo-step done"><span class="trulioo-dot"></span> Selfie &amp; liveness captured</div>' +
        '<div class="trulioo-step active"><span class="trulioo-dot"></span> Verifying…</div>' +
        '</div><p class="trulioo-sim-note">Simulation — set TRULIOO_LICENSE_KEY for live verification.</p></div>';
    }
    await new Promise(r => setTimeout(r, 1600));
    proceedAfterSdk(null);
  }

  sdkStartBtn?.addEventListener('click', async () => {
    if (!idTypeSelSdk.value || (consent && !consent.checked)) return;
    sdkStartBtn.disabled = true;
    sdkStartBtn.textContent = 'Starting…';
    if (statusEl) statusEl.textContent = 'Starting secure Trulioo verification…';
    try {
      const resp = await fetch('/api/trulioo/shortcode', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idType: idTypeSelSdk.value, idCountry: 'CA', consent: true
        })
      });
      const data = await resp.json();
      if (!data.ok || !data.shortCode) throw new Error(data.error || 'Could not start verification.');

      if (sdkStartRow) sdkStartRow.style.display = 'none';
      if (data.simulated) {
        await runSimSdk();
      } else {
        if (statusEl) statusEl.textContent = 'Follow the Trulioo steps to verify your identity.';
        await launchTruliooSdk(data.shortCode);
      }
    } catch (err) {
      console.error('[trulioo sdk] start failed:', err);
      if (statusEl) statusEl.textContent = err.message || 'Could not start verification. Please retry.';
      if (sdkStartRow) sdkStartRow.style.display = '';
      sdkStartBtn.disabled = false;
      sdkStartBtn.textContent = 'Start Trulioo verification \u2192';
    }
  });

  // Pre-load face models in the background (used by the liveness step)
  loadFaceApiModels();
});

// ─────────────────────────────────────────────────────────────────
//  PHASE 2 — LIVENESS CHECK (active anti-spoofing)
// ─────────────────────────────────────────────────────────────────
async function startLivenessCamera() {
  try {
    selfieStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    selfieVideo.srcObject = selfieStream;
    await selfieVideo.play();
    return true;
  } catch (err) {
    console.error('[liveness] camera error:', err);
    alert('Front camera unavailable. Please allow camera access and try again.');
    return false;
  }
}

function showLivenessUI(which) {
  const intro    = document.getElementById('liveness-intro');
  const active   = document.getElementById('liveness-active');
  const loading  = document.getElementById('liveness-loading');
  const failure  = document.getElementById('liveness-fail');
  intro.hidden   = which !== 'intro';
  active.hidden  = which !== 'active';
  loading.hidden = which !== 'loading';
  failure.hidden = which !== 'fail';
}

async function runLivenessFlow() {
  if (!window.MapleproofLiveness) {
    alert('Liveness module failed to load. Please refresh the page.');
    return;
  }

  showLivenessUI('loading');
  const ready = await window.MapleproofLiveness.ensureModels();
  if (!ready) {
    document.getElementById('liveness-fail-title').textContent = 'Could not load models';
    document.getElementById('liveness-fail-msg').textContent =
      'The face-recognition models could not be downloaded. Check your internet connection and try again.';
    showLivenessUI('fail');
    return;
  }

  showLivenessUI('active');
  const cameraOk = await startLivenessCamera();
  if (!cameraOk) { showLivenessUI('intro'); return; }

  await new Promise(r => {
    if (selfieVideo.readyState >= 2) return r();
    selfieVideo.addEventListener('loadeddata', r, { once: true });
  });

  let result;
  try {
    result = await window.MapleproofLiveness.runLivenessChallenge({
      videoEl:    selfieVideo,
      overlayEl:  document.getElementById('selfie-overlay'),
      promptEl:   document.getElementById('liveness-prompt'),
      iconEl:     document.getElementById('liveness-icon'),
      stepEl:     document.getElementById('liveness-step'),
      hintEl:     document.getElementById('liveness-hint'),
      manualBtn:  document.getElementById('liveness-manual-btn'),
      manualBtnDelay:      6000,
      challengeCount:      4,
      timeoutPerChallenge: 18000
    });
  } catch (err) {
    console.error('[liveness] error:', err);
    document.getElementById('liveness-fail-title').textContent = 'Liveness check error';
    document.getElementById('liveness-fail-msg').textContent = err.message || 'Something went wrong.';
    showLivenessUI('fail');
    stopStream(selfieStream); selfieStream = null;
    return;
  }

  if (!result.success) {
    document.getElementById('liveness-fail-title').textContent = 'Liveness check failed';
    document.getElementById('liveness-fail-msg').textContent = result.message || 'Please try again.';
    showLivenessUI('fail');
    stopStream(selfieStream); selfieStream = null;
    return;
  }

  // Success — save the captured face image + descriptor
  state.faceImageData      = result.faceImageData;
  state.liveDescriptor     = result.descriptor;
  state.livenessChallenges = result.challenges;
  console.log('[liveness] success — captured face + descriptor');

  stopStream(selfieStream); selfieStream = null;
  showPhase(3);

  // Pass phase. In the API flow, Trulioo verifies the uploaded ID
  // document against this liveness selfie now. In the SDK flow,
  // Trulioo already verified the person in Phase 1, so we skip
  // straight to issuing the pass.
  (async () => {
    const savingSection = document.getElementById('saving-section');
    const passSection   = document.getElementById('pass-section');
    const saveError     = document.getElementById('save-error');
    try {
      if (!state.truliooVerified) {
        await submitTruliooDocVerify();    // API flow — throws if declined
      }
      await saveAndGeneratePass();
    } catch (err) {
      console.error('[trulioo] verify failed:', err);
      if (savingSection) savingSection.style.display = 'none';
      if (passSection)   passSection.style.display   = 'block';
      if (saveError) {
        saveError.style.display = 'flex';
        saveError.textContent   = `${err.message}`;
      }
    }
  })();
}

// Wire up phase-2 buttons
document.getElementById('start-liveness-btn')?.addEventListener('click', () => runLivenessFlow());
document.getElementById('cancel-liveness-btn')?.addEventListener('click', () => {
  stopStream(selfieStream); selfieStream = null;
  showLivenessUI('intro');
});
document.getElementById('retry-liveness-btn')?.addEventListener('click', () => showLivenessUI('intro'));

['back-to-id-btn', 'back-to-id-btn-2'].forEach(id => {
  document.getElementById(id)?.addEventListener('click', () => {
    stopStream(selfieStream); selfieStream = null;
    state.liveDescriptor = null;
    showLivenessUI('intro');
    showPhase(1);
  });
});

// Reset to intro when phase 2 is shown fresh
(() => {
  const phase2 = document.getElementById('phase-selfie');
  if (!phase2) return;
  const obs = new MutationObserver(() => {
    if (phase2.classList.contains('active') && !selfieStream) {
      const fail = document.getElementById('liveness-fail');
      if (!fail || fail.hidden) showLivenessUI('intro');
    }
  });
  obs.observe(phase2, { attributes: true, attributeFilter: ['class'] });
})();

// ─────────────────────────────────────────────────────────────────
//  (Trulioo verification now happens in Phase 1 via EmbedID — see
//   runTruliooPhase / confirmTruliooResult above. By the time we reach
//   the pass step, state.truliooVerified is already true.)
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────
//  PHASE 3 — verify with Trulioo → POST to server → render pass
// ─────────────────────────────────────────────────────────────────
async function saveAndGeneratePass() {
  const savingSection = document.getElementById('saving-section');
  const passSection   = document.getElementById('pass-section');
  const saveError     = document.getElementById('save-error');
  const savingMsg     = savingSection.querySelector('p');

  savingSection.style.display = 'block';
  passSection.style.display   = 'none';
  saveError.style.display     = 'none';

  try {
    // ── 1) Crop just the FACE from the live capture (clean portrait) ──
    let croppedLiveFace = state.faceImageData;
    if (window.MapleproofLiveness && state.faceImageData) {
      try {
        if (savingMsg) savingMsg.textContent = 'Preparing your photo…';
        croppedLiveFace = await window.MapleproofLiveness.cropFaceFromImage(
          state.faceImageData, 360, { circular: false }
        );
      } catch (err) {
        console.warn('[crop] live face crop failed; using full image:', err);
      }
    }

    // ── 2) Face match: live selfie ↔ uploaded ID photo ──
    //     The ID photo is used ONLY here. It is never sent to the server.
    let matchScore = null;
    if (state.idPhotoImage) {
      try {
        if (savingMsg) savingMsg.textContent = 'Matching your face to your ID photo…';
        if (state.liveDescriptor && window.MapleproofLiveness) {
          matchScore = await window.MapleproofLiveness.compareDescriptorToImage(
            state.liveDescriptor, state.idPhotoImage
          );
        } else {
          matchScore = await compareFaces(croppedLiveFace, state.idPhotoImage);
        }
      } catch (err) {
        console.warn('[face-match] failed; continuing without match score:', err);
      }
    }
    state.faceMatchScore = matchScore;

    // ── 3) Trulioo identity verification already completed in Phase 1 ──
    if (!state.truliooVerified) {
      throw new Error('Identity verification was not completed. Please start again.');
    }

    // ── 4) Submit to server ──
    //     We send the verified selfie + the Trulioo reference. The ID
    //     document/data lives with Trulioo and is never stored here.
    if (savingMsg) savingMsg.textContent = 'Saving your pass…';

    const consentEl = document.getElementById('consent-check');
    if (!consentEl || !consentEl.checked) {
      throw new Error('You must accept the privacy notice and terms to continue.');
    }

    const response = await fetch('/api/register', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idType:        state.idDetails.idType || undefined,
        country:       'CA',
        faceImageData: croppedLiveFace,         // verified selfie ONLY
        faceMatchScore: matchScore,
        livenessVerified:   !!state.liveDescriptor,
        livenessChallenges: state.livenessChallenges || undefined,
        truliooVerified:    true,
        truliooReference:   state.truliooReference || undefined,
        consentAccepted:    true,
        consentVersion:     '2.0'
      })
    });

    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Registration failed.');

    state.token              = data.token;
    state.serverPublicRecord = data.publicRecord;
    const pub = data.publicRecord;

    // ── Populate pass card ──
    document.getElementById('pass-age-badge').textContent   = pub.ageBadge || '19+';
    document.getElementById('pass-token-label').textContent = `ID · ${data.token}`;

    renderCode128(document.getElementById('barcode-svg'), data.barcode, {
      barWidth: 3.4, height: 96, margin: 18, showText: true,
      fontSize: 14, textMargin: 6,
      background: '#ffffff', lineColor: '#000000',
      fontFamily: 'JetBrains Mono, monospace'
    });

    // Single verified selfie on the pass
    state.faceImageData = croppedLiveFace;
    document.getElementById('pass-face-photo').src = croppedLiveFace;
    document.getElementById('pass-status-val').textContent  = `REGISTERED · ${pub.ageBadge}`;
    document.getElementById('pass-idtype-val').textContent  =
      (ID_TYPE_LABELS[state.idDetails.idType]) ||
      (state.truliooSimulated ? 'Trulioo (simulated)' : 'Trulioo Verified');

    // Photo-match indicator
    const matchBig  = document.getElementById('pass-match-big');
    const matchNote = document.getElementById('pass-match-note');
    if (matchBig) {
      matchBig.classList.remove('match-strong', 'match-weak', 'match-fail');
      if (matchScore === null || matchScore === undefined) {
        matchBig.textContent = 'N/A';
        if (matchNote) matchNote.textContent = 'Face match could not be computed';
      } else {
        const pct = Math.round(matchScore * 100);
        matchBig.textContent = `${pct}%`;
        if (matchScore >= 0.70) {
          matchBig.classList.add('match-strong');
          if (matchNote) matchNote.textContent = 'Strong match ✓';
        } else if (matchScore >= 0.55) {
          matchBig.classList.add('match-weak');
          if (matchNote) matchNote.textContent = 'Moderate — retailer should review';
        } else {
          matchBig.classList.add('match-fail');
          if (matchNote) matchNote.textContent = 'Low match — verify ID carefully';
        }
      }
    }

    const now = new Date();
    document.getElementById('pass-generated').textContent =
      `${now.toLocaleDateString('en-CA')} ${now.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' })}`;

    // Duplicate-account banner
    const dupBanner = document.getElementById('duplicate-banner');
    const dupText   = document.getElementById('duplicate-text');
    if (data.reRegistered && data.duplicateMessage) {
      dupText.textContent = data.duplicateMessage;
      dupBanner.hidden = false;
    } else {
      dupBanner.hidden = true;
    }

    savingSection.style.display = 'none';
    passSection.style.display   = 'block';

  } catch (err) {
    console.error(err);
    savingSection.style.display = 'none';
    passSection.style.display   = 'block';
    saveError.style.display     = 'flex';
    saveError.textContent       = `${err.message} — pass not generated.`;
  }
}

// ─────────────────────────────────────────────────────────────────
//  DOWNLOAD PASS — render the pass card to PNG (single selfie)
// ─────────────────────────────────────────────────────────────────
document.getElementById('download-pass-btn').addEventListener('click', async () => {
  const barcodeSvg = document.getElementById('barcode-svg');
  if (!barcodeSvg || !state.token) return;

  const W = 720, H = 980;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Card background
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);

  // Top accent bar
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0,    '#d63a2e');
  grad.addColorStop(0.45, '#f08c2a');
  grad.addColorStop(0.95, '#2d8a3e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, 8);

  // Brand row
  ctx.fillStyle = '#2d8a3e';
  ctx.font = '600 30px Fraunces, Georgia, serif';
  ctx.textAlign = 'left';
  ctx.fillText('Mapleproof', 70, 70);
  ctx.fillStyle = '#1f6f48';
  ctx.font = '600 12px JetBrains Mono, monospace';
  ctx.textAlign = 'right';
  ctx.fillText('✓ TRULIOO VERIFIED', W - 70, 68);

  // Eyebrow
  ctx.fillStyle = '#5a7c66';
  ctx.font = '500 14px JetBrains Mono, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('AGE VERIFIED', W / 2, 135);

  // Big age badge
  ctx.fillStyle = '#2d8a3e';
  ctx.font = '600 120px Fraunces, Georgia, serif';
  ctx.fillText(state.serverPublicRecord?.ageBadge || '19+', W / 2, 255);

  // Check circle
  ctx.beginPath();
  ctx.arc(W / 2, 320, 34, 0, Math.PI * 2);
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#2d8a3e';
  ctx.stroke();
  ctx.font = '700 34px Inter, sans-serif';
  ctx.fillStyle = '#2d8a3e';
  ctx.textBaseline = 'middle';
  ctx.fillText('✓', W / 2, 321);
  ctx.textBaseline = 'alphabetic';

  // Must check ID
  ctx.fillStyle = '#0d2418';
  ctx.font = '600 20px Inter, sans-serif';
  ctx.fillText('Must check ID.', W / 2, 400);
  ctx.fillStyle = '#2a4232';
  ctx.font = '400 14px Inter, sans-serif';
  ctx.fillText('Retailer makes the final decision.', W / 2, 426);

  // Barcode
  const svgString = new XMLSerializer().serializeToString(barcodeSvg);
  const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const svgUrl  = URL.createObjectURL(svgBlob);

  const barImg = new Image();
  barImg.onload = () => {
    ctx.strokeStyle = 'rgba(13, 36, 24, 0.18)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(50, 470); ctx.lineTo(W - 50, 470); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(50, 620); ctx.lineTo(W - 50, 620); ctx.stroke();
    ctx.setLineDash([]);

    const targetW = W - 140;
    const ratio   = barImg.height / barImg.width;
    const targetH = Math.min(130, targetW * ratio);
    ctx.drawImage(barImg, 70, 485, targetW, targetH);
    URL.revokeObjectURL(svgUrl);

    // Footer line
    ctx.fillStyle = '#6b8978';
    ctx.font = '500 12px JetBrains Mono, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`ID · ${state.token}`, 70, 665);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#2a4232';
    ctx.font = 'italic 500 18px Fraunces, Georgia, serif';
    ctx.fillText('Thank you!', W - 70, 665);
    ctx.textAlign = 'left';

    drawSelfieAndMeta(ctx, () => {
      const link = document.createElement('a');
      link.href     = canvas.toDataURL('image/png');
      link.download = `mapleproof-${state.token}.png`;
      link.click();
    });
  };
  barImg.src = svgUrl;
});

function drawSelfieAndMeta(ctx, done) {
  const photoSize = 130;
  const x = (720 - photoSize) / 2;
  const y = 700;

  // Label
  ctx.fillStyle = '#1f6f48';
  ctx.font = '700 10px JetBrains Mono, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('VERIFIED SELFIE', 360, y - 10);
  ctx.textAlign = 'left';

  // Frame
  ctx.strokeStyle = '#e0eae3';
  ctx.lineWidth   = 2;
  roundRect(ctx, x, y, photoSize, photoSize, 14, false, true);

  // Match score below
  const score = state.faceMatchScore;
  let scoreText, scoreColor;
  if (score === null || score === undefined) {
    scoreText = 'Face match: N/A'; scoreColor = '#9aa8a0';
  } else {
    const pct = Math.round(score * 100);
    if (score >= 0.70)      { scoreText = `Face match: ${pct}% ✓`;        scoreColor = '#1f6f48'; }
    else if (score >= 0.55) { scoreText = `Face match: ${pct}% (review)`; scoreColor = '#b85510'; }
    else                    { scoreText = `Face match: ${pct}% (low)`;    scoreColor = '#c8362b'; }
  }
  const metaY = y + photoSize + 28;
  ctx.fillStyle = scoreColor;
  ctx.font = '700 14px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(scoreText, 360, metaY);

  ctx.fillStyle = '#5a7c66';
  ctx.font = '500 10px JetBrains Mono, monospace';
  ctx.fillText('REGISTERED · ' + (state.serverPublicRecord?.ageBadge || '19+'), 360, metaY + 20);
  ctx.textAlign = 'left';

  if (state.faceImageData) {
    const live = new Image();
    live.onload = () => {
      ctx.save();
      roundRectClip(ctx, x, y, photoSize, photoSize, 14);
      ctx.drawImage(live, x, y, photoSize, photoSize);
      ctx.restore();
      done();
    };
    live.onerror = done;
    live.src = state.faceImageData;
  } else {
    done();
  }
}

function roundRect(ctx, x, y, w, h, r, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  if (fill)   ctx.fill();
  if (stroke) ctx.stroke();
}
function roundRectClip(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.clip();
}

// ─────────────────────────────────────────────────────────────────
//  RESTART
// ─────────────────────────────────────────────────────────────────
document.getElementById('restart-btn').addEventListener('click', () => {
  stopStream(selfieStream);
  selfieStream = null;

  state.faceImageData      = '';
  state.idPhotoImage       = '';
  state.docFront           = '';
  state.docBack            = '';
  state.faceMatchScore     = null;
  state.liveDescriptor     = null;
  state.livenessChallenges = null;
  state.token              = '';
  state.truliooVerified    = false;
  state.truliooSimulated   = false;
  state.truliooReference   = null;
  state.serverPublicRecord = null;
  state.idDetails = {
    idType: '', firstName: '', lastName: '', dob: '',
    idNumber: '', expiry: '', country: 'CA'
  };

  // Reset the ID-document phase UI
  ['doc-front-input','doc-back-input','id-type-select','id-type-select-sdk'].forEach(id=>{
    const el = document.getElementById(id); if (el) el.value = '';
  });
  ['doc-front-thumb','doc-back-thumb'].forEach(id=>{
    const t = document.getElementById(id);
    if (t) { t.classList.remove('has-image'); t.style.backgroundImage = '';
             t.parentElement?.classList.remove('has-image'); }
  });
  const cb = document.getElementById('doc-continue-btn');
  if (cb) cb.disabled = true;
  const sb = document.getElementById('sdk-start-btn');
  if (sb) { sb.disabled = true; sb.textContent = 'Start Trulioo verification \u2192'; }
  const sr = document.getElementById('sdk-start-row');
  if (sr) sr.style.display = '';
  const sm = document.getElementById('trulioo-sdk');
  if (sm) sm.innerHTML = '';
  const cc = document.getElementById('consent-check');
  if (cc) cc.checked = true;
  const ts = document.getElementById('trulioo-status-text');
  if (ts) ts.textContent = 'Select your ID type to begin.';
  const tp = document.getElementById('trulioo-progress');
  if (tp) tp.hidden = true;
  ['tv-step-1','tv-step-2','tv-step-3','tv-step-4'].forEach(id=>{
    const s=document.getElementById(id); if (s) s.classList.remove('active','done');
  });

  document.getElementById('saving-section').style.display = 'block';
  document.getElementById('pass-section').style.display   = 'none';
  document.getElementById('barcode-svg').innerHTML        = '';
  const se = document.getElementById('save-error');
  if (se) se.style.display = 'none';

  showPhase(1);
});

// ── CLEANUP ───────────────────────────────────────────────────────
window.addEventListener('beforeunload', () => {
  stopStream(selfieStream);
});
