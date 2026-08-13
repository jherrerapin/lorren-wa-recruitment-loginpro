import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const loader = fs.readFileSync('src/public/worker-biometric.js', 'utf8');
const bootstrap = fs.readFileSync('src/public/worker-biometric-core.js', 'utf8');
const mobile = fs.readFileSync('src/public/worker-biometric-mobile.js', 'utf8');

function validFace() {
  return {
    box: [200, 200, 320, 320],
    faceScore: 0.95,
    real: 0.9,
    live: 0.9,
    embedding: Array.from({ length: 128 }, (_, index) => (index === 0 ? 1 : 0)),
    rotation: { angle: { yaw: 0, pitch: 0 } }
  };
}

function createStableCaptureHarness({ invalidDetection = null } = {}) {
  let fakeNow = 0;
  let detectionCount = 0;
  const nativeSetTimeout = setTimeout;
  const nativeClearTimeout = clearTimeout;

  class FakeDate extends Date {
    static now() { return fakeNow; }
  }

  function controlledSetTimeout(callback, delay = 0, ...args) {
    if (Number(delay) <= 500) {
      const handle = { fake: true, cancelled: false };
      queueMicrotask(() => {
        if (handle.cancelled) return;
        fakeNow += Number(delay) || 0;
        callback(...args);
      });
      return handle;
    }
    return nativeSetTimeout(callback, delay, ...args);
  }

  function controlledClearTimeout(handle) {
    if (handle?.fake) handle.cancelled = true;
    else nativeClearTimeout(handle);
  }

  class FakeHuman {
    constructor(config) {
      this.config = config;
      this.models = {};
      this.tf = { getBackend: () => config.backend };
    }

    load() { return Promise.resolve(); }
    detect() {
      detectionCount += 1;
      return Promise.resolve({
        face: detectionCount === invalidDetection ? [] : [validFace()]
      });
    }
  }

  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => {} }),
    toBlob: (callback) => callback(new Blob(['test-photo'], { type: 'image/jpeg' }))
  };
  const document = {
    visibilityState: 'visible',
    wasDiscarded: false,
    querySelector: () => null,
    getElementById: () => null,
    createElement: (tagName) => tagName === 'canvas' ? canvas : {},
    addEventListener: () => {}
  };
  const window = {
    LorrenWorkerBiometric: Object.freeze({ MODEL_VERSION: 'human-3.3.6-faceres' }),
    Human: { Human: FakeHuman },
    navigator: { userAgent: 'Android' },
    setTimeout: controlledSetTimeout,
    clearTimeout: controlledClearTimeout,
    setInterval,
    clearInterval,
    addEventListener: () => {}
  };

  vm.runInNewContext(mobile, {
    window,
    document,
    navigator: window.navigator,
    performance: { now: () => fakeNow },
    Date: FakeDate,
    Blob,
    console,
    setTimeout: controlledSetTimeout,
    clearTimeout: controlledClearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask
  });

  const track = { readyState: 'live', enabled: true, muted: false };
  const video = {
    srcObject: { getVideoTracks: () => [track] },
    readyState: 2,
    videoWidth: 720,
    videoHeight: 960
  };

  return {
    api: window.LorrenWorkerBiometric,
    video,
    detectionCount: () => detectionCount
  };
}


test('el bootstrap solo publica la versión antes del único motor vigente', () => {
  const bootstrapPosition = loader.indexOf('worker-biometric-core.js');
  const enginePosition = loader.indexOf('worker-biometric-mobile.js');
  const flowPosition = loader.indexOf('worker-portal-biometric-flow.js');
  assert.ok(bootstrapPosition >= 0);
  assert.ok(enginePosition > bootstrapPosition);
  assert.ok(flowPosition > enginePosition);
  assert.doesNotMatch(loader, /worker-portal-hardening\.js/);

  assert.match(bootstrap, /MODEL_VERSION = 'human-3\.3\.6-faceres'/);
  assert.match(bootstrap, /Object\.freeze\(\{ MODEL_VERSION \}\)/);
  assert.doesNotMatch(bootstrap, /humanFaceSimilarity|installPortalResponseGuard|window\.fetch|requiresReview/);
  assert.doesNotMatch(bootstrap, /function humanConfig|captureEnrollment|captureVerification|getUserMedia|human\.detect/);
  assert.match(mobile, /function humanConfig/);
  assert.match(mobile, /async function captureEnrollment/);
  assert.match(mobile, /async function captureVerification/);
  assert.match(mobile, /navigator\.mediaDevices\.getUserMedia/);
});


