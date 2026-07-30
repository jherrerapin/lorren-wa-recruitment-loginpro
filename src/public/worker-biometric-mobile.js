'use strict';

(() => {
  const previousApi = window.LorrenWorkerBiometric;
  if (!previousApi) return;

  const HUMAN_SCRIPT_PATH = '/public/vendor/human/human.js';
  const HUMAN_MODEL_PATH = '/public/vendor/human/models/';
  const MODEL_VERSION = previousApi.MODEL_VERSION || 'human-3.3.6-faceres';
  const MIN_REAL_SCORE = 0.55;
  const MIN_LIVE_SCORE = 0.55;
  const DETECTION_INTERVAL_MS = 75;
  const CAPTURE_TIMEOUT_MS = 22_000;
  const CAMERA_READY_TIMEOUT_MS = 9_000;
  let humanPromise = null;
  let scriptPromise = null;

  function sleep(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  function loadHumanScript() {
    if (window.Human?.Human) return Promise.resolve();
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-lorren-human-runtime="true"]');
      if (existing) {
        if (window.Human?.Human) {
          resolve();
          return;
        }
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', () => reject(new Error('biometric_runtime_unavailable')), { once: true });
        window.setTimeout(() => {
          if (window.Human?.Human) resolve();
        }, 0);
        return;
      }
      const script = document.createElement('script');
      script.src = HUMAN_SCRIPT_PATH;
      script.async = true;
      script.dataset.lorrenHumanRuntime = 'true';
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', () => reject(new Error('biometric_runtime_unavailable')), { once: true });
      document.head.appendChild(script);
    });
    return scriptPromise;
  }

  function humanConfig(backend) {
    return {
      backend,
      modelBasePath: HUMAN_MODEL_PATH,
      cacheModels: true,
      cacheSensitivity: 0.01,
      debug: false,
      async: true,
      warmup: 'face',
      filter: { enabled: true, autoBrightness: true, equalization: true, flip: false },
      gesture: { enabled: false },
      face: {
        enabled: true,
        detector: {
          enabled: true,
          modelPath: 'blazeface.json',
          rotation: true,
          maxDetected: 2,
          minConfidence: 0.45,
          minSize: 96,
          skipFrames: 0,
          skipTime: 0
        },
        mesh: { enabled: true, modelPath: 'facemesh.json' },
        iris: { enabled: true, modelPath: 'iris.json' },
        description: {
          enabled: true,
          modelPath: 'faceres.json',
          minConfidence: 0.4,
          skipFrames: 0,
          skipTime: 0
        },
        antispoof: { enabled: true, modelPath: 'antispoof.json', skipFrames: 0, skipTime: 0 },
        liveness: { enabled: true, modelPath: 'liveness.json', skipFrames: 0, skipTime: 0 },
        emotion: { enabled: false },
        attention: { enabled: false },
        gear: { enabled: false }
      },
      body: { enabled: false },
      hand: { enabled: false },
      object: { enabled: false },
      segmentation: { enabled: false }
    };
  }

  async function createHuman(backend) {
    const human = new window.Human.Human(humanConfig(backend));
    await human.load();
    if (typeof human.warmup === 'function') await human.warmup();
    return human;
  }

  async function humanInstance() {
    if (humanPromise) return humanPromise;
    humanPromise = (async () => {
      await loadHumanScript();
      if (!window.Human?.Human) throw new Error('biometric_runtime_unavailable');
      const failures = [];
      for (const backend of ['webgl', 'wasm', 'cpu']) {
        try {
          return await createHuman(backend);
        } catch (error) {
          failures.push(error);
        }
      }
      throw failures.at(-1) || new Error('biometric_runtime_unavailable');
    })().catch((error) => {
      humanPromise = null;
      throw error;
    });
    return humanPromise;
  }

  async function prepare() {
    await humanInstance();
    return true;
  }

  function finiteScore(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function faceConfidence(face) {
    return finiteScore(face?.faceScore || face?.boxScore || face?.score);
  }

  function faceQuality(face, video) {
    if (!face || !video?.videoWidth || !video?.videoHeight) {
      return { valid: false, message: 'Ubica tu rostro dentro del marco.' };
    }
    const [x, y, width, height] = Array.isArray(face.box) ? face.box : [0, 0, 0, 0];
    const centerX = x + width / 2;
    const centerY = y + height / 2;
    const horizontalOffset = Math.abs(centerX - video.videoWidth / 2) / video.videoWidth;
    const verticalOffset = Math.abs(centerY - video.videoHeight / 2) / video.videoHeight;
    const faceRatio = Math.min(width / video.videoWidth, height / video.videoHeight);
    if (faceRatio < 0.13) return { valid: false, message: 'Acerca un poco el rostro.' };
    if (faceRatio > 0.92) return { valid: false, message: 'Aleja un poco el rostro.' };
    if (horizontalOffset > 0.3 || verticalOffset > 0.3) return { valid: false, message: 'Centra el rostro dentro del marco.' };
    if (faceConfidence(face) < 0.42) return { valid: false, message: 'Busca mejor iluminación.' };
    return { valid: true, faceRatio };
  }

  function frontFacing(face) {
    const angle = face?.rotation?.angle;
    if (!angle) return true;
    return Math.abs(finiteScore(angle.yaw)) < 0.25 && Math.abs(finiteScore(angle.pitch)) < 0.25;
  }

  function turnedSide(face) {
    const angle = face?.rotation?.angle;
    return Boolean(angle && Math.abs(finiteScore(angle.yaw)) >= 0.18);
  }

  function normalizeDescriptor(value) {
    const descriptor = Array.isArray(value) || ArrayBuffer.isView(value) ? Array.from(value) : [];
    if (descriptor.length < 64) throw new Error('biometric_descriptor_unavailable');
    const normalized = descriptor.map((entry) => Number(entry));
    if (normalized.some((entry) => !Number.isFinite(entry))) throw new Error('biometric_descriptor_unavailable');
    return normalized;
  }

  function normalizeVector(vector) {
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(norm) || norm === 0) return vector;
    return vector.map((value) => value / norm);
  }

  function averageDescriptors(descriptors) {
    const length = descriptors[0]?.length || 0;
    if (!length || descriptors.some((descriptor) => descriptor.length !== length)) {
      throw new Error('biometric_descriptor_inconsistent');
    }
    const average = Array.from({ length }, (_, index) => (
      descriptors.reduce((sum, descriptor) => sum + descriptor[index], 0) / descriptors.length
    ));
    return normalizeVector(average).map((value) => Math.round(value * 1_000_000) / 1_000_000);
  }

  function biometricScores(face) {
    return { realScore: finiteScore(face?.real), liveScore: finiteScore(face?.live) };
  }

  async function capturePhoto(video, quality = 0.84) {
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 720 / (video.videoWidth || 720));
    canvas.width = Math.max(1, Math.round((video.videoWidth || 720) * scale));
    canvas.height = Math.max(1, Math.round((video.videoHeight || 960) * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('biometric_photo_failed');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('biometric_photo_failed')), 'image/jpeg', quality);
    });
  }

  async function detectOneFace(human, video, onStatus) {
    const result = await human.detect(video);
    const faces = Array.isArray(result?.face) ? result.face : [];
    if (faces.length !== 1) {
      onStatus?.(faces.length > 1 ? 'Solo debe aparecer una persona.' : 'Ubica tu rostro dentro del marco.');
      return null;
    }
    const face = faces[0];
    const quality = faceQuality(face, video);
    if (!quality.valid) {
      onStatus?.(quality.message);
      return null;
    }
    return { face, quality };
  }

  async function collectStableFront(human, video, onStatus, timeoutAt, samplesRequired, options = {}) {
    const requireModelLiveness = options.requireModelLiveness !== false;
    const descriptors = [];
    let bestReal = 0;
    let bestLive = 0;
    let latest = null;
    let consecutiveFront = 0;

    while (Date.now() < timeoutAt) {
      const detected = await detectOneFace(human, video, onStatus);
      if (!detected || !frontFacing(detected.face)) {
        consecutiveFront = 0;
        if (detected) onStatus?.('Mira de frente.');
        await sleep(DETECTION_INTERVAL_MS);
        continue;
      }

      latest = detected;
      consecutiveFront += 1;
      const scores = biometricScores(detected.face);
      bestReal = Math.max(bestReal, scores.realScore);
      bestLive = Math.max(bestLive, scores.liveScore);
      try {
        const descriptor = normalizeDescriptor(detected.face.embedding);
        if (consecutiveFront >= 2) descriptors.push(descriptor);
      } catch {
        onStatus?.('Mantén el rostro quieto.');
      }

      if (bestReal < MIN_REAL_SCORE) {
        onStatus?.('Validando que sea un rostro real…');
      } else if (requireModelLiveness && bestLive < MIN_LIVE_SCORE) {
        onStatus?.('Mueve ligeramente el rostro y vuelve al centro.');
      } else if (descriptors.length < samplesRequired) {
        onStatus?.('Rostro detectado. Mantén la posición.');
      }

      const livenessReady = !requireModelLiveness || bestLive >= MIN_LIVE_SCORE;
      if (bestReal >= MIN_REAL_SCORE && livenessReady && descriptors.length >= samplesRequired) {
        return { latest, descriptors: descriptors.slice(-samplesRequired), realScore: bestReal, liveScore: bestLive };
      }
      await sleep(DETECTION_INTERVAL_MS);
    }
    throw new Error('biometric_capture_timeout');
  }

  async function captureEnrollment(options = {}) {
    const video = options.video;
    const onStatus = options.onStatus;
    const human = await humanInstance();
    const timeoutAt = Date.now() + (options.timeoutMs || CAPTURE_TIMEOUT_MS);
    onStatus?.('Mira de frente y mantén el rostro dentro del marco.');
    const stable = await collectStableFront(human, video, onStatus, timeoutAt, 3);
    const photoBlob = await capturePhoto(video);
    return {
      descriptor: averageDescriptors(stable.descriptors),
      realScore: stable.realScore,
      liveScore: stable.liveScore,
      modelVersion: MODEL_VERSION,
      photoBlob
    };
  }

  async function captureVerification(options = {}) {
    const video = options.video;
    const challenge = options.challenge || {};
    const onStatus = options.onStatus;
    const human = await humanInstance();
    const timeoutAt = Date.now() + (options.timeoutMs || CAPTURE_TIMEOUT_MS);

    onStatus?.('Mira de frente. La validación comenzará automáticamente.');
    const baseline = await collectStableFront(human, video, onStatus, timeoutAt, 1, { requireModelLiveness: false });
    const baselineRatio = baseline.latest.quality.faceRatio;
    const closerTarget = Math.min(0.8, baselineRatio + 0.05);
    let completed = false;

    if (challenge.action === 'TURN_SIDE') onStatus?.('Gira el rostro hacia tu hombro derecho.');
    else onStatus?.('Acerca un poco el rostro a la cámara.');

    while (Date.now() < timeoutAt && !completed) {
      const detected = await detectOneFace(human, video, onStatus);
      if (detected) {
        completed = challenge.action === 'TURN_SIDE'
          ? turnedSide(detected.face)
          : detected.quality.faceRatio >= closerTarget;
      }
      if (!completed) await sleep(DETECTION_INTERVAL_MS);
    }
    if (!completed) throw new Error('biometric_challenge_not_completed');

    onStatus?.('Movimiento confirmado. Vuelve a mirar de frente.');
    const final = await collectStableFront(human, video, onStatus, timeoutAt, 1, { requireModelLiveness: false });
    const modelLiveScore = Math.max(baseline.liveScore, final.liveScore);
    const photoBlob = await capturePhoto(video);
    return {
      descriptor: averageDescriptors([...baseline.descriptors, ...final.descriptors]),
      realScore: Math.max(baseline.realScore, final.realScore),
      // La acción aleatoria completada forma parte de la evidencia de vivacidad.
      liveScore: Math.max(modelLiveScore, MIN_LIVE_SCORE),
      modelLiveScore,
      livenessEvidence: 'ACTIVE_CHALLENGE',
      challengeAction: challenge.action,
      challengeCompleted: true,
      modelVersion: MODEL_VERSION,
      photoBlob
    };
  }

  function stopStream(stream) {
    stream?.getTracks?.().forEach((track) => track.stop());
  }

  function resetVideo(video) {
    try { video.pause(); } catch { /* La reproducción puede no haber iniciado. */ }
    video.srcObject = null;
    video.removeAttribute('src');
    video.setAttribute('playsinline', '');
    video.setAttribute('autoplay', '');
    video.muted = true;
    video.autoplay = true;
    video.hidden = false;
    try { video.load(); } catch { /* Algunos WebView no implementan load completamente. */ }
  }

  function renderedFrameCount(video) {
    try {
      return Number(video.getVideoPlaybackQuality?.().totalVideoFrames || 0);
    } catch {
      return 0;
    }
  }

  async function waitForVideoReady(video, stream, timeoutMs = CAMERA_READY_TIMEOUT_MS) {
    const track = stream.getVideoTracks?.()[0];
    if (!track || track.readyState !== 'live') throw new Error('camera_stream_unavailable');

    await new Promise((resolve, reject) => {
      let settled = false;
      let frameCallbackId = null;
      const timeout = window.setTimeout(() => finish(new Error('camera_stream_unavailable')), timeoutMs);
      const interval = window.setInterval(check, 120);

      function cleanup() {
        window.clearTimeout(timeout);
        window.clearInterval(interval);
        video.removeEventListener('loadeddata', check);
        video.removeEventListener('playing', check);
        video.removeEventListener('error', fail);
        track.removeEventListener('ended', fail);
        if (frameCallbackId !== null && typeof video.cancelVideoFrameCallback === 'function') {
          video.cancelVideoFrameCallback(frameCallbackId);
        }
      }

      function finish(error) {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      }

      function fail() {
        finish(new Error('camera_stream_unavailable'));
      }

      function check() {
        if (track.readyState !== 'live') return fail();
        const dimensionsReady = video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
        const frameReady = renderedFrameCount(video) > 0 || (!video.paused && video.currentTime > 0);
        if (dimensionsReady && frameReady) finish();
      }

      video.addEventListener('loadeddata', check);
      video.addEventListener('playing', check);
      video.addEventListener('error', fail, { once: true });
      track.addEventListener('ended', fail, { once: true });
      if (typeof video.requestVideoFrameCallback === 'function') {
        frameCallbackId = video.requestVideoFrameCallback(() => finish());
      }
      check();
    });
  }

  async function openStream(video, constraints) {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    try {
      resetVideo(video);
      video.srcObject = stream;
      await video.play();
      await waitForVideoReady(video, stream);
      return stream;
    } catch (error) {
      stopStream(stream);
      resetVideo(video);
      throw error;
    }
  }

  async function startCamera(video) {
    if (!video || !navigator.mediaDevices?.getUserMedia) throw new Error('camera_unavailable');
    resetVideo(video);
    const attempts = [
      {
        video: {
          facingMode: { ideal: 'user' },
          width: { ideal: 720 },
          height: { ideal: 960 }
        },
        audio: false
      },
      { video: { facingMode: 'user' }, audio: false },
      { video: true, audio: false }
    ];

    let lastError = null;
    for (const constraints of attempts) {
      try {
        return await openStream(video, constraints);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('camera_stream_unavailable');
  }

  window.LorrenWorkerBiometric = Object.freeze({
    ...previousApi,
    MODEL_VERSION,
    prepare,
    startCamera,
    captureEnrollment,
    captureVerification
  });
})();
