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
  idPhotoImage:   '',           // uploaded ID photo — used for matching, NEVER sent to server
  faceMatchScore: null,
  liveDescriptor: null,
  livenessChallenges: null,
  token:          '',
  // ID details collected from the manual form
  idDetails: {
    idType: '', firstName: '', lastName: '', dob: '',
    idNumber: '', expiry: '', country: ''
  },
  truliooReference: null,
  ocrConfidence:  null,
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
//  ID PARSING HELPERS (browser-side OCR via Tesseract.js)
// ─────────────────────────────────────────────────────────────────

// Parse many date formats → YYYY-MM-DD (or null)
function normalizeDate(raw) {
  if (!raw) return null;
  raw = raw.trim().replace(/[.\s]/g, '/').replace(/-/g, '/');
  const MON = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  let m;
  // YYYY/MM/DD
  if ((m = raw.match(/\b(\d{4})\/(\d{1,2})\/(\d{1,2})\b/))) {
    return `${m[1]}-${String(+m[2]).padStart(2,'0')}-${String(+m[3]).padStart(2,'0')}`;
  }
  // DD/MM/YYYY  (also handles MM/DD/YYYY ambiguity → prefer DD/MM if >12)
  if ((m = raw.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/))) {
    let d = +m[1], mo = +m[2];
    if (d > 12 && mo <= 12) { /* keep */ }
    else if (mo > 12 && d <= 12) { [d, mo] = [mo, d]; }
    return `${m[3]}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }
  // DD MON YYYY
  if ((m = raw.match(/\b(\d{1,2})\/?([a-zA-Z]{3})[a-zA-Z]*\/?(\d{4})\b/))) {
    const mo = MON[m[2].toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2,'0')}-${String(+m[1]).padStart(2,'0')}`;
  }
  // YYMMDD (MRZ)
  if ((m = raw.match(/\b(\d{2})(\d{2})(\d{2})\b/))) {
    const yy = +m[1]; const year = yy < 30 ? 2000 + yy : 1900 + yy;
    if (+m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31)
      return `${year}-${m[2]}-${m[3]}`;
  }
  return null;
}

// Pull all plausible dates out of OCR text, in order
function findDates(text) {
  const out = [];
  const re = /\b(\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}|\d{1,2}[\/\-.\s][A-Za-z]{3,9}[\/\-.\s]\d{4}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = normalizeDate(m[1]);
    if (n) out.push(n);
  }
  return out;
}

// Parse passport MRZ (TD3, 2 lines of 44). Returns {lastName,firstName,docNumber,dob,expiry,country} or null
function parseMRZ(text) {
  const lines = text.toUpperCase().split(/\n/).map(l => l.replace(/\s/g, ''));
  const mrz = lines.filter(l => /^[A-Z0-9<]{30,}$/.test(l) && l.includes('<'));
  if (mrz.length < 2) return null;
  const l1 = mrz[mrz.length - 2], l2 = mrz[mrz.length - 1];
  try {
    const country = (l1.match(/^P[<A-Z]([A-Z]{3})/) || [])[1] || 'CAN';
    const names = l1.slice(5).split('<<');
    const lastName  = (names[0] || '').replace(/</g, ' ').trim();
    const firstName = (names[1] || '').replace(/</g, ' ').trim();
    const docNumber = l2.slice(0, 9).replace(/</g, '');
    const dob    = normalizeDate(l2.slice(13, 19));
    const expiry = normalizeDate(l2.slice(21, 27));
    if (lastName && (dob || expiry))
      return { lastName, firstName, docNumber, dob, expiry, country: 'CA' };
  } catch (_) {}
  return null;
}