test('la detección facial usa fallback móvil y precalienta los modelos', () => {
  assert.match(mobile, /\['webgl', 'wasm', 'cpu'\]/);
  assert.match(mobile, /human\.load\(\)/);
  assert.match(mobile, /human\.warmup\(\)/);
  assert.match(mobile, /BASELINE_TIMEOUT_MS = 14_000/);
  assert.match(mobile, /CHALLENGE_TIMEOUT_MS = 10_000/);
  assert.match(mobile, /FINAL_TIMEOUT_MS = 14_000/);
  assert.match(mobile, /waitForVideoReady/);
  assert.match(mobile, /videoWidth > 0/);
});


test('vivacidad, anti-spoof y descriptor deben coincidir en la muestra aceptada', () => {
  assert.match(mobile, /scores\.realScore < MIN_REAL_SCORE/);
  assert.match(mobile, /scores\.liveScore < MIN_LIVE_SCORE/);
  assert.match(mobile, /descriptor = normalizeDescriptor\(detected\.face\.embedding\)/);
  assert.match(mobile, /samples\.push\(\{\s*descriptor,/);
  assert.match(mobile, /realScore:\s*scores\.realScore/);
  assert.match(mobile, /liveScore:\s*scores\.liveScore/);
  assert.match(mobile, /ArrayBuffer\.isView\(value\)/);
  assert.doesNotMatch(mobile, /bestReal = Math\.max/);
  assert.doesNotMatch(mobile, /bestLive = Math\.max/);
  assert.doesNotMatch(mobile, /Math\.max\(modelLiveScore,\s*MIN_LIVE_SCORE\)/);
});


test('una sola muestra exige cinco segundos continuos de rostro válido antes de capturar', () => {
  const start = mobile.indexOf('async function collectStableFront');
  const end = mobile.indexOf('\n  async function captureEnrollment', start);
  assert.ok(start >= 0 && end > start);
  const source = mobile.slice(start, end);

  assert.match(mobile, /const MIN_STABLE_FACE_DURATION_MS = 5_000/);
  assert.match(source, /let stableStartedAt = null/);
  assert.match(source, /function resetStableWindow\(\) \{\s*stableStartedAt = null/);
  assert.match(source, /if \(!detected \|\| !frontFacing\(detected\.face\)\) \{\s*resetStableWindow\(\)/);

  const realScoreBranch = source.match(/if \(scores\.realScore < MIN_REAL_SCORE\) \{([\s\S]*?)\n      \}/)?.[1] || '';
  const liveScoreBranch = source.match(/if \(scores\.liveScore < MIN_LIVE_SCORE\) \{([\s\S]*?)\n      \}/)?.[1] || '';
  const descriptorFailure = source.match(/catch \{([\s\S]*?)No se pudieron leer los rasgos/)?.[1] || '';
  assert.match(realScoreBranch, /resetStableWindow\(\)/);
  assert.match(liveScoreBranch, /resetStableWindow\(\)/);
  assert.match(descriptorFailure, /resetStableWindow\(\)/);

  const timerPosition = source.indexOf('if (stableStartedAt === null) stableStartedAt = Date.now();');
  const thresholdPosition = source.indexOf('stableElapsedMs < MIN_STABLE_FACE_DURATION_MS');
  const capturePosition = source.indexOf('samples.push({');
  assert.ok(timerPosition >= 0);
  assert.ok(thresholdPosition > timerPosition);
  assert.ok(capturePosition > thresholdPosition, 'la muestra solo se guarda después de superar la ventana estable');
  assert.match(source, /secondsRemaining = Math\.max\(1, Math\.ceil/);
  assert.match(source, /Mantén el rostro de frente y quieto/);
});


test('la ventana de cinco segundos se reinicia si el rostro deja de ser válido', async () => {
  const harness = createStableCaptureHarness({ invalidDetection: 30 });
  const statuses = [];
  const capture = await harness.api.captureEnrollment({
    video: harness.video,
    onStatus: (message) => statuses.push(message)
  });

  assert.equal(capture.sampleDescriptors.length, 1);
  assert.ok(capture.captureDurationMs >= 7_500, `duración observada: ${capture.captureDurationMs} ms`);
  assert.ok(harness.detectionCount() >= 80);
  assert.ok(statuses.some((message) => message.includes('5 s')));
});


test('la verificación móvil conserva cámara viva y una sola muestra frontal', () => {
  assert.match(mobile, /challenge\.action === 'TURN_SIDE'/);
  assert.match(mobile, /geometry\.faceRatio >= closerTarget/);
  assert.match(mobile, /const VERIFICATION_STAGE_SAMPLES = 1/);
  assert.match(mobile, /const REQUIRED_ACTION_FRAMES = 3/);
  assert.match(mobile, /actionDescriptors:\s*action\.descriptors/);
  assert.match(mobile, /actionLiveScores:\s*action\.liveScores/);
  assert.match(mobile, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(mobile, /capturePhoto\(video\)/);
  assert.doesNotMatch(mobile, /input type=["']file/);
});
