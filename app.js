// ─────────────────────────────────────────────────────────────────
//  Mapleproof — app.js  (customer kiosk)
//  Flow: page load → live PDF417 scan of ID → selfie → encrypted save
//        → Code 128 barcode pass rendered + downloadable
// ─────────────────────────────────────────────────────────────────

import {
  BrowserMultiFormatReader,
  BarcodeFormat,
  DecodeHintType,
  NotFoundException
} from 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/+esm';

// ─────────────────────────────────────────────────────────────────
//  EMBEDDED CODE 128 BARCODE GENERATOR
//  Self-contained — no external CDN dependencies.
//  Generates SVG <rect> elements inside the target <svg>.
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
    barWidth: 2.4, height: 80, margin: 10,
    showText: true, fontSize: 14, textMargin: 6,
    background: '#ffffff', lineColor: '#000000',
    fontFamily: 'JetBrains Mono, monospace'
  }, opts);

  // Encode using Code Set B (printable ASCII 32–127)
  const START_B = 104, STOP = 106;
  const codes = [START_B];
  for (const ch of text) {
    const cc = ch.charCodeAt(0);
    if (cc < 32 || cc > 127) throw new Error('Code 128 B: char out of range');
    codes.push(cc - 32);
  }
  // Checksum: START + sum(code_i * position_i), where position starts at 1
  let sum = START_B;
  for (let i = 1; i < codes.length; i++) sum += codes[i] * i;
  codes.push(sum % 103);
  codes.push(STOP);

  // Build module pattern
  let pattern = '';
  for (const c of codes) pattern += CODE128_PATTERNS[c];

  // Compute size
  const totalW = pattern.length * o.barWidth + o.margin * 2;
  const totalH = o.height + (o.showText ? o.fontSize + o.textMargin : 0) + o.margin;

  // Reset SVG
  while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
  svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svgEl.setAttribute('width',  totalW);
  svgEl.setAttribute('height', totalH);
  svgEl.setAttribute('viewBox', `0 0 ${totalW} ${totalH}`);

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Background
  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('width', totalW);
  bg.setAttribute('height', totalH);
  bg.setAttribute('fill', o.background);
  svgEl.appendChild(bg);

  // Bars
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

  // Text below
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

// ── STATE ──────────────────────────────────────────────────────────
const state = {
  faceImageData: '',
  token:         '',
  parsed: { idNumber: '', dob: '', expiry: '', name: '', jurisdiction: '' },
  serverPublicRecord: null
};

// ── ZXing PDF417 reader for Ontario licence barcodes ──────────────
const hints = new Map();
hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.PDF_417]);
hints.set(DecodeHintType.TRY_HARDER, true);
const codeReader = new BrowserMultiFormatReader(hints);

// ── STREAMS ────────────────────────────────────────────────────────
let barcodeStream = null;
let selfieStream  = null;

// ── DOM ────────────────────────────────────────────────────────────
const barcodeVideo    = document.getElementById('barcode-video');
const barcodeProc     = document.getElementById('barcode-proc');
const barcodeCamLabel = document.getElementById('barcode-cam-label');
const barcodeStatus   = document.getElementById('barcode-status');
const barcodeSpinner  = document.getElementById('barcode-spinner');
const barcodeStatusTx = document.getElementById('barcode-status-text');
const barcodeRetryRow = document.getElementById('barcode-retry-row');

const selfieVideo  = document.getElementById('selfie-video');
const selfieCanvas = document.getElementById('selfie-canvas');

// ── PHASE NAVIGATION ──────────────────────────────────────────────
// Phase indices (legacy numeric API): 0=home, 1=scan, 2=selfie, 3=pass
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

// Wire up the home page CTA + back button
document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('start-btn');
  const backBtn  = document.getElementById('back-home-btn');
  if (startBtn) {
    startBtn.addEventListener('click', () => {
      showPhase(1);
      startBarcodeCamera();
    });
  }
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      scanActive = false;
      stopStream(barcodeStream);
      showPhase(0);
    });
  }
});

