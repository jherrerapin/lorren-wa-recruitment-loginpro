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
  const ENROLLMENT_TIMEOUT_MS = 30_000;
  const BASELINE_TIMEOUT_MS = 12_000;
  const CHALLENGE_TIMEOUT_MS = 9_000;
  const FINAL_TIMEOUT_MS = 12_000;
  const CAMERA_READY_TIMEOUT_MS = 10_000;
  const BACKENDS = Object.freeze(['webgl', 'wasm', 'cpu']);
  const activeStreams = new Set();

  let humanPromise = null;
  let humanInstanceValue = null;
  let scriptPromise = null;
  let backendIndex = 0;
  let runtimeGeneration = 0;
  let runtimeStale = true;
  let runtimeReason = 'initial';
  let activeDetections = 0;
  let releaseQueue = Promise.resolve();

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
      cacheSensitivity: 0,
      deallocate: true,
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

  async function releaseHuman(instance) {
    if (!instance) return;
    const waitUntil = Date.now() + 2_000;
    while (activeDetections > 0 && Date.now() < waitUntil) await sleep(50);
    const models = Object.values(instance.models || {});
    await Promise.allSettled(models.map(async (candidate) => {
      const model = await Promise.resolve(candidate).catch(() => null);
      try { model?.dispose?.(); } catch { /* El navegador puede haber descartado el backend. */ }
    }));
    try { instance.process?.tensor?.dispose?.(); } catch { /* No siempre existe tensor activo. */ }
  }

  function invalidateRuntime(reason = 'runtime-invalidated', options = {}) {
    const previous = humanInstanceValue;
    runtimeGeneration += 1;
    humanPromise = null;
    humanInstanceValue = null;
    runtimeStale = true;
    runtimeReason = String(reason || 'runtime-invalidated');
    if (options.rotateBackend === true) backendIndex = (backendIndex + 1) % BACKENDS.length;
    releaseQueue = releaseQueue.then(() => releaseHuman(previous)).catch(() => {});
    return releaseQueue;
  }

  async function humanInstance() {
    if (humanPromise && !runtimeStale) return humanPromise;
    if (document.visibilityState === 'hidden') throw new Error('biometric_page_not_visible');

    const generation = runtimeGeneration;
    const promise = (async () => {
      await loadHumanScript();
      if (!window.Human?.Human) throw new Error('biometric_runtime_unavailable');

      const failures = [];
      for (let offset = 0; offset < BACKENDS.length; offset += 1) {
        const candidateIndex = (backendIndex + offset) % BACKENDS.length;
        const backend = BACKENDS[candidateIndex];
        try {
          const human = await createHuman(backend);
          if (generation !== runtimeGeneration) {
            await releaseHuman(human);
            throw new Error('biometric_runtime_superseded');
          }
          backendIndex = candidateIndex;
          humanInstanceValue = human;
          runtimeStale = false;
          runtimeReason = null;
          return human;
        } catch (error) {
          failures.push(error);
        }
      }
      throw failures.at(-1) || new Error('biometric_runtime_unavailable');
    })();

    humanPromise = promise;
    try {
      return await promise;
    } catch (error) {
      if (humanPromise === promise) humanPromise = null;
      if (generation === runtimeGeneration) {
        humanInstanceValue = null;
        runtimeStale = true;
      }
      throw error;
    }
  }

  async function prepare() {
    const human = await humanInstance();
    return {
      ready: true,
      backend: human.tf?.getBackend?.() || human.config?.backend || BACKENDS[backendIndex]
    };
  }

  async function recover(options = {}) {
    await invalidateRuntime(options.reason || 'explicit-recovery', {
      rotateBackend: options.rotateBackend === true
    });
    return prepare();
  }

  function runtimeStatus() {
    return {
      stale: runtimeStale,
      reason: runtimeReason,
      backend: humanInstanceValue?.tf?.getBackend?.() || humanInstanceValue?.config?.backend || BACKENDS[backendIndex]
    };
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

  function requireLiveVideo(video) {
    const stream = video?.srcObject;
    const track = stream?.getVideoTracks?.()[0];
    if (
      !track
      || track.readyState !== 'live'
      || track.enabled !== true
      || track.muted === true
      || video.readyState < 2
      || video.videoWidth <= 0
      || video.videoHeight <= 0
    ) {
      throw new Error('camera_stream_unavailable');
    }
    return track;
  }

  async function detectOneFace(human, video, onStatus) {
    requireLiveVideo(video);
    let result;
    activeDetections += 1;
    try {
      result = await human.detect(video);
    } catch (cause) {
      invalidateRuntime('detect-failed');
      const error = new Error('biometric_runtime_unavailable');
      error.cause = cause;
      throw error;
    } finally {
      activeDetections = Math.max(0, activeDetections - 1);
    }
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

  async function collectStableFront(human, video, onStatus, deadline, samplesRequired, options = {}) {
    const requireModelLiveness = options.requireModelLiveness !== false;
    const timeoutError = options.timeoutError || 'biometric_capture_timeout';
    const descriptors = [];
    let bestReal = 0;
    let bestLive = 0;
    let latest = null;
    let consecutiveFront = 0;

    while (Date.now() < deadline) {
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
    throw new Error(timeoutError);
  }

  async function captureEnrollment(options = {}) {
    const video = options.video;
    const onStatus = options.onStatus;
    const human = await humanInstance();
    const deadline = Date.now() + (options.timeoutMs || ENROLLMENT_TIMEOUT_MS);
    onStatus?.('Mira de frente y mantén el rostro dentro del marco.');
    const stable = await collectStableFront(human, video, onStatus, deadline, 3, {
      timeoutError: 'biometric_enrollment_timeout'
    });
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

    onStatus?.('Mira de frente. La validación comenzará automáticamente.');
    const baselineDeadline = Date.now() + (options.baselineTimeoutMs || BASELINE_TIMEOUT_MS);
    const baseline = await collectStableFront(human, video, onStatus, baselineDeadline, 1, {
      requireModelLiveness: false,
      timeoutError: 'biometric_baseline_timeout'
    });
    const baselineRatio = baseline.latest.quality.faceRatio;
    const closerTarget = Math.min(0.8, baselineRatio + 0.05);
    const challengeDeadline = Date.now() + (options.challengeTimeoutMs || CHALLENGE_TIMEOUT_MS);
    let completed = false;

    if (challenge.action === 'TURN_SIDE') onStatus?.('Gira el rostro hacia tu hombro derecho.');
    else onStatus?.('Acerca un poco el rostro a la cámara.');

    while (Date.now() < challengeDeadline && !completed) {
      const detected = await detectOneFace(human, video, onStatus);
      if (detected) {
        completed = challenge.action === 'TURN_SIDE'
          ? turnedSide(detected.face)
          : detected.quality.faceRatio >= closerTarget;
      }
      if (!completed) await sleep(DETECTION_INTERVAL_MS);
    }
    if (!completed) throw new Error('biometric_challenge_timeout');

    onStatus?.('Movimiento confirmado. Vuelve a mirar de frente.');
    const finalDeadline = Date.now() + (options.finalTimeoutMs || FINAL_TIMEOUT_MS);
    const final = await collectStableFront(human, video, onStatus, finalDeadline, 1, {
      requireModelLiveness: false,
      timeoutError: 'biometric_final_timeout'
    });
    const modelLiveScore = Math.max(baseline.liveScore, final.liveScore);
    const photoBlob = await capturePhoto(video);
    return {
      descriptor: averageDescriptors([...baseline.descriptors, ...final.descriptors]),
      realScore: Math.max(baseline.realScore, final.realScore),
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
    activeStreams.delete(stream);
  }

  function stopAllStreams() {
    [...activeStreams].forEach(stopStream);
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

  function hasVisiblePixels(video) {
    if (!video.videoWidth || !video.videoHeight) return false;
    const canvas = document.createElement('canvas');
    canvas.width = 24;
    canvas.height = 24;
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!context) return true;
    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let visible = 0;
      for (let index = 0; index < pixels.length; index += 16) {
        if (pixels[index] > 4 || pixels[index + 1] > 4 || pixels[index + 2] > 4) visible += 1;
      }
      return visible >= 4;
    } catch {
      return false;
    }
  }

  async function waitForVideoReady(video, stream, timeoutMs = CAMERA_READY_TIMEOUT_MS) {
    const track = stream.getVideoTracks?.()[0];
    if (!track || track.readyState !== 'live' || track.enabled !== true) {
      throw new Error('camera_stream_unavailable');
    }

    await new Promise((resolve, reject) => {
      let settled = false;
      let frameCallbackId = null;
      let usefulFrames = 0;
      let lastFrameCount = -1;
      let lastCurrentTime = -1;
      const timeout = window.setTimeout(() => finish(new Error(
        track.muted ? 'camera_stream_muted' : 'camera_stream_unavailable'
      )), timeoutMs);
      const interval = window.setInterval(check, 120);

      function cleanup() {
        window.clearTimeout(timeout);
        window.clearInterval(interval);
        video.removeEventListener('loadeddata', check);
        video.removeEventListener('playing', check);
        video.removeEventListener('error', fail);
        track.removeEventListener('ended', fail);
        track.removeEventListener('mute', muted);
        track.removeEventListener('unmute', check);
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

      function muted() {
        usefulFrames = 0;
      }

      function scheduleFrameCheck() {
        if (settled || typeof video.requestVideoFrameCallback !== 'function') return;
        frameCallbackId = video.requestVideoFrameCallback(() => {
          check();
          scheduleFrameCheck();
        });
      }

      function check() {
        if (track.readyState !== 'live' || track.enabled !== true) return fail();
        if (track.muted === true) {
          usefulFrames = 0;
          return;
        }
        const dimensionsReady = video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
        const frameCount = renderedFrameCount(video);
        const progressed = frameCount > lastFrameCount || video.currentTime > lastCurrentTime;
        if (dimensionsReady && progressed && hasVisiblePixels(video)) usefulFrames += 1;
        else if (!dimensionsReady) usefulFrames = 0;
        lastFrameCount = frameCount;
        lastCurrentTime = video.currentTime;
        if (usefulFrames >= 2) finish();
      }

      video.addEventListener('loadeddata', check);
      video.addEventListener('playing', check);
      video.addEventListener('error', fail, { once: true });
      track.addEventListener('ended', fail, { once: true });
      track.addEventListener('mute', muted);
      track.addEventListener('unmute', check);
      scheduleFrameCheck();
      check();
    });
  }

  async function openStream(video, constraints) {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    activeStreams.add(stream);
    stream.getTracks?.().forEach((track) => {
      track.addEventListener('ended', () => activeStreams.delete(stream), { once: true });
    });
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
    if (document.visibilityState === 'hidden') throw new Error('biometric_page_not_visible');
    stopAllStreams();
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

  function suspendForLifecycle(reason) {
    stopAllStreams();
    invalidateRuntime(reason);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') suspendForLifecycle('document-hidden');
  }, { capture: true });
  document.addEventListener('freeze', () => suspendForLifecycle('document-frozen'), { capture: true });
  document.addEventListener('resume', () => invalidateRuntime('document-resumed'), { capture: true });
  window.addEventListener('pagehide', () => suspendForLifecycle('page-hidden'), { capture: true });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted || document.wasDiscarded) invalidateRuntime('page-restored');
  }, { capture: true });
  if (document.wasDiscarded) invalidateRuntime('page-discarded');

  window.LorrenWorkerBiometric = Object.freeze({
    ...previousApi,
    MODEL_VERSION,
    prepare,
    recover,
    invalidateRuntime,
    runtimeStatus,
    startCamera,
    captureEnrollment,
    captureVerification
  });
})();
