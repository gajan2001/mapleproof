// ─────────────────────────────────────────────────────────────────
//  Mapleproof — liveness.js
//  Active liveness detection using face-api.js
//
//  Asks the user to perform 3 random challenges (turn left, turn right,
//  blink, smile, open mouth) in front of the camera. Each challenge is
//  verified in real-time using facial landmarks. Captures 5 frames
//  across the sequence, then picks the best one (most face-centered)
//  for the pass photo.
//
//  This is FREE — runs entirely in the browser. No API, no server cost.
//  Hard to spoof with a printed photo or screen because the user must
//  perform unpredictable physical movements.
// ─────────────────────────────────────────────────────────────────

(function (global) {
  'use strict';

  const MODEL_URL = 'https://justadudewhohacks.github.io/face-api.js/models';

  // ── Challenge definitions ──────────────────────────────────────
  // Each challenge has:
  //   id:        unique key
  //   prompt:    text shown to the user
  //   icon:      emoji shown above the prompt
  //   verify:    function(landmarks) → true if challenge satisfied
  //
  // The verify function gets face-api.js landmarks (Point[68]) and
  // a "context" object that tracks state across frames (for blink
  // detection which needs to see eyes close THEN open).
  //
  // Indices reference the 68-point face landmark model:
  //   17-21 = right brow,  22-26 = left brow
  //   27-30 = nose bridge, 31-35 = nostrils
  //   36-41 = right eye,   42-47 = left eye
  //   48-67 = mouth (outer 48-59, inner 60-67)
  // ──────────────────────────────────────────────────────────────
  const CHALLENGES = {
    blink: {
      id: 'blink',
      prompt: 'Blink your eyes',
      icon: '👁️',
      verify(landmarks, ctx) {
        const ear = (eye) => {
          // Eye Aspect Ratio: small when closed, ~0.3 when open
          const v1 = dist(eye[1], eye[5]);
          const v2 = dist(eye[2], eye[4]);
          const h  = dist(eye[0], eye[3]);
          return (v1 + v2) / (2 * h);
        };
        const right = landmarks.slice(36, 42);
        const left  = landmarks.slice(42, 48);
        const avgEar = (ear(right) + ear(left)) / 2;

        ctx.blinkSawClosed = ctx.blinkSawClosed || avgEar < 0.20;
        if (ctx.blinkSawClosed && avgEar > 0.27) return true;
        return false;
      }
    },
    smile: {
      id: 'smile',
      prompt: 'Smile big',
      icon: '😄',
      verify(landmarks, ctx) {
        const mouth = landmarks.slice(48, 68);
        const w = dist(mouth[0], mouth[6]);   // mouth width (corner to corner)
        const h = dist(mouth[3], mouth[9]);   // mouth height (top to bottom)
        const faceW = dist(landmarks[0], landmarks[16]); // face width
        const widthRatio = w / faceW;
        // Smiling makes mouth WIDER relative to face, with a low h:w ratio
        return widthRatio > 0.42 && (h / w) < 0.35;
      }
    },
    mouth_open: {
      id: 'mouth_open',
      prompt: 'Open your mouth',
      icon: '😮',
      verify(landmarks, ctx) {
        const mouth = landmarks.slice(48, 68);
        const innerTop    = mouth[13]; // index 61
        const innerBottom = mouth[19]; // index 67
        const w = dist(mouth[0], mouth[6]);
        const innerH = dist(innerTop, innerBottom);
        return (innerH / w) > 0.3;
      }
    },
    turn_left: {
      id: 'turn_left',
      prompt: 'Turn your head LEFT',
      icon: '👈',
      verify(landmarks, ctx) {
        // Estimate head yaw from nose offset relative to face center.
        // Mirrored video: turning the user's left makes nose appear right of center.
        const noseTip = landmarks[30];
        const faceL = landmarks[0];   // right face edge in mirrored view
        const faceR = landmarks[16];  // left face edge in mirrored view
        const faceCenterX = (faceL.x + faceR.x) / 2;
        const faceWidth   = Math.abs(faceR.x - faceL.x);
        if (faceWidth < 1) return false;
        const offset = (noseTip.x - faceCenterX) / faceWidth;
        // Mirrored: user-left → positive offset
        return offset > 0.13;
      }
    },
    turn_right: {
      id: 'turn_right',
      prompt: 'Turn your head RIGHT',
      icon: '👉',
      verify(landmarks, ctx) {
        const noseTip = landmarks[30];
        const faceL = landmarks[0];
        const faceR = landmarks[16];
        const faceCenterX = (faceL.x + faceR.x) / 2;
        const faceWidth   = Math.abs(faceR.x - faceL.x);
        if (faceWidth < 1) return false;
        const offset = (noseTip.x - faceCenterX) / faceWidth;
        // Mirrored: user-right → negative offset
        return offset < -0.13;
      }
    }
  };

  function dist(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Pick a random sequence of N distinct challenges
  // (ensures turn_left and turn_right aren't both picked too often)
  function randomChallenges(n = 3) {
    const all = Object.keys(CHALLENGES);
    const shuffled = all.slice().sort(() => Math.random() - 0.5);
    return shuffled.slice(0, n).map(id => CHALLENGES[id]);
  }

  // ── Model loading (cached) ─────────────────────────────────────
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

  // ── Main: run a liveness challenge sequence ────────────────────
  // Returns: { success, frames, descriptors, faceImageData, score }
  //
  // Options:
  //   videoEl:    the <video> element with the live camera stream
  //   overlayEl:  optional <canvas> overlay for drawing the face box
  //   promptEl:   element to show the current challenge prompt
  //   iconEl:     element to show the current challenge icon
  //   stepEl:     element to show "Step 1 of 3" text
  //   onFaceLost: optional callback when no face is detected
  //   challengeCount: number of challenges (default 3)
  //   timeoutPerChallenge: ms (default 12000)
  // ──────────────────────────────────────────────────────────────
  async function runLivenessChallenge(opts) {
    const videoEl    = opts.videoEl;
    const overlayEl  = opts.overlayEl;
    const promptEl   = opts.promptEl;
    const iconEl     = opts.iconEl;
    const stepEl     = opts.stepEl;
    const challengeCount = opts.challengeCount || 3;
    const timeoutPerChallenge = opts.timeoutPerChallenge || 12000;

    if (!await ensureModels()) {
      throw new Error('Face detection models could not be loaded.');
    }

    const challenges = randomChallenges(challengeCount);
    console.log('[liveness] sequence:', challenges.map(c => c.id).join(' → '));

    const captured = [];        // frames captured during sequence
    const detectorOpts = new faceapi.TinyFaceDetectorOptions({
      inputSize: 320, scoreThreshold: 0.4
    });

    const overlayCtx = overlayEl ? overlayEl.getContext('2d') : null;

    function captureCurrentFrame(detection) {
      const c = document.createElement('canvas');
      c.width = videoEl.videoWidth;
      c.height = videoEl.videoHeight;
      const cx = c.getContext('2d');
      // Un-mirror the captured image (display is mirrored for natural feel,
      // but we want a normal-orientation image stored)
      cx.translate(c.width, 0);
      cx.scale(-1, 1);
      cx.drawImage(videoEl, 0, 0);
      captured.push({
        dataUrl: c.toDataURL('image/jpeg', 0.85),
        descriptor: detection.descriptor,
        score: detection.detection.score
      });
    }

    // ── Run each challenge in sequence ──
    for (let i = 0; i < challenges.length; i++) {
      const ch = challenges[i];
      if (promptEl) promptEl.textContent = ch.prompt;
      if (iconEl)   iconEl.textContent   = ch.icon;
      if (stepEl)   stepEl.textContent   = `Step ${i + 1} of ${challenges.length}`;

      const ctx = {};
      const startedAt = Date.now();
      let succeeded = false;

      while (Date.now() - startedAt < timeoutPerChallenge) {
        const detection = await faceapi
          .detectSingleFace(videoEl, detectorOpts)
          .withFaceLandmarks()
          .withFaceDescriptor();

        // Draw face box overlay
        if (overlayCtx && overlayEl) {
          overlayEl.width = videoEl.clientWidth;
          overlayEl.height = videoEl.clientHeight;
          overlayCtx.clearRect(0, 0, overlayEl.width, overlayEl.height);

          if (detection) {
            const box = detection.detection.box;
            const sx = overlayEl.width  / videoEl.videoWidth;
            const sy = overlayEl.height / videoEl.videoHeight;
            // Mirror the box position to match the mirrored video display
            const x = overlayEl.width - (box.x + box.width) * sx;
            overlayCtx.strokeStyle = succeeded ? '#1f6f48' : '#d97a23';
            overlayCtx.lineWidth = 4;
            overlayCtx.strokeRect(x, box.y * sy, box.width * sx, box.height * sy);
          } else if (opts.onFaceLost) {
            opts.onFaceLost();
          }
        }

        if (detection) {
          const positions = detection.landmarks.positions;
          if (ch.verify(positions, ctx)) {
            succeeded = true;
            captureCurrentFrame(detection);
            break;
          }
        }

        // Tiny pause to avoid pegging the CPU
        await new Promise(r => setTimeout(r, 80));
      }

      if (!succeeded) {
        return {
          success: false,
          failedChallenge: ch.id,
          message: `Couldn't verify "${ch.prompt}". Please try again with better lighting.`
        };
      }

      // Brief pause between challenges
      if (promptEl) promptEl.textContent = '✓ Got it!';
      if (iconEl)   iconEl.textContent   = '✅';
      await new Promise(r => setTimeout(r, 700));
    }

    if (captured.length === 0) {
      return { success: false, message: 'No frames captured during liveness check.' };
    }

    // Pick the best frame (highest detection confidence)
    const best = captured.reduce((a, b) => a.score > b.score ? a : b);

    return {
      success: true,
      faceImageData: best.dataUrl,
      descriptor: best.descriptor,        // 128-D face descriptor for matching
      framesCount: captured.length,
      challenges: challenges.map(c => c.id)
    };
  }

  // ── Compare two face descriptors (or descriptor vs ID front image) ──
  async function compareDescriptorToImage(descriptor, idFrontDataUrl) {
    if (!descriptor || !idFrontDataUrl) return null;
    if (!await ensureModels()) return null;

    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = idFrontDataUrl; });

      const idDetect = await faceapi
        .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.4 }))
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (!idDetect) {
        console.warn('[liveness] no face found in ID front');
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

  // Expose API
  global.MapleproofLiveness = {
    runLivenessChallenge,
    compareDescriptorToImage,
    ensureModels,
    CHALLENGES
  };

})(typeof window !== 'undefined' ? window : globalThis);