// ── IMAGE PROCESSING HELPERS ──────────────────────────────────────
function stopStream(stream) { if (stream) stream.getTracks().forEach(t => t.stop()); }

function cloneCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}
function cropCanvas(src, sx, sy, sw, sh) {
  const c = document.createElement('canvas');
  c.width  = Math.max(1, Math.round(sw));
  c.height = Math.max(1, Math.round(sh));
  c.getContext('2d').drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}
function scaleCanvas(src, factor) {
  const c = document.createElement('canvas');
  c.width  = Math.max(1, Math.round(src.width  * factor));
  c.height = Math.max(1, Math.round(src.height * factor));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
function grayscaleCanvas(src) {
  const c = cloneCanvas(src), ctx = c.getContext('2d');
  const id = ctx.getImageData(0, 0, c.width, c.height), d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = Math.round(d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114);
    d[i] = d[i+1] = d[i+2] = g;
  }
  ctx.putImageData(id, 0, 0);
  return c;
}
function thresholdCanvas(src, t = 145) {
  const c = grayscaleCanvas(src), ctx = c.getContext('2d');
  const id = ctx.getImageData(0, 0, c.width, c.height), d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] >= t ? 255 : 0;
    d[i] = d[i+1] = d[i+2] = v;
  }
  ctx.putImageData(id, 0, 0);
  return c;
}
function contrastCanvas(src, contrast = 80) {
  const c = cloneCanvas(src), ctx = c.getContext('2d');
  const id = ctx.getImageData(0, 0, c.width, c.height), d = id.data;
  const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
  const clamp  = v => Math.max(0, Math.min(255, Math.round(v)));
  for (let i = 0; i < d.length; i += 4) {
    d[i]   = clamp(factor * (d[i]   - 128) + 128);
    d[i+1] = clamp(factor * (d[i+1] - 128) + 128);
    d[i+2] = clamp(factor * (d[i+2] - 128) + 128);
  }
  ctx.putImageData(id, 0, 0);
  return c;
}
async function canvasToImage(canvas, quality = 0.95) {
  const img = new Image();
  img.src = canvas.toDataURL('image/jpeg', quality);
  await img.decode();
  return img;
}

// Try variants — reduced from 14 to 5 most effective for mobile speed.
// Each variant takes ~50-150ms on mobile, so fewer = faster scan loop.
async function tryDecodeCanvasVariants(base) {
  const bottom45 = cropCanvas(base, 0, base.height*0.50, base.width, base.height*0.45);
  const bottom45Scaled = scaleCanvas(bottom45, 1.8);

  const variants = [
    { label: 'b45',                canvas: bottom45 },
    { label: 'b45-thresh',         canvas: thresholdCanvas(bottom45, 140) },
    { label: 'b45-scaled',         canvas: bottom45Scaled },
    { label: 'b45-scaled-thresh',  canvas: thresholdCanvas(bottom45Scaled, 145) },
    { label: 'full-thresh',        canvas: thresholdCanvas(base, 145) },
  ];

  for (const v of variants) {
    try {
      const img    = await canvasToImage(v.canvas);
      const result = await codeReader.decodeFromImageElement(img);
      return { text: result.getText(), method: v.label };
    } catch (err) {
      if (!(err instanceof NotFoundException)) console.warn('[zxing]', v.label, err.message || err);
    }
  }
  throw new Error('No PDF417 found');
}