// Heuristic field extraction from OCR text for non-passport IDs
function extractFields(text, idType) {
  const up = text.toUpperCase();
  const res = { firstName:'', lastName:'', dob:'', expiry:'', idNumber:'' };

  if (idType === 'passport_ca') {
    const mrz = parseMRZ(text);
    if (mrz) { Object.assign(res, mrz); }
  }

  // Dates: assume earliest plausible = DOB, latest = expiry
  const dates = findDates(text)
    .filter(d => { const y = +d.slice(0,4); return y >= 1900 && y <= 2100; })
    .sort();
  if (dates.length && !res.dob)    res.dob = dates[0];
  if (dates.length > 1 && !res.expiry) res.expiry = dates[dates.length - 1];

  // Document number — labelled patterns first
  if (!res.idNumber) {
    const lab = up.match(/(?:NO|NUMBER|NUMÉRO|N°|DL|#)[:.\s]{0,3}([A-Z0-9\-]{5,20})/);
    if (lab) res.idNumber = lab[1];
    else {
      const cand = up.match(/\b([A-Z0-9]{5,9}[-\s]?\d{4,10})\b/) || up.match(/\b(\d{8,15})\b/);
      if (cand) res.idNumber = cand[1].replace(/\s/g,'');
    }
  }

  // Name — look for "LN, FN" or labelled lines (best-effort; user confirms)
  if (!res.lastName) {
    const ln = text.match(/(?:Surname|Last Name|Nom)[:\s]+([A-Z][A-Za-z'\-]+)/i);
    const fn = text.match(/(?:Given Name|First Name|Pr[eé]nom)[:\s]+([A-Z][A-Za-z'\-]+)/i);
    if (ln) res.lastName  = ln[1];
    if (fn) res.firstName = fn[1];
  }
  return res;
}

// Decide whether the upload is plausibly a photo ID document.
//
// Browser OCR is unreliable on real IDs (holograms, small fonts, glare,
// angles), so we DO NOT hard-reject based on keyword matching. We only
// reject things that are clearly NOT a photo-ID document (a blank image,
// a plain selfie, a screenshot of text, a random object). Keyword matches
// only raise/lower a confidence flag — the review step lets the user fix
// anything OCR misread.
function validateIsId(text, idType, hasFace) {
  const up    = (text || '').toUpperCase();
  const clean = up.replace(/[^A-Z0-9]/g, '');
  const textLen = clean.length;
  const hasDate = findDates(text || '').length > 0;

  // Fuzzy keyword presence (tolerate OCR noise / punctuation)
  const kws = ID_TYPE_KEYWORDS[idType] || [];
  let hits = 0;
  for (const k of kws) {
    const kk = k.replace(/[^A-Z0-9]/g, '');
    if (kk && (up.includes(k) || clean.includes(kk))) hits++;
  }
  // Generic government / document hints (loose — survives OCR errors)
  const govHint = /CAN|ONT|GOUV|GOVERN|RESID|CITIZ|FORCE|STATUS|PERMIS|LICEN|LICmanage|PASSP|CARTE|CARD|BIRTH|SEX|EXP/.test(clean);

  // ── Hard rejections: only obvious non-documents ──
  // Nothing at all: no face, no dates, almost no text → blank/object/garbage
  if (!hasFace && !hasDate && textLen < 30 && !govHint)
    return { ok:false, reason:'not_a_document' };
  // A face but no document signals whatsoever → just a selfie
  if (hasFace && !hasDate && textLen < 18 && !govHint)
    return { ok:false, reason:'selfie_not_id' };
  // No face and no document signals → not a photo ID
  if (!hasFace && !hasDate && !govHint)
    return { ok:false, reason:'no_face' };

  // Otherwise accept. The review step handles correctness.
  const strong = (hits >= 1) && (govHint || hasDate) && hasFace;
  return { ok:true, confidence: strong ? 'high' : 'low' };
}

// ─────────────────────────────────────────────────────────────────
//  PHASE 1 — UPLOAD ID → OCR EXTRACT → REVIEW
// ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const startBtn   = document.getElementById('start-btn');
  const backBtn2   = document.getElementById('back-home-btn-2');
  if (startBtn) startBtn.addEventListener('click', () => showPhase(1));
  if (backBtn2) backBtn2.addEventListener('click', () => showPhase(0));

  const idTypeSelect = document.getElementById('id-type-select');
  const idPhotoInput = document.getElementById('id-photo-input');
  const idUploadLbl  = document.getElementById('id-upload-label');
  const idPhotoThumb = document.getElementById('id-photo-thumb');
  const uploadStatus = document.getElementById('upload-status-text');
  const processBtn   = document.getElementById('upload-process-btn');
  const consentCheck = document.getElementById('consent-check');
  const consentRow   = document.getElementById('consent-row');
  const reviewBlock  = document.getElementById('review-block');
  const reviewBanner = document.getElementById('review-banner');
  const ocrProgress  = document.getElementById('ocr-progress');
  const firstName    = document.getElementById('id-first-name');
  const lastName     = document.getElementById('id-last-name');
  const dobInput     = document.getElementById('id-dob');
  const idNumber     = document.getElementById('id-number');
  const expiryInput  = document.getElementById('id-expiry');
  const countrySel   = document.getElementById('id-country');

  let scanned = false;

  function setStatus(msg, tone) {
    if (!uploadStatus) return;
    uploadStatus.textContent = msg;
    uploadStatus.parentElement.dataset.tone = tone || '';
  }

  // Enable the upload control only once an ID type is chosen
  idTypeSelect?.addEventListener('change', () => {
    const on = !!idTypeSelect.value;
    idPhotoInput.disabled = !on;
    idUploadLbl?.classList.toggle('disabled', !on);
    if (on && !scanned) setStatus('Upload a clear photo of your ' + (ID_TYPE_LABELS[idTypeSelect.value]||'ID') + '.');
    else if (!on) setStatus('Select your ID type to begin.');
  });

  function reviewComplete() {
    return !!(firstName.value.trim() && lastName.value.trim() &&
              dobInput.value && idNumber.value.trim() && expiryInput.value);
  }
  function refreshBtn() {
    const ok = scanned && reviewComplete() && consentCheck && consentCheck.checked;
    if (processBtn) processBtn.disabled = !ok;
  }
  [firstName,lastName,dobInput,idNumber,expiryInput].forEach(el=>{
    el?.addEventListener('input', refreshBtn);
    el?.addEventListener('change', refreshBtn);
  });
  consentCheck?.addEventListener('change', refreshBtn);

  function ocrStep(n, cls) {
    const s = document.getElementById('ocr-step-' + n);
    if (s) { s.classList.remove('active','done'); s.classList.add(cls); }
  }

  // Main: upload → validate → OCR → extract → review
  idPhotoInput?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Reject anything that is not an image up-front
    if (!file.type || !file.type.startsWith('image/')) {
      setStatus('That is not an image. Please upload a photo of your ID only.', 'bad');
      idPhotoInput.value = ''; return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setStatus('That image is too large (max 25 MB).', 'bad'); idPhotoInput.value=''; return;
    }

    const idType = idTypeSelect.value;
    if (!idType) { setStatus('Select your ID type first.', 'bad'); idPhotoInput.value=''; return; }

    scanned = false;
    if (reviewBlock) reviewBlock.hidden = true;
    if (consentRow)  consentRow.hidden  = true;
    refreshBtn();

    const dataUrl = await resizeImageFile(file, 1700, 0.9);
    state.idPhotoImage = dataUrl;
    if (idPhotoThumb) {
      idPhotoThumb.classList.add('has-image');
      idPhotoThumb.style.backgroundImage = `url('${dataUrl}')`;
      idPhotoThumb.parentElement?.classList.add('has-image');
    }

    if (ocrProgress) ocrProgress.hidden = false;
    ['1','2','3','4'].forEach(n=>{const s=document.getElementById('ocr-step-'+n);s&&s.classList.remove('active','done');});

    try {
      // Step 1 — basic image sanity
      ocrStep(1,'active');
      setStatus('Scanning your ID…');
      await new Promise(r=>setTimeout(r,300));

      // Step 2 — look for the ID's face photo (used as a soft signal)
      ocrStep(1,'done'); ocrStep(2,'active');
      await loadFaceApiModels();
      let hasFace = false;
      try {
        if (faceApiReady) {
          const img = await dataUrlToImage(dataUrl);
          // ID portraits are small & stylised — try a couple of settings
          for (const opt of [
            { inputSize: 512, scoreThreshold: 0.25 },
            { inputSize: 320, scoreThreshold: 0.20 }
          ]) {
            const det = await faceapi.detectSingleFace(img,
              new faceapi.TinyFaceDetectorOptions(opt));
            if (det) { hasFace = true; break; }
          }
        } else { hasFace = true; } // models unavailable → don't block
      } catch (_) { hasFace = true; }

      // Step 3 — OCR the text
      ocrStep(2,'done'); ocrStep(3,'active');
      setStatus('Reading the text on your ID…');
      let text = '';
      try {
        if (window.Tesseract) {
          const { data } = await Tesseract.recognize(dataUrl, 'eng');
          text = (data && data.text) || '';
        }
      } catch (err) { console.warn('[ocr] failed:', err); }

      // Validate it really is the selected ID
      const verdict = validateIsId(text, idType, hasFace);
      if (!verdict.ok) {
        if (ocrProgress) ocrProgress.hidden = true;
        const msgs = {
          no_face:        'This doesn\'t look like a photo ID. Please upload a clear photo of your ' + ID_TYPE_LABELS[idType] + ' — and nothing else.',
          not_a_document: 'We couldn\'t detect an ID document in this image. Please upload a clear, well-lit photo of your ' + ID_TYPE_LABELS[idType] + '.',
          selfie_not_id:  'That looks like a selfie, not an ID. Please upload a photo of your ' + ID_TYPE_LABELS[idType] + ' (you\'ll take a selfie later).'
        };
        setStatus(msgs[verdict.reason] || 'This does not appear to be a valid ID. Please try again.', 'bad');
        state.idPhotoImage = '';
        if (idPhotoThumb){idPhotoThumb.classList.remove('has-image');idPhotoThumb.style.backgroundImage='';}
        idPhotoInput.value = '';
        return;
      }

      // Step 4 — extract fields
      const f = extractFields(text, idType);
      if (firstName)  firstName.value  = f.firstName || '';
      if (lastName)   lastName.value   = f.lastName  || '';
      if (dobInput)   dobInput.value   = f.dob       || '';
      if (idNumber)   idNumber.value   = f.idNumber  || '';
      if (expiryInput)expiryInput.value= f.expiry    || '';
      if (countrySel) countrySel.value = 'CA';

      ocrStep(3,'done'); ocrStep(4,'active'); ocrStep(4,'done');
      await new Promise(r=>setTimeout(r,250));
      if (ocrProgress) ocrProgress.hidden = true;

      scanned = true;
      state.ocrConfidence = verdict.confidence;
      if (reviewBlock) reviewBlock.hidden = false;
      if (consentRow)  consentRow.hidden  = false;

      const missing = !f.dob || !f.expiry || !f.lastName;
      if (reviewBanner) {
        reviewBanner.textContent = missing
          ? 'We could not read everything clearly. Please fill in or correct the highlighted details from your ID.'
          : 'We read these details from your ID. Please check them and correct anything that is wrong.';
        reviewBanner.classList.toggle('warn', missing);
      }
      setStatus(missing
        ? 'Almost there — complete the details below to continue.'
        : '✓ ID read successfully. Review the details below.');
      refreshBtn();
    } catch (err) {
      console.error('[scan] error:', err);
      if (ocrProgress) ocrProgress.hidden = true;
      setStatus('Something went wrong reading your ID. Please try another photo.', 'bad');
    }
  });

  // Continue → final validation → liveness
  processBtn?.addEventListener('click', () => {
    if (!scanned || !reviewComplete()) return;

    const age = calculateAge(dobInput.value);
    if (age !== null && age < 18) {
      setStatus(`This ID shows an age of ${age} — under the minimum age for verification.`, 'bad');
      return;
    }
    const exp = new Date(`${expiryInput.value}T00:00:00`);
    if (!Number.isNaN(exp.getTime()) && exp.getTime() < Date.now()) {
      setStatus('This ID is expired. Please use a valid, unexpired ID.', 'bad');
      return;
    }

    state.idDetails = {
      idType:    idTypeSelect.value,
      firstName: firstName.value.trim(),
      lastName:  lastName.value.trim(),
      dob:       dobInput.value,
      idNumber:  idNumber.value.trim(),
      expiry:    expiryInput.value,
      country:   'CA'
    };
    setStatus('✓ Details confirmed. Continuing to the liveness check…');
    setTimeout(() => showPhase(2), 450);
  });

  // Pre-load face models in the background
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
  saveAndGeneratePass();
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
//  TRULIOO VERIFICATION (SIMULATED)
//  ────────────────────────────────────────────────────────────────
//  This calls our own /api/trulioo-verify endpoint, which currently
//  FAKES a successful Trulioo identity-verification response. When a
//  real Trulioo contract is signed, the server endpoint is swapped to
//  call Trulioo's GlobalGateway API — the browser code stays the same.
// ─────────────────────────────────────────────────────────────────
async function runTruliooVerification() {
  const progress = document.getElementById('trulioo-progress');
  const steps = [
    document.getElementById('trulioo-step-1'),
    document.getElementById('trulioo-step-2'),
    document.getElementById('trulioo-step-3'),
    document.getElementById('trulioo-step-4')
  ];
  if (progress) progress.hidden = false;
  steps.forEach(s => s && s.classList.remove('active', 'done'));

  // Animate the first 3 steps visually while the request runs
  const animate = (async () => {
    for (let i = 0; i < 3; i++) {
      steps[i]?.classList.add('active');
      await new Promise(r => setTimeout(r, 700));
      steps[i]?.classList.remove('active');
      steps[i]?.classList.add('done');
    }
  })();

  let result;
  try {
    const resp = await fetch('/api/trulioo-verify', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idType:    state.idDetails.idType,
        firstName: state.idDetails.firstName,
        lastName:  state.idDetails.lastName,
        dob:       state.idDetails.dob,
        idNumber:  state.idDetails.idNumber,
        expiry:    state.idDetails.expiry,
        country:   state.idDetails.country
      })
    });
    result = await resp.json();
  } catch (err) {
    console.error('[trulioo] network error:', err);
    result = { ok: false, error: 'Could not reach the verification service.' };
  }

  await animate;

  if (!result.ok || !result.verified) {
    if (progress) progress.hidden = true;
    throw new Error(result.error || 'Identity verification did not pass. Please check your details.');
  }

  // Mark final step done
  steps[3]?.classList.add('active', 'done');
  state.truliooReference = result.reference || null;
  await new Promise(r => setTimeout(r, 500));
  if (progress) progress.hidden = true;
  return result;
}

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

    // ── 3) TRULIOO IDENTITY VERIFICATION (simulated) ──
    if (savingMsg) savingMsg.textContent = 'Verifying your identity with Trulioo…';
    await runTruliooVerification();   // throws if it doesn't pass

    // ── 4) Submit to server ──
    //     We send: ID details, the verified selfie, match score, Trulioo
    //     reference. We do NOT send the ID photo — face matching already
    //     happened in-browser, and the ID photo is never stored.
    if (savingMsg) savingMsg.textContent = 'Saving your pass…';

    const consentEl = document.getElementById('consent-check');
    if (!consentEl || !consentEl.checked) {
      throw new Error('You must accept the privacy notice and terms to continue.');
    }

    const response = await fetch('/api/register', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idType:        state.idDetails.idType,
        firstName:     state.idDetails.firstName,
        lastName:      state.idDetails.lastName,
        name:          `${state.idDetails.firstName} ${state.idDetails.lastName}`.trim(),
        dob:           state.idDetails.dob,
        idNumber:      state.idDetails.idNumber,
        expiry:        state.idDetails.expiry,
        country:       state.idDetails.country,
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
      ID_TYPE_LABELS[state.idDetails.idType] || 'ID';

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
  state.faceMatchScore     = null;
  state.liveDescriptor     = null;
  state.livenessChallenges = null;
  state.token              = '';
  state.truliooReference   = null;
  state.ocrConfidence      = null;
  state.serverPublicRecord = null;
  state.idDetails = {
    idType: '', firstName: '', lastName: '', dob: '',
    idNumber: '', expiry: '', country: ''
  };

  // Reset form
  ['id-type-select', 'id-first-name', 'id-last-name', 'id-dob',
   'id-number', 'id-expiry', 'id-photo-input'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const idInput = document.getElementById('id-photo-input');
  if (idInput) idInput.disabled = true;
  const rb = document.getElementById('review-block');
  if (rb) rb.hidden = true;
  const cr = document.getElementById('consent-row');
  if (cr) cr.hidden = true;
  const op = document.getElementById('ocr-progress');
  if (op) op.hidden = true;
  const thumb = document.getElementById('id-photo-thumb');
  if (thumb) {
    thumb.classList.remove('has-image');
    thumb.style.backgroundImage = '';
    thumb.parentElement?.classList.remove('has-image');
  }
  const cc = document.getElementById('consent-check');
  if (cc) cc.checked = false;
  const ub = document.getElementById('upload-process-btn');
  if (ub) ub.disabled = true;
  const us = document.getElementById('upload-status-text');
  if (us) us.textContent = 'Select your ID type to begin.';

  document.getElementById('saving-section').style.display = 'block';
  document.getElementById('pass-section').style.display   = 'none';
  document.getElementById('barcode-svg').innerHTML        = '';
  const tp = document.getElementById('trulioo-progress');
  if (tp) tp.hidden = true;

  showPhase(1);
});

// ── CLEANUP ───────────────────────────────────────────────────────
window.addEventListener('beforeunload', () => {
  stopStream(selfieStream);
});
