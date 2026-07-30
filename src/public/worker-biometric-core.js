'use strict';

(() => {
  const HUMAN_SCRIPT_PATH = '/public/vendor/human/human.js';
  const HUMAN_MODEL_PATH = '/public/vendor/human/models/';
  const MODEL_VERSION = 'human-3.3.6-faceres';
  const MIN_REAL_SCORE = 0.55;
  const MIN_LIVE_SCORE = 0.55;
  const DETECTION_INTERVAL_MS = 160;
  const CAPTURE_TIMEOUT_MS = 30_000;
  const VERIFICATION_SAMPLES = 3;
  const reviewRequiredKeys = new Set();
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
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', () => reject(new Error('biometric_runtime_unavailable')), { once: true });
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
      debug: false,
      async: true,
      warmup: 'face',
      filter: { enabled: true, autoBrightness: true, flip: false },
      gesture: { enabled: false },
      face: {
        enabled: true,
        detector: {
          enabled: true,
          modelPath: 'blazeface.json',
          rotation: true,
          maxDetected: 2,
          minConfidence: 0.55,
          minSize: 120,
          skipFrames: 0,
          skipTime: 0
        },
        mesh: { enabled: true, modelPath: 'facemesh.json' },
        iris: { enabled: true, modelPath: 'iris.json' },
        description: {
          enabled: true,
          modelPath: 'faceres.json',
          minConfidence: 0.45,
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
    return human;
  }

  async function humanInstance() {
    if (humanPromise) return humanPromise;
    humanPromise = (async () => {
      await loadHumanScript();
      if (!window.Human?.Human) throw new Error('biometric_runtime_unavailable');
      try {
        return await createHuman('webgl');
      } catch {
        return createHuman('cpu');
      }
    })().catch((error) => {
      humanPromise = null;
      throw error;
    });
    return humanPromise;
  }

  function faceQuality(face, video) {
    if (!face || !video?.videoWidth || !video?.videoHeight) return { valid: false, message: 'Ubica tu rostro frente a la cámara.' };
    const [x, y, width, height] = face.box || [0, 0, 0, 0];
    const centerX = x + width / 2;
    const centerY = y + height / 2;
    const horizontalOffset = Math.abs(centerX - video.videoWidth / 2) / video.videoWidth;
    const verticalOffset = Math.abs(centerY - video.videoHeight / 2) / video.videoHeight;
    const faceRatio = Math.min(width / video.videoWidth, height / video.videoHeight);
    if (faceRatio < 0.22) return { valid: false, message: 'Acerca un poco el rostro.' };
    if (faceRatio > 0.82) return { valid: false, message: 'Aleja un poco el rostro.' };
    if (horizontalOffset > 0.2 || verticalOffset > 0.22) return { valid: false, message: 'Centra el rostro dentro del marco.' };
    if (Number(face.score || face.faceScore || 0) < 0.55) return { valid: false, message: 'Busca mejor iluminación.' };
    return { valid: true, faceRatio };
  }

  function frontFacing(face) {
    const angle = face?.rotation?.angle;
    if (!angle) return true;
    return Math.abs(Number(angle.yaw || 0)) < 0.22 && Math.abs(Number(angle.pitch || 0)) < 0.24;
  }

  function turnedSide(face) {
    const angle = face?.rotation?.angle;
    return Boolean(angle && Math.abs(Number(angle.yaw || 0)) >= 0.22);
  }

  function normalizeDescriptor(descriptor) {
    if (!Array.isArray(descriptor) || descriptor.length < 64) throw new Error('biometric_descriptor_unavailable');
    const values = descriptor.map((entry) => Number(entry));
    if (values.some((value) => !Number.isFinite(value))) throw new Error('biometric_descriptor_unavailable');
    return values;
  }

  function normalizeVector(vector) {
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(norm) || norm === 0) return vector;
    return vector.map((value) => value / norm);
  }

  function averageDescriptors(descriptors) {
    const length = descriptors[0]?.length || 0;
    if (!length || descriptors.some((descriptor) => descriptor.length !== length)) throw new Error('biometric_descriptor_inconsistent');
    const average = Array.from({ length }, (_, index) => descriptors.reduce((sum, descriptor) => sum + descriptor[index], 0) / descriptors.length);
    return normalizeVector(average).map((value) => Math.round(value * 1_000_000) / 1_000_000);
  }

  function capturePhoto(video, quality = 0.84) {
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 720 / (video.videoWidth || 720));
    canvas.width = Math.round((video.videoWidth || 720) * scale);
    canvas.height = Math.round((video.videoHeight || 960) * scale);
    const context = canvas.getContext('2d', { alpha: false });
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('biometric_photo_failed')), 'image/jpeg', quality);
    });
  }

  async function detectOneFace(human, video, statusCallback) {
    const result = await human.detect(video);
    const faces = Array.isArray(result?.face) ? result.face : [];
    if (faces.length !== 1) {
      statusCallback?.(faces.length > 1 ? 'Solo debe aparecer una persona.' : 'Ubica tu rostro dentro del marco.');
      return null;
    }
    const face = faces[0];
    const quality = faceQuality(face, video);
    if (!quality.valid) {
      statusCallback?.(quality.message);
      return null;
    }
    return { face, quality };
  }

  function biometricScores(face) {
    return {
      realScore: Number.isFinite(Number(face.real)) ? Number(face.real) : 0,
      liveScore: Number.isFinite(Number(face.live)) ? Number(face.live) : 0
    };
  }

  async function waitForStableFront(human, video, statusCallback, timeoutAt, samplesRequired = 2) {
    let stable = 0;
    let latest = null;
    while (Date.now() < timeoutAt) {
      const detected = await detectOneFace(human, video, statusCallback);
      if (detected && frontFacing(detected.face)) {
        const scores = biometricScores(detected.face);
        if (scores.realScore >= MIN_REAL_SCORE && scores.liveScore >= MIN_LIVE_SCORE && detected.face.embedding) {
          stable += 1;
          latest = detected;
          statusCallback?.('Mantén el rostro quieto.');
          if (stable >= samplesRequired) return latest;
        } else {
          stable = 0;
          statusCallback?.('Busca buena luz y mira de frente.');
        }
      } else {
        stable = 0;
        if (detected) statusCallback?.('Mira de frente.');
      }
      await sleep(DETECTION_INTERVAL_MS);
    }
    throw new Error('biometric_capture_timeout');
  }

  async function captureEnrollment(options = {}) {
    const video = options.video;
    const statusCallback = options.onStatus;
    const human = await humanInstance();
    const timeoutAt = Date.now() + (options.timeoutMs || CAPTURE_TIMEOUT_MS);
    const descriptors = [];
    const scores = [];
    statusCallback?.('Mira de frente y mantén el rostro dentro del marco.');
    while (descriptors.length < 3 && Date.now() < timeoutAt) {
      const detected = await waitForStableFront(human, video, statusCallback, timeoutAt, 2);
      descriptors.push(normalizeDescriptor(detected.face.embedding));
      scores.push(biometricScores(detected.face));
      statusCallback?.(`Captura ${descriptors.length} de 3 lista.`);
      await sleep(350);
    }
    if (descriptors.length < 3) throw new Error('biometric_capture_timeout');
    const photoBlob = await capturePhoto(video);
    return {
      descriptor: averageDescriptors(descriptors),
      realScore: Math.min(...scores.map((item) => item.realScore)),
      liveScore: Math.min(...scores.map((item) => item.liveScore)),
      modelVersion: MODEL_VERSION,
      photoBlob
    };
  }

  async function captureVerification(options = {}) {
    const video = options.video;
    const challenge = options.challenge || {};
    const statusCallback = options.onStatus;
    const human = await humanInstance();
    const timeoutAt = Date.now() + (options.timeoutMs || CAPTURE_TIMEOUT_MS);
    const baseline = await waitForStableFront(human, video, statusCallback, timeoutAt, 2);
    const baselineRatio = baseline.quality.faceRatio;
    const closerTarget = Math.min(0.72, baselineRatio + 0.08);
    let completed = false;
    if (challenge.action === 'TURN_SIDE') statusCallback?.('Gira el rostro hacia un lado.');
    else statusCallback?.('Acerca el rostro a la cámara.');

    while (Date.now() < timeoutAt && !completed) {
      const detected = await detectOneFace(human, video, statusCallback);
      if (detected) {
        completed = challenge.action === 'TURN_SIDE'
          ? turnedSide(detected.face)
          : detected.quality.faceRatio >= closerTarget;
      }
      if (!completed) await sleep(DETECTION_INTERVAL_MS);
    }
    if (!completed) throw new Error('biometric_challenge_not_completed');

    statusCallback?.('Listo. Vuelve a mirar de frente.');
    const descriptors = [];
    const scores = [];
    while (descriptors.length < VERIFICATION_SAMPLES && Date.now() < timeoutAt) {
      const detected = await waitForStableFront(human, video, statusCallback, timeoutAt, 2);
      descriptors.push(normalizeDescriptor(detected.face.embedding));
      scores.push(biometricScores(detected.face));
      statusCallback?.(`Verificando identidad · captura ${descriptors.length} de ${VERIFICATION_SAMPLES}.`);
      if (descriptors.length < VERIFICATION_SAMPLES) await sleep(220);
    }
    if (descriptors.length < VERIFICATION_SAMPLES) throw new Error('biometric_capture_timeout');

    const photoBlob = await capturePhoto(video);
    return {
      descriptor: averageDescriptors(descriptors),
      realScore: Math.min(...scores.map((item) => item.realScore)),
      liveScore: Math.min(...scores.map((item) => item.liveScore)),
      challengeAction: challenge.action,
      challengeCompleted: true,
      modelVersion: MODEL_VERSION,
      photoBlob
    };
  }

  async function startCamera(video) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('camera_unavailable');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 960 } },
      audio: false
    });
    video.srcObject = stream;
    video.hidden = false;
    await video.play();
    return stream;
  }

  function installPortalResponseGuard() {
    if (!window.location.pathname.startsWith('/operaciones/portal') || window.__lorrenBiometricFetchGuard) return;
    window.__lorrenBiometricFetchGuard = true;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      const response = await originalFetch(input, init);

      if (url.includes('/biometria/verificar') && typeof init.body === 'string') {
        try {
          const requestPayload = JSON.parse(init.body);
          const responsePayload = await response.clone().json();
          if (responsePayload?.requiresReview && requestPayload?.idempotencyKey) {
            reviewRequiredKeys.add(String(requestPayload.idempotencyKey));
          }
        } catch {
          // La ruta original conserva el manejo de error.
        }
        return response;
      }

      if (/\/operaciones\/portal\/asignaciones\/[^/]+\/(llegada|salida)$/.test(url) && init.body instanceof FormData) {
        const key = String(init.body.get('idempotencyKey') || '');
        if (key && reviewRequiredKeys.has(key) && response.ok) {
          try {
            const payload = await response.clone().json();
            reviewRequiredKeys.delete(key);
            const headers = new Headers(response.headers);
            headers.set('Content-Type', 'application/json; charset=utf-8');
            return new Response(JSON.stringify({
              ...payload,
              requiresReview: true,
              message: 'Marcación registrada y enviada para revisión.'
            }), { status: response.status, statusText: response.statusText, headers });
          } catch {
            return response;
          }
        }
      }
      return response;
    };
  }

  installPortalResponseGuard();

  window.LorrenWorkerBiometric = Object.freeze({
    MODEL_VERSION,
    startCamera,
    captureEnrollment,
    captureVerification,
    humanFaceSimilarity: (left, right) => {
      if (!window.Human?.match?.similarity) return null;
      return window.Human.match.similarity(left, right);
    }
  });
})();