// ── AAMVA PARSE (Ontario / NA driver licence) ─────────────────────
function cleanField(raw = '') { return raw.replace(/[\n\r]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function parseAAMVADate(value) {
  if (!value) return '';
  const c = value.replace(/\D/g, '');
  if (c.length !== 8) return '';
  const first4 = Number(c.slice(0, 4));
  if (first4 > 1900 && first4 < 2100) return `${c.slice(0,4)}-${c.slice(4,6)}-${c.slice(6,8)}`;
  return `${c.slice(4,8)}-${c.slice(0,2)}-${c.slice(2,4)}`;
}
function findCode(raw, code) {
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(code)) return cleanField(line.slice(code.length));
  }
  const m = raw.match(new RegExp(`${code}([^\\n\\r]+)`));
  return m ? cleanField(m[1]) : '';
}
function parseBarcodeText(raw) {
  const last = findCode(raw, 'DCS'), first = findCode(raw, 'DAC'), mid = findCode(raw, 'DAD');
  const name = [first, mid, last].filter(Boolean).join(' ') || findCode(raw, 'DAA') || '';
  return {
    idNumber:     findCode(raw, 'DAQ'),
    dob:          parseAAMVADate(findCode(raw, 'DBB')),
    expiry:       parseAAMVADate(findCode(raw, 'DBA')),
    name,
    jurisdiction: [findCode(raw, 'DAJ'), findCode(raw, 'DCG')].filter(Boolean).join(' / ')
  };
}
function calculateAge(dob) {
  if (!dob) return null;
  const d = new Date(`${dob}T00:00:00`), t = new Date();
  let age = t.getFullYear() - d.getFullYear();
  const m = t.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && t.getDate() < d.getDate())) age--;
  return age;
}

function setBarcodeStatus(text, cls = '') {
  barcodeStatusTx.textContent = text;
  barcodeStatus.className = `status-card ${cls}`;
}

// ─────────────────────────────────────────────────────────────────
//  PHASE 1 — robust live scan loop using requestAnimationFrame
// ─────────────────────────────────────────────────────────────────
let scanActive       = false;   // outer rAF loop on/off
let decodeInFlight   = false;   // prevents async pile-up
let lastFrameTs      = 0;
const FRAME_INTERVAL = 600;     // ms between decode attempts

const frameCanvas = document.createElement('canvas');
const frameCtx    = frameCanvas.getContext('2d');

async function startBarcodeCamera() {
  setBarcodeStatus('Requesting camera…');
  barcodeSpinner.classList.remove('hidden');

  try {
    barcodeStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: 1280 },
        height: { ideal: 720 }
      }
    });
    barcodeVideo.srcObject = barcodeStream;
    await barcodeVideo.play();

    setBarcodeStatus('Camera ready. Hold the barcode side of the ID inside the frame.');
    barcodeCamLabel.textContent = 'Scanning…';
    barcodeCamLabel.className   = 'cam-status active';
    barcodeRetryRow.style.display = 'none';

    decodeInFlight = false;
    scanActive     = true;
    lastFrameTs    = 0;
    requestAnimationFrame(scanTick);

  } catch (err) {
    console.error(err);
    setBarcodeStatus('Camera access denied. Please allow camera access and try again.', 'error');
    barcodeSpinner.classList.add('hidden');
    barcodeCamLabel.textContent = 'Camera unavailable';
    barcodeCamLabel.className   = 'cam-status';
    barcodeRetryRow.style.display = 'flex';
  }
}

function scanTick(now) {
  if (!scanActive) return;
  if (now - lastFrameTs >= FRAME_INTERVAL && !decodeInFlight) {
    lastFrameTs = now;
    scanFrame();   // fire-and-forget; sets/clears decodeInFlight internally
  }
  requestAnimationFrame(scanTick);
}

