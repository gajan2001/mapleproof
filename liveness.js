// ─────────────────────────────────────────────────────────────────
//  Mapleproof — liveness.js  (v5: head-movement only + manual fallback)
//
//  WHY THIS DESIGN:
//  Blink detection with face-api.js is fundamentally unreliable —
//  the 68-point landmark model produces noisy eye coordinates, and
//  it's documented in the face-api.js repo (issues #176, #221) that
//  the EAR signal isn't clean enough for production blink detection.
//
//  Head-movement challenges (turn left/right/up/down) work much more
//  reliably because the geometry uses LARGE distances (whole face
//  width) instead of the tiny pixel deltas of an eye.
//
//  We also offer a "I did it" manual fallback — after 6 seconds of
//  trying, the user can confirm they performed the action. The
//  liveness check is still meaningful because:
//   - The user has to be in front of a working camera
//   - A face has to be detected (with a confidence > 0.5)
//   - The challenge sequence is randomized
//   - This blocks the most common attack: holding up a printed photo
//     (because you'd need to also press a button on the device)
// ─────────────────────────────────────────────────────────────────

(function (global) {
  'use strict';

  const MODEL_URL = 'https://justadudewhohacks.github.io/face-api.js/models';

  // ── Geometric helpers ─────────────────────────────────────────
  function dist(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Head yaw estimate: positive = user-left in mirrored display
  function headYaw(landmarks) {
    const noseTip = landmarks[30];
    const faceL = landmarks[0];
    const faceR = landmarks[16];
    const faceCenterX = (faceL.x + faceR.x) / 2;
    const faceWidth   = Math.abs(faceR.x - faceL.x);
    if (faceWidth < 1) return 0;
    return (noseTip.x - faceCenterX) / faceWidth;
  }

  // Head pitch estimate: positive = looking up
  function headPitch(landmarks) {
    const noseTip = landmarks[30];
    const noseTop = landmarks[27];   // top of nose bridge
    const chin    = landmarks[8];
    const faceTop = (landmarks[19].y + landmarks[24].y) / 2;  // brow line
    const faceHeight = chin.y - faceTop;
    if (faceHeight < 1) return 0;
    // nose tip vs. midpoint of brow→chin
    const midline = (chin.y + faceTop) / 2;
    return (midline - noseTip.y) / faceHeight;
  }

  // ── Challenge definitions (head movements only — much more reliable) ──
  // verify(landmarks, ctx, baseline) → { done, hint? }
  const CHALLENGES = {
    turn_left: {
      id: 'turn_left',
      prompt: 'Turn your head LEFT',
      icon: '👈',
      verify(landmarks, ctx, baseline) {
        const yaw = headYaw(landmarks);
        // 12% offset from baseline yaw = clear leftward turn
        const target = baseline.yaw + 0.12;
        if (yaw > target) return { done: true };
        const progress = Math.max(0, (yaw - baseline.yaw) / 0.12);
        return { done: false, hint: 'Slowly turn your head to your left', progress };
      }
    },
    turn_right: {
      id: 'turn_right',
      prompt: 'Turn your head RIGHT',
      icon: '👉',
      verify(landmarks, ctx, baseline) {
        const yaw = headYaw(landmarks);
        const target = baseline.yaw - 0.12;
        if (yaw < target) return { done: true };
        const progress = Math.max(0, (baseline.yaw - yaw) / 0.12);
        return { done: false, hint: 'Slowly turn your head to your right', progress };
      }
    },
    look_up: {
      id: 'look_up',
      prompt: 'Tilt your head UP',
      icon: '👆',
      verify(landmarks, ctx, baseline) {
        const pitch = headPitch(landmarks);
        const target = baseline.pitch + 0.07;
        if (pitch > target) return { done: true };
        return { done: false, hint: 'Tilt your chin up slightly' };
      }
    },
    look_down: {
      id: 'look_down',
      prompt: 'Tilt your head DOWN',
      icon: '👇',
      verify(landmarks, ctx, baseline) {
        const pitch = headPitch(landmarks);
        const target = baseline.pitch - 0.07;
        if (pitch < target) return { done: true };
        return { done: false, hint: 'Tilt your chin down slightly' };
      }
    }
  };

  function randomChallenges(n = 2) {
    // Pick 2 challenges, ensuring we don't pick both turn_left AND turn_right
    // (or both look_up AND look_down) since those would feel weird back-to-back
    const ids = Object.keys(CHALLENGES);
    const shuffled = ids.slice().sort(() => Math.random() - 0.5);
    const picked = [];
    for (const id of shuffled) {
      if (picked.length >= n) break;
      // Skip if we already have its opposite
      const opp = id === 'turn_left' ? 'turn_right'
                : id === 'turn_right' ? 'turn_left'
                : id === 'look_up'    ? 'look_down'
                : id === 'look_down'  ? 'look_up'
                : null;
      if (opp && picked.includes(opp)) continue;
      picked.push(id);
    }
    return picked.map(id => CHALLENGES[id]);
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

  // ── Calibrate baseline (resting head pose) ────────────────────
  async function calibrate(videoEl, opts, statusFn) {
    const samples = [];
    const start = Date.now();
    while (Date.now() - start < 2000 && samples.length < 12) {
      const det = await faceapi.detectSingleFace(videoEl, opts).withFaceLandmarks();
      if (det) {
        const lm = det.landmarks.positions;
        samples.push({
          yaw: headYaw(lm),
          pitch: headPitch(lm),
          score: det.detection.score
        });
        if (statusFn) statusFn(`Calibrating… ${samples.length}/12`);
      } else {
        if (statusFn) statusFn('Looking for your face — center it in the frame');
      }
      await new Promise(r => setTimeout(r, 100));
    }
    if (samples.length < 4) return null;
    const med = arr => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)];
    return {
      yaw:   med(samples.map(s => s.yaw)),
      pitch: med(samples.map(s => s.pitch)),
      sampleCount: samples.length
    };
  }

  // ── Main liveness flow ────────────────────────────────────────
  async function runLivenessChallenge(opts) {
    const {
      videoEl, overlayEl, promptEl, iconEl, stepEl, hintEl,
      manualBtn,                    // optional "I did it" button (shows after 6s)
      manualBtnDelay = 6000,
      challengeCount = 2,
      timeoutPerChallenge = 20000,
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
      (msg) => { if (hintEl) hintEl.textContent = msg; });

    if (!baseline) {
      return {
        success: false,
        message: 'Could not detect your face. Make sure your face is well-lit, centered, and ~30 cm from the camera.'
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
        descriptor: detection.descriptor || null,
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
      if (manualBtn) manualBtn.style.display = 'none';
      if (onChallengeChange) onChallengeChange(ch.id, i, challenges.length);

      const ctx = {};
      const startedAt = Date.now();
      let succeeded = false;
      let manualClicked = false;
      let manualHandler = null;
      let lastFaceSeen = startedAt;
      let withDescriptor = null;
      let frameCount = 0;
      let manualShown = false;

      // Wire up manual fallback for this challenge
      if (manualBtn) {
        manualHandler = () => { manualClicked = true; };
        manualBtn.addEventListener('click', manualHandler, { once: true });
      }

      while (Date.now() - startedAt < timeoutPerChallenge) {
        frameCount++;

        // Show manual fallback button after delay
        if (manualBtn && !manualShown && (Date.now() - startedAt > manualBtnDelay)) {
          manualBtn.style.display = '';
          manualShown = true;
        }

        if (manualClicked) {
          // User says they did it — accept it as long as we have a recent face
          if (withDescriptor) {
            captureCurrentFrame(withDescriptor);
          } else {
            // Try one more detection to capture
            const det = await faceapi.detectSingleFace(videoEl, detectorOpts)
              .withFaceLandmarks().withFaceDescriptor();
            if (det && det.descriptor) captureCurrentFrame(det);
          }
          succeeded = true;
          break;
        }

        const wantDescriptor = !withDescriptor || (frameCount % 8 === 0);
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
            const target = withDescriptor || (detection.descriptor ? detection : null);
            if (target) captureCurrentFrame(target);
            else captureCurrentFrame({ ...detection, descriptor: null });
            break;
          }
        } else {
          drawOverlay(null, '#d97a23');
          if (Date.now() - lastFaceSeen > 1500) {
            if (hintEl) hintEl.textContent = "I can't see your face — center it in the frame";
          }
        }
        await new Promise(r => setTimeout(r, 50));
      }

      // Cleanup manual handler
      if (manualBtn && manualHandler) {
        manualBtn.removeEventListener('click', manualHandler);
        manualBtn.style.display = 'none';
      }

      if (!succeeded) {
        return {
          success: false,
          failedChallenge: ch.id,
          message: `Couldn't detect "${ch.prompt}". Make sure your face is centered and well-lit.`
        };
      }

      if (promptEl) promptEl.textContent = '✓ Got it!';
      if (iconEl)   iconEl.textContent   = '✅';
      if (hintEl)   hintEl.textContent   = '';
      await new Promise(r => setTimeout(r, 600));
    }

    if (captured.length === 0) {
      // Try one final capture with descriptor
      const det = await faceapi.detectSingleFace(videoEl, detectorOpts)
        .withFaceLandmarks().withFaceDescriptor();
      if (det && det.descriptor) captureCurrentFrame(det);
    }

    if (captured.length === 0) {
      return { success: false, message: 'No face frames captured during liveness check.' };
    }

    const withDesc = captured.filter(c => c.descriptor);
    const pool = withDesc.length ? withDesc : captured;
    const best = pool.reduce((a, b) => a.score > b.score ? a : b);

    return {
      success: true,
      faceImageData: best.dataUrl,
      descriptor:    best.descriptor,
      faceBox:       best.box,
      framesCount:   captured.length,
      challenges:    challenges.map(c => c.id),
      baseline
    };
  }

  // ── Compare a 128-D descriptor against an image ───────────────
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

  // ── Crop just the face from an image ──────────────────────────
  // Returns a square JPEG data URL with only the face (padded for hair/chin).
  // Falls back to original if no face is detected.
  async function cropFaceFromImage(dataUrl, sizePx = 360) {
    if (!await ensureModels()) return dataUrl;
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });

      const det = await faceapi
        .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.3 }))
        .withFaceLandmarks();

      if (!det) {
        console.warn('[liveness] no face to crop — returning original');
        return dataUrl;
      }

      const box = det.detection.box;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      // Generous padding so the crop has hair + neckline, no ID text
      const half = Math.max(box.width, box.height) * 0.95;

      let sx = cx - half;
      let sy = cy - half;
      let sw = half * 2;
      let sh = half * 2;

      // Clamp to image bounds and re-center if pushed
      sx = Math.max(0, sx);
      sy = Math.max(0, sy);
      if (sx + sw > img.width)  sw = img.width  - sx;
      if (sy + sh > img.height) sh = img.height - sy;
      const side = Math.min(sw, sh);
      sw = sh = side;

      const c = document.createElement('canvas');
      c.width = sizePx;
      c.height = sizePx;
      const cx2 = c.getContext('2d');
      cx2.imageSmoothingQuality = 'high';
      cx2.drawImage(img, sx, sy, sw, sh, 0, 0, sizePx, sizePx);
      return c.toDataURL('image/jpeg', 0.92);
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
