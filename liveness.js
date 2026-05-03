// ─────────────────────────────────────────────────────────────────
//  Mapleproof — liveness.js  (v4: calibrated thresholds, better UX)
//
//  HOW IT WORKS (and why blink failed before):
//  - The old version used a fixed EAR threshold (0.20). Many users
//    have a resting EAR below 0.25, so they could "blink" without
//    ever crossing it. Some users have narrow eyes that never read
//    above 0.27 even fully open.
//  - This version CALIBRATES to each user's face for 1.5 sec before
//    starting, then uses RELATIVE thresholds (% of their resting EAR).
//  - Same idea for smile (uses resting mouth width as baseline).
//  - Live feedback so the user knows the camera sees them.
//  - Polls every 30ms (was 80ms) so we don't miss quick blinks.
//
//  PUBLIC API
//  - MapleproofLiveness.runLivenessChallenge(opts) → result
//  - MapleproofLiveness.compareDescriptorToImage(desc, dataUrl) → 0..1
//  - MapleproofLiveness.cropFaceFromImage(dataUrl) → dataUrl (face only)
//  - MapleproofLiveness.ensureModels() → bool
// ─────────────────────────────────────────────────────────────────

(function (global) {
  'use strict';

  const MODEL_URL = 'https://justadudewhohacks.github.io/face-api.js/models';

  // ── Geometric helpers ─────────────────────────────────────────
  function dist(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function eyeAspectRatio(eye) {
    const v1 = dist(eye[1], eye[5]);
    const v2 = dist(eye[2], eye[4]);
    const h  = dist(eye[0], eye[3]);
    return (v1 + v2) / (2 * h || 1);
  }

  function avgEarFromLandmarks(landmarks) {
    const right = landmarks.slice(36, 42);
    const left  = landmarks.slice(42, 48);
    return (eyeAspectRatio(right) + eyeAspectRatio(left)) / 2;
  }

  function mouthMetrics(landmarks) {
    const mouth = landmarks.slice(48, 68);
    const w = dist(mouth[0], mouth[6]);
    const h = dist(mouth[3], mouth[9]);
    const innerH = dist(mouth[13], mouth[19]);
    const faceW = dist(landmarks[0], landmarks[16]);
    return {
      width: w,
      height: h,
      innerHeight: innerH,
      widthRatio: faceW > 0 ? w / faceW : 0,
      hwRatio: w > 0 ? h / w : 0,
      innerOpenRatio: w > 0 ? innerH / w : 0
    };
  }

  function headYaw(landmarks) {
    const noseTip = landmarks[30];
    const faceL = landmarks[0];
    const faceR = landmarks[16];
    const faceCenterX = (faceL.x + faceR.x) / 2;
    const faceWidth   = Math.abs(faceR.x - faceL.x);
    if (faceWidth < 1) return 0;
    return (noseTip.x - faceCenterX) / faceWidth;
  }

  // ── Challenge definitions ─────────────────────────────────────
  // verify(landmarks, ctx, baseline) → { done, hint? }
  const CHALLENGES = {
    blink: {
      id: 'blink',
      prompt: 'Blink your eyes',
      icon: '👁️',
      verify(landmarks, ctx, baseline) {
        const ear = avgEarFromLandmarks(landmarks);
        // Adapt to user's resting EAR — 70% = closed, 88% = open
        const closedThreshold = baseline.ear * 0.70;
        const openThreshold   = baseline.ear * 0.88;

        ctx.minSeenEar = Math.min(ctx.minSeenEar ?? ear, ear);
        ctx.blinkSawClosed = ctx.blinkSawClosed || ear < closedThreshold;

        if (ctx.blinkSawClosed && ear > openThreshold) {
          return { done: true };
        }
        const hint = ctx.blinkSawClosed
          ? 'Now open your eyes…'
          : 'Close your eyes briefly';
        return { done: false, hint };
      }
    },

    smile: {
      id: 'smile',
      prompt: 'Smile big',
      icon: '😄',
      verify(landmarks, ctx, baseline) {
        const m = mouthMetrics(landmarks);
        const grew = baseline.mouthWidthRatio > 0
          ? (m.widthRatio / baseline.mouthWidthRatio) >= 1.08
          : m.widthRatio > 0.45;
        const flat = m.hwRatio < 0.40;
        if (grew && flat) return { done: true };
        return { done: false, hint: grew ? 'Almost — keep smiling' : 'Show your teeth!' };
      }
    },

    mouth_open: {
      id: 'mouth_open',
      prompt: 'Open your mouth wide',
      icon: '😮',
      verify(landmarks, ctx, baseline) {
        const m = mouthMetrics(landmarks);
        if (m.innerOpenRatio > 0.20) return { done: true };
        return { done: false, hint: m.innerOpenRatio > 0.10 ? 'Wider…' : 'Open your mouth' };
      }
    },

    turn_left: {
      id: 'turn_left',
      prompt: 'Turn your head LEFT',
      icon: '👈',
      verify(landmarks) {
        const yaw = headYaw(landmarks);
        if (yaw > 0.10) return { done: true };
        return { done: false, hint: 'Slowly turn your head left' };
      }
    },

    turn_right: {
      id: 'turn_right',
      prompt: 'Turn your head RIGHT',
      icon: '👉',
      verify(landmarks) {
        const yaw = headYaw(landmarks);
        if (yaw < -0.10) return { done: true };
        return { done: false, hint: 'Slowly turn your head right' };
      }
    }
  };

  function randomChallenges(n = 3) {
    const all = Object.keys(CHALLENGES);
    const shuffled = all.slice().sort(() => Math.random() - 0.5);
    return shuffled.slice(0, n).map(id => CHALLENGES[id]);
  }

  // ── Model loading ─────────────────────────────────────────────
  let modelsReady = false;
  let modelsLoading = null;

  async function ensureModels() {
    if (modelsReady) return true;
    if (modelsLoading) return modelsLoading;
    if (typeof faceapi === 'undefined') {
      console.warn('[liveness] face-api.js not loaded');
      return false;
    }
    modelsLoading = (async () => {
      try {
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
          faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
          faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
        ]);
        modelsReady = true;
        console.log('[liveness] models loaded ✓');
        return true;
      } catch (err) {
        console.error('[liveness] model load failed:', err);
        return false;
      }
    })();
    return modelsLoading;
  }

  // ── Calibration: read user's resting face for ~1.5 sec ─────────
  async function calibrate(videoEl, opts, statusFn) {
    const samples = [];
    const start = Date.now();
    while (Date.now() - start < 2000 && samples.length < 15) {
      const det = await faceapi.detectSingleFace(videoEl, opts).withFaceLandmarks();
      if (det) {
        const lm = det.landmarks.positions;
        samples.push({
          ear: avgEarFromLandmarks(lm),
          mouth: mouthMetrics(lm),
          score: det.detection.score
        });
        if (statusFn) statusFn(`Calibrating… ${samples.length}/15`);
      } else {
        if (statusFn) statusFn('Looking for your face…');
      }
      await new Promise(r => setTimeout(r, 100));
    }
    if (samples.length < 5) return null;

    const med = arr => {
      const s = arr.slice().sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    return {
      ear: med(samples.map(s => s.ear)),
      mouthWidthRatio: med(samples.map(s => s.mouth.widthRatio)),
      mouthHwRatio: med(samples.map(s => s.mouth.hwRatio)),
      sampleCount: samples.length
    };
  }

  // ── Main liveness flow ────────────────────────────────────────
  async function runLivenessChallenge(opts) {
    const {
      videoEl, overlayEl, promptEl, iconEl, stepEl, hintEl,
      challengeCount = 3,
      timeoutPerChallenge = 15000,
      onCalibrating,
      onChallengeChange
    } = opts;

    if (!await ensureModels()) {
      throw new Error('Face detection models could not be loaded.');
    }

    const detectorOpts = new faceapi.TinyFaceDetectorOptions({
      inputSize: 320, scoreThreshold: 0.4
    });

    // Calibrate
    if (promptEl) promptEl.textContent = 'Look at the camera';
    if (iconEl)   iconEl.textContent = '😊';
    if (stepEl)   stepEl.textContent = 'Calibrating…';
    if (hintEl)   hintEl.textContent = 'Hold still — finding your face';

    const baseline = await calibrate(videoEl, detectorOpts,
      (msg) => { if (onCalibrating) onCalibrating(msg); if (hintEl) hintEl.textContent = msg; });

    if (!baseline) {
      return {
        success: false,
        message: 'Could not detect your face clearly. Make sure your face is well lit and centered. Try moving closer to the camera.'
      };
    }
    console.log('[liveness] baseline:', baseline);

    const challenges = randomChallenges(challengeCount);
    console.log('[liveness] sequence:', challenges.map(c => c.id).join(' → '));

    const captured = [];

    function captureCurrentFrame(detection) {
      const c = document.createElement('canvas');
      c.width = videoEl.videoWidth;
      c.height = videoEl.videoHeight;
      const cx = c.getContext('2d');
      cx.translate(c.width, 0);
      cx.scale(-1, 1);
      cx.drawImage(videoEl, 0, 0);
      captured.push({
        dataUrl: c.toDataURL('image/jpeg', 0.86),
        descriptor: detection.descriptor,
        score: detection.detection.score,
        box: detection.detection.box
      });
    }

    function drawOverlay(box, color) {
      if (!overlayEl) return;
      const ctx2 = overlayEl.getContext('2d');
      overlayEl.width = videoEl.clientWidth;
      overlayEl.height = videoEl.clientHeight;
      ctx2.clearRect(0, 0, overlayEl.width, overlayEl.height);
      if (!box) return;
      const sx = overlayEl.width  / videoEl.videoWidth;
      const sy = overlayEl.height / videoEl.videoHeight;
      // Mirror to match the mirrored video display
      const x = overlayEl.width - (box.x + box.width) * sx;
      ctx2.strokeStyle = color;
      ctx2.lineWidth = 4;
      ctx2.strokeRect(x, box.y * sy, box.width * sx, box.height * sy);
    }

    for (let i = 0; i < challenges.length; i++) {
      const ch = challenges[i];
      if (promptEl) promptEl.textContent = ch.prompt;
      if (iconEl)   iconEl.textContent   = ch.icon;
      if (stepEl)   stepEl.textContent   = `Step ${i + 1} of ${challenges.length}`;
      if (hintEl)   hintEl.textContent   = '';
      if (onChallengeChange) onChallengeChange(ch.id, i, challenges.length);

      const ctx = {};
      const startedAt = Date.now();
      let succeeded = false;
      let lastFaceSeen = startedAt;
      let withDescriptor = null;
      let frameCount = 0;

      while (Date.now() - startedAt < timeoutPerChallenge) {
        frameCount++;
        // Lightweight detection most frames; with-descriptor every 4th frame
        const wantDescriptor = !withDescriptor && (frameCount % 4 === 0);
        const detection = wantDescriptor
          ? await faceapi.detectSingleFace(videoEl, detectorOpts).withFaceLandmarks().withFaceDescriptor()
          : await faceapi.detectSingleFace(videoEl, detectorOpts).withFaceLandmarks();

        if (detection) {
          lastFaceSeen = Date.now();
          if (wantDescriptor && detection.descriptor) {
            withDescriptor = detection;
          }
          drawOverlay(detection.detection.box, succeeded ? '#1f6f48' : '#d97a23');
          const result = ch.verify(detection.landmarks.positions, ctx, baseline);
          if (hintEl && result.hint) hintEl.textContent = result.hint;
          if (result.done) {
            succeeded = true;
            // Make sure we have a descriptor before capturing — request one now if needed
            const captureSrc = withDescriptor || (detection.descriptor
              ? detection
              : await faceapi.detectSingleFace(videoEl, detectorOpts).withFaceLandmarks().withFaceDescriptor());
            if (captureSrc && captureSrc.descriptor) captureCurrentFrame(captureSrc);
            else captureCurrentFrame({ ...detection, descriptor: null }); // image only as fallback
            break;
          }
        } else {
          drawOverlay(null, '#d97a23');
          if (Date.now() - lastFaceSeen > 1500) {
            if (hintEl) hintEl.textContent = "I can't see your face — center it in the frame";
          }
        }
        await new Promise(r => setTimeout(r, 30));
      }

      if (!succeeded) {
        return {
          success: false,
          failedChallenge: ch.id,
          message: `Couldn't detect "${ch.prompt}". Make sure your face is well lit and try doing the action more deliberately.`
        };
      }

      if (promptEl) promptEl.textContent = '✓ Got it!';
      if (iconEl)   iconEl.textContent   = '✅';
      if (hintEl)   hintEl.textContent   = '';
      await new Promise(r => setTimeout(r, 600));
    }

    if (captured.length === 0) {
      return { success: false, message: 'No frames captured during liveness check.' };
    }

    // Best frame = one with descriptor, then highest detection score
    const withDesc = captured.filter(c => c.descriptor);
    const pool = withDesc.length ? withDesc : captured;
    const best = pool.reduce((a, b) => a.score > b.score ? a : b);

    return {
      success: true,
      faceImageData:  best.dataUrl,
      descriptor:     best.descriptor,
      faceBox:        best.box,
      framesCount:    captured.length,
      challenges:     challenges.map(c => c.id),
      baseline
    };
  }

  // ── Compare descriptor against an image (e.g. ID front) ───────
  async function compareDescriptorToImage(descriptor, idDataUrl) {
    if (!descriptor || !idDataUrl) return null;
    if (!await ensureModels()) return null;
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = idDataUrl; });

      const idDetect = await faceapi
        .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.4 }))
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (!idDetect) {
        console.warn('[liveness] no face found in ID image');
        return null;
      }

      const distance = faceapi.euclideanDistance(descriptor, idDetect.descriptor);
      const similarity = Math.max(0, Math.min(1, 1 - distance));
      console.log(`[liveness] match distance=${distance.toFixed(3)} similarity=${similarity.toFixed(3)}`);
      return similarity;
    } catch (err) {
      console.error('[liveness] compare failed:', err);
      return null;
    }
  }

  // ── Crop just the face from an image (for the pass card) ──────
  // Returns a square JPEG data URL with only the face — no text from
  // the ID is visible. Padding adds headroom for hair/chin.
  async function cropFaceFromImage(dataUrl, sizePx = 360) {
    if (!await ensureModels()) return dataUrl;
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });

      const det = await faceapi
        .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.4 }))
        .withFaceLandmarks();

      if (!det) {
        console.warn('[liveness] no face to crop');
        return dataUrl;
      }

      const box = det.detection.box;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      // Square crop with 60% padding around the face
      const half = Math.max(box.width, box.height) * 0.85;
      let sx = Math.max(0, cx - half);
      let sy = Math.max(0, cy - half);
      let sw = Math.min(img.width  - sx, half * 2);
      let sh = Math.min(img.height - sy, half * 2);
      const side = Math.min(sw, sh);
      sw = sh = side;

      const c = document.createElement('canvas');
      c.width = sizePx;
      c.height = sizePx;
      c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sizePx, sizePx);
      return c.toDataURL('image/jpeg', 0.9);
    } catch (err) {
      console.error('[liveness] face crop failed:', err);
      return dataUrl;
    }
  }

  global.MapleproofLiveness = {
    runLivenessChallenge,
    compareDescriptorToImage,
    cropFaceFromImage,
    ensureModels,
    CHALLENGES
  };

})(typeof window !== 'undefined' ? window : globalThis);