async function scanFrame() {
  if (decodeInFlight) return;
  if (!barcodeVideo.videoWidth || !barcodeVideo.videoHeight) return;
  decodeInFlight = true;

  try {
    frameCanvas.width  = barcodeVideo.videoWidth;
    frameCanvas.height = barcodeVideo.videoHeight;
    frameCtx.drawImage(barcodeVideo, 0, 0);

    const result = await tryDecodeCanvasVariants(cloneCanvas(frameCanvas));

    // SUCCESS — stop loop immediately so we don't kick off a second decode
    scanActive = false;
    stopStream(barcodeStream);
    barcodeStream = null;
    barcodeProc.classList.remove('show');

    const parsed = parseBarcodeText(result.text);
    const age    = calculateAge(parsed.dob);

    // 18+ tier minimum (server enforces 19+ for Ontario alcohol/cannabis verified status)
    if (age !== null && age < 18) {
      barcodeCamLabel.textContent = 'Under 18';
      barcodeCamLabel.className   = 'cam-status';
      setBarcodeStatus(`Customer is ${age}. Cannot register — under the minimum age tier.`, 'error');
      barcodeSpinner.classList.add('hidden');
      barcodeRetryRow.style.display = 'flex';
      decodeInFlight = false;
      return;
    }

    if (parsed.expiry) {
      const exp   = new Date(`${parsed.expiry}T00:00:00`);
      const today = new Date();
      if (exp < new Date(today.getFullYear(), today.getMonth(), today.getDate())) {
        barcodeCamLabel.textContent = 'ID expired';
        barcodeCamLabel.className   = 'cam-status';
        setBarcodeStatus('This ID is expired. Please use a valid government-issued ID.', 'error');
        barcodeSpinner.classList.add('hidden');
        barcodeRetryRow.style.display = 'flex';
        decodeInFlight = false;
        return;
      }
    }

    state.parsed = parsed;
    barcodeCamLabel.textContent = '✓ Barcode read';
    barcodeCamLabel.className   = 'cam-status found';
    setBarcodeStatus(`Decoded successfully. Moving to selfie…`, 'ok');
    barcodeSpinner.classList.add('hidden');

    decodeInFlight = false;
    setTimeout(() => {
      showPhase(2);
      startSelfieCamera();
    }, 700);

  } catch {
    // No barcode this frame — quietly keep scanning
    decodeInFlight = false;
  }
}

// Retry button
document.getElementById('retry-barcode-btn').addEventListener('click', () => {
  barcodeRetryRow.style.display = 'none';
  startBarcodeCamera();
});

// ─────────────────────────────────────────────────────────────────
//  PHASE 2 — SELFIE
// ─────────────────────────────────────────────────────────────────
async function startSelfieCamera() {
  try {
    selfieStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    selfieVideo.srcObject = selfieStream;
    await selfieVideo.play();
  } catch (err) {
    console.error(err);
    alert('Front camera unavailable. Please allow camera access.');
  }
}

document.getElementById('capture-selfie-btn').addEventListener('click', () => {
  const w = selfieVideo.videoWidth  || 720;
  const h = selfieVideo.videoHeight || 720;
  selfieCanvas.width  = w;
  selfieCanvas.height = h;
  selfieCanvas.getContext('2d').drawImage(selfieVideo, 0, 0);
  state.faceImageData = selfieCanvas.toDataURL('image/jpeg', 0.86);

  stopStream(selfieStream);
  selfieStream = null;

  showPhase(3);
  saveAndGeneratePass();
});

document.getElementById('back-to-barcode-btn').addEventListener('click', () => {
  stopStream(selfieStream);
  selfieStream = null;
  state.parsed = { idNumber: '', dob: '', expiry: '', name: '', jurisdiction: '' };
  showPhase(1);
  startBarcodeCamera();
});

// ─────────────────────────────────────────────────────────────────
//  PHASE 3 — POST to server, render Code 128 barcode pass
// ─────────────────────────────────────────────────────────────────
function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: '2-digit' });
}

