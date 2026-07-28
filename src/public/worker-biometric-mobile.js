'use strict';

(() => {
  const previousApi = window.LorrenWorkerBiometric;
  if (!previousApi) return;

  const HUMAN_SCRIPT_PATH = '/public/vendor/human/human.js';
  const HUMAN_MODEL_PATH = '/public/vendor/human/models/';
  const MODEL_VERSION = previousApi.MODEL_VERSION || 'human-3.3.6-faceres';
  const MIN_REAL_SCORE = 0.55;
  const MIN_LIVE_SCORE = 0.55;
  const DETECTION_INTERVAL_MS = 90;
  const CAPTURE_TIMEOUT_MS = 45_000;
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
    if (faceRatio < 0.18) return { valid: false, message: 'Acerca un poco el rostro.' };
    if (faceRatio > 0.86) return { valid: false, message: 'Aleja un poco el rostro.' };
    if (horizontalOffset > 0.24 || verticalOffset > 0.26) return { valid: false, message: 'Centra el rostro dentro del marco.' };
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

  async function collectStableFront(human, video, onStatus, timeoutAt, samplesRequired) {
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
      } else if (bestLive < MIN_LIVE_SCORE) {
        onStatus?.('Mueve ligeramente el rostro y vuelve al centro.');
      } else if (descriptors.length < samplesRequired) {
        onStatus?.(`Rostro detectado · ${descriptors.length} de ${samplesRequired}`);
      }

      if (bestReal >= MIN_REAL_SCORE && bestLive >= MIN_LIVE_SCORE && descriptors.length >= samplesRequired) {
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
    const baseline = await collectStableFront(human, video, onStatus, timeoutAt, 2);
    const baselineRatio = baseline.latest.quality.faceRatio;
    const closerTarget = Math.min(0.76, baselineRatio + 0.06);
    let completed = false;

    if (challenge.action === 'TURN_SIDE') onStatus?.('Gira el rostro suavemente hacia un lado.');
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

    onStatus?.('Listo. Vuelve a mirar de frente.');
    const final = await collectStableFront(human, video, onStatus, timeoutAt, 2);
    const photoBlob = await capturePhoto(video);
    return {
      descriptor: averageDescriptors(final.descriptors),
      realScore: Math.max(baseline.realScore, final.realScore),
      liveScore: Math.max(baseline.liveScore, final.liveScore),
      challengeAction: challenge.action,
      challengeCompleted: true,
      modelVersion: MODEL_VERSION,
      photoBlob
    };
  }

  async function waitForVideoReady(video, timeoutMs = 10_000) {
    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) return;
    await new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('camera_stream_unavailable'));
      }, timeoutMs);
      const ready = () => {
        if (video.videoWidth <= 0 || video.videoHeight <= 0) return;
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error('camera_stream_unavailable'));
      };
      function cleanup() {
        window.clearTimeout(timeout);
        video.removeEventListener('loadedmetadata', ready);
        video.removeEventListener('loadeddata', ready);
        video.removeEventListener('error', failed);
      }
      video.addEventListener('loadedmetadata', ready);
      video.addEventListener('loadeddata', ready);
      video.addEventListener('error', failed);
    });
  }

  async function startCamera(video) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('camera_unavailable');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'user' },
        resizeMode: 'none',
        width: { ideal: 720 },
        height: { ideal: 960 }
      },
      audio: false
    });
    try {
      video.srcObject = stream;
      video.hidden = false;
      video.setAttribute('playsinline', '');
      video.muted = true;
      await video.play();
      await waitForVideoReady(video);
      return stream;
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      throw error;
    }
  }

  window.LorrenWorkerBiometric = Object.freeze({
    ...previousApi,
    MODEL_VERSION,
    startCamera,
    captureEnrollment,
    captureVerification
  });
})();
