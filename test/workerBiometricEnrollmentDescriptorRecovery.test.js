import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const mobile = fs.readFileSync('src/public/worker-biometric-mobile.js', 'utf8');

function face({ withDescriptor = true } = {}) {
  return {
    box: [200, 200, 320, 320],
    faceScore: 0.95,
    real: 0.9,
    live: 0.9,
    ...(withDescriptor
      ? { embedding: Array.from({ length: 128 }, (_, index) => (index === 0 ? 1 : 0)) }
      : {}),
    rotation: { angle: { yaw: 0, pitch: 0 } }
  };
}

function createHarness() {
  let detectionCount = 0;

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
        face: [face({ withDescriptor: detectionCount > 1 })]
      });
    }
  }

  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => {} }),
    toBlob: (callback) => callback(new Blob(['synthetic-photo'], { type: 'image/jpeg' }))
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
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    addEventListener: () => {}
  };

  vm.runInNewContext(mobile, {
    window,
    document,
    navigator: window.navigator,
    performance,
    Blob,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
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

test('el enrolamiento descarta un frame sin rasgos y acepta la siguiente muestra válida', async () => {
  assert.match(mobile, /const REQUIRED_STABLE_FRONT_FRAMES = 1/);
  assert.doesNotMatch(mobile, /const MIN_STABLE_FACE_DURATION_MS = 5_000/);

  const harness = createHarness();
  const statuses = [];
  const capture = await harness.api.captureEnrollment({
    video: harness.video,
    onStatus: (message) => statuses.push(message)
  });

  assert.equal(harness.detectionCount(), 2);
  assert.equal(capture.sampleDescriptors.length, 1);
  assert.ok(capture.sampleDescriptors[0].length >= 64);
  assert.ok(capture.realScore >= 0.55);
  assert.ok(capture.liveScore >= 0.55);
  assert.ok(statuses.includes('No se pudieron leer los rasgos. Mantén la posición.'));
});