async function saveAndGeneratePass() {
  const savingSection = document.getElementById('saving-section');
  const passSection   = document.getElementById('pass-section');
  const saveError     = document.getElementById('save-error');

  savingSection.style.display = 'block';
  passSection.style.display   = 'none';
  saveError.style.display     = 'none';

  try {
    const response = await fetch('/api/register', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...state.parsed,
        faceImageData: state.faceImageData
      })
    });

    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Registration failed.');

    state.token              = data.token;
    state.serverPublicRecord = data.publicRecord;
    const pub = data.publicRecord;

    // Populate pass card (white card matching Mapleproof brand)
    document.getElementById('pass-age-badge').textContent  = pub.ageBadge || '19+';
    document.getElementById('pass-token-label').textContent = `ID · ${data.token}`;

    // Render Code 128 barcode (the value the retailer scanner reads)
    // Uses embedded generator — no external CDN dependency.
    const barcodeSvgEl = document.getElementById('barcode-svg');
    renderCode128(barcodeSvgEl, data.barcode, {
      barWidth: 2.4, height: 80, showText: true,
      fontSize: 14, textMargin: 6,
      background: '#ffffff', lineColor: '#000000',
      fontFamily: 'JetBrains Mono, monospace'
    });

    // Side metadata panel (status + issued date — expiry intentionally NOT shown to customer)
    document.getElementById('pass-face-photo').src    = state.faceImageData;
    document.getElementById('pass-status-val').textContent   = `REGISTERED · ${pub.ageBadge}`;

    const now = new Date();
    document.getElementById('pass-generated').textContent =
      `${now.toLocaleDateString('en-CA')} ${now.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' })}`;

    // Duplicate-account banner: if the same ID re-registered, show a friendly notice
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
    saveError.textContent       = `${err.message} — pass not generated. Check server connection.`;
  }
}

// ─────────────────────────────────────────────────────────────────
//  DOWNLOAD PASS — render the pass card to PNG
// ─────────────────────────────────────────────────────────────────
document.getElementById('download-pass-btn').addEventListener('click', async () => {
  const barcodeSvg = document.getElementById('barcode-svg');
  if (!barcodeSvg || !state.token) return;

  const W = 720, H = 960;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Card background (white, rounded look via clip)
  ctx.fillStyle = '#fff';
  roundRect(ctx, 0, 0, W, H, 0, true, false);

  // Top accent bar (red→orange→green)
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0,    '#d63a2e');
  grad.addColorStop(0.45, '#f08c2a');
  grad.addColorStop(0.95, '#2d8a3e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, 8);

  // Brand row
  ctx.fillStyle = '#2d8a3e';
  ctx.font = '600 30px Fraunces, Georgia, serif';
  ctx.fillText('Mapleproof', 70, 70);
  ctx.fillStyle = '#5a7c66';
  ctx.font = '500 11px JetBrains Mono, monospace';
  ctx.fillText('ONTARIO · 2026', W - 200, 68);

  // Eyebrow
  ctx.fillStyle = '#5a7c66';
  ctx.font = '500 14px JetBrains Mono, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('AGE VERIFIED', W/2, 140);

  // Big age badge
  ctx.fillStyle = '#2d8a3e';
  ctx.font = '600 130px Fraunces, Georgia, serif';
  ctx.fillText(state.serverPublicRecord?.ageBadge || '19+', W/2, 270);

  // Check circle
  ctx.beginPath();
  ctx.arc(W/2, 340, 38, 0, Math.PI * 2);
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#2d8a3e';
  ctx.stroke();
  ctx.font = '700 38px Inter, sans-serif';
  ctx.fillStyle = '#2d8a3e';
  ctx.textBaseline = 'middle';
  ctx.fillText('✓', W/2, 340);
  ctx.textBaseline = 'alphabetic';

  // Must check ID
  ctx.fillStyle = '#0d2418';
  ctx.font = '600 20px Inter, sans-serif';
  ctx.fillText('Must check ID.', W/2, 430);
  ctx.fillStyle = '#2a4232';
  ctx.font = '400 14px Inter, sans-serif';
  ctx.fillText('Retailer makes the final decision.', W/2, 458);

  // Barcode area — convert the SVG to image, then draw
  const svgString = new XMLSerializer().serializeToString(barcodeSvg);
  const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const svgUrl  = URL.createObjectURL(svgBlob);

  const barImg = new Image();
  barImg.onload = () => {
    // Dashed top/bottom borders for the barcode strip
    ctx.strokeStyle = 'rgba(13, 36, 24, 0.18)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(50, 510); ctx.lineTo(W - 50, 510); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(50, 670); ctx.lineTo(W - 50, 670); ctx.stroke();
    ctx.setLineDash([]);

    // Draw barcode centered
    const targetW = W - 140;
    const ratio   = barImg.height / barImg.width;
    const targetH = Math.min(140, targetW * ratio);
    ctx.drawImage(barImg, 70, 525, targetW, targetH);

    URL.revokeObjectURL(svgUrl);

    // Footer
    ctx.fillStyle = '#6b8978';
    ctx.font = '500 12px JetBrains Mono, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`ID · ${state.token}`, 70, 720);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#2a4232';
    ctx.font = 'italic 500 18px Fraunces, Georgia, serif';
    ctx.fillText('Thank you!', W - 70, 720);

    // Photo + meta
    ctx.textAlign = 'left';
    drawPhotoAndMeta(ctx, () => {
      const link = document.createElement('a');
      link.href     = canvas.toDataURL('image/png');
      link.download = `mapleproof-${state.token}.png`;
      link.click();
    });
  };
  barImg.src = svgUrl;
});

function drawPhotoAndMeta(ctx, done) {
  const x = 70, y = 770, w = 110, h = 110;
  ctx.strokeStyle = '#e0eae3';
  ctx.lineWidth   = 2;
  roundRect(ctx, x, y, w, h, 14, false, true);

  ctx.fillStyle = '#5a7c66';
  ctx.font = '500 11px JetBrains Mono, monospace';
  ctx.fillText('ID EXPIRES', x + w + 22, y + 28);
  ctx.fillStyle = '#0d2418';
  ctx.font = '500 18px Fraunces, Georgia, serif';
  ctx.fillText(formatDate(state.serverPublicRecord?.expiry || state.parsed.expiry), x + w + 22, y + 56);

  ctx.fillStyle = '#5a7c66';
  ctx.font = '500 11px JetBrains Mono, monospace';
  ctx.fillText('STATUS', x + w + 22, y + 82);
  ctx.fillStyle = '#2d8a3e';
  ctx.font = '600 16px Inter, sans-serif';
  ctx.fillText(`REGISTERED · ${state.serverPublicRecord?.ageBadge || '19+'}`, x + w + 22, y + 104);

  if (state.faceImageData) {
    const face = new Image();
    face.onload = () => {
      ctx.save();
      roundRectClip(ctx, x, y, w, h, 14);
      ctx.drawImage(face, x, y, w, h);
      ctx.restore();
      done();
    };
    face.onerror = done;
    face.src = state.faceImageData;
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
  stopStream(barcodeStream); stopStream(selfieStream);
  scanActive = false; decodeInFlight = false;
  barcodeStream = null; selfieStream = null;

  state.faceImageData      = '';
  state.token              = '';
  state.serverPublicRecord = null;
  state.parsed             = { idNumber: '', dob: '', expiry: '', name: '', jurisdiction: '' };

  // Reset phase 1 UI
  barcodeSpinner.classList.remove('hidden');
  barcodeCamLabel.textContent = 'Scanning…';
  barcodeCamLabel.className   = 'cam-status active';
  setBarcodeStatus('Starting camera…');
  barcodeRetryRow.style.display = 'none';
  barcodeProc.classList.remove('show');

  document.getElementById('saving-section').style.display = 'block';
  document.getElementById('pass-section').style.display   = 'none';
  document.getElementById('barcode-svg').innerHTML        = '';

  showPhase(1);
  startBarcodeCamera();
});

// ── INIT ──────────────────────────────────────────────────────────
// Camera does NOT start until the user taps "Get my pass" on the home screen.
// startBarcodeCamera is invoked from the home button handler in PHASE NAVIGATION.

window.addEventListener('beforeunload', () => {
  scanActive = false;
  stopStream(barcodeStream);
  stopStream(selfieStream);
});
