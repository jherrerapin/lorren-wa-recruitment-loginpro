import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const mobile = fs.readFileSync('src/public/worker-biometric-mobile.js', 'utf8');
const flow = fs.readFileSync('src/public/worker-portal-biometric-flow.js', 'utf8');

function createRuntimeHarness(source = mobile) {
  let constructorCount = 0;
  let resolveLoad;
  const loadPromise = new Promise((resolve) => { resolveLoad = resolve; });

  class FakeHuman {
    constructor(config) {
      constructorCount += 1;
      this.config = config;
      this.models = {};
      this.tf = { getBackend: () => config.backend };
    }

    load() { return loadPromise; }
    warmup() { return Promise.resolve(); }
  }

  const document = {
    visibilityState: 'visible',
    wasDiscarded: false,
    querySelector: () => null,
    getElementById: () => null,
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

  vm.runInNewContext(source, {
    window,
    document,
    navigator: window.navigator,
    performance,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  });

  return {
    api: window.LorrenWorkerBiometric,
    resolveLoad,
    constructorCount: () => constructorCount
  };
}


test('la biometría permanece disponible durante una jornada completa', () => {
  assert.match(mobile, /RUNTIME_MAX_IDLE_MS = 12 \* 60 \* 60 \* 1000/);
  assert.doesNotMatch(mobile, /RUNTIME_MAX_IDLE_MS = 10 \* 60 \* 1000/);
  assert.match(mobile, /suspendStreamsForLifecycle\('document-hidden'\)/);
  assert.doesNotMatch(mobile, /suspendForLifecycle\('document-hidden'\)/);
  assert.match(mobile, /if \(document\.wasDiscarded\) invalidateRuntime\('page-discarded'\)/);
});


test('la preparación biométrica acota la espera sin convertir un timeout en falla del runtime', () => {
  assert.match(mobile, /RUNTIME_PREPARE_TIMEOUT_MS = 30_000/);
  assert.match(mobile, /function withTimeout\(promise, timeoutMs, errorCode\)/);
  assert.match(mobile, /withTimeout\(\s*humanInstance\(\),\s*RUNTIME_PREPARE_TIMEOUT_MS,\s*'biometric_runtime_prepare_timeout'/s);
  assert.match(mobile, /cause\?\.message === 'biometric_runtime_prepare_timeout'/);
  assert.match(mobile, /new Error\('biometric_runtime_preparing'\)/);
  assert.match(mobile, /await invalidateRuntime\('prepare-failed'\)/);
});


test('preparaciones solapadas comparten una sola carga de Human en Android', async () => {
  const harness = createRuntimeHarness();
  const first = harness.api.prepare();
  await new Promise((resolve) => setImmediate(resolve));
  const second = harness.api.prepare();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.constructorCount(), 1);
  harness.resolveLoad();
  const results = await Promise.all([first, second]);
  assert.equal(harness.constructorCount(), 1);
  assert.deepEqual(results.map((result) => result.backend), ['cpu', 'cpu']);
});


test('un timeout de preparación conserva la carga para el reintento manual', async () => {
  const fastTimeoutSource = mobile.replace(
    'const RUNTIME_PREPARE_TIMEOUT_MS = 30_000;',
    'const RUNTIME_PREPARE_TIMEOUT_MS = 15;'
  );
  assert.notEqual(fastTimeoutSource, mobile);

  const harness = createRuntimeHarness(fastTimeoutSource);
  await assert.rejects(
    harness.api.prepare(),
    (error) => error?.message === 'biometric_runtime_preparing'
  );
  assert.equal(harness.constructorCount(), 1);

  harness.resolveLoad();
  await new Promise((resolve) => setImmediate(resolve));
  const result = await harness.api.prepare();

  assert.equal(result.backend, 'cpu');
  assert.equal(harness.constructorCount(), 1);
});


test('el portal precarga modelos sin cámara cuando el enrolamiento ya está vigente', () => {
  const enrolledBranch = flow.match(/if \(status\.enrolled\) \{([\s\S]*?)\n      \}/)?.[1] || '';
  assert.match(enrolledBranch, /setButtonsReady\(true\)/);
  assert.match(enrolledBranch, /biometricApi\?\.prepare\?\.\(\)\.catch\(\(\) => \{\}\)/);
  assert.match(flow, /biometric_runtime_preparing: 'El reconocimiento facial todavía se está preparando en este teléfono\. Espera unos segundos\.'/);
  assert.match(flow, /setStatus\(message, runtimePreparing \? 'warning' : 'danger'\)/);
});


test('la cámara se muestra antes de esperar los modelos y no se reinicia si ya está viva', () => {
  assert.match(mobile, /const video = activePreparationVideo\(\)/);
  assert.match(mobile, /if \(video && !liveStreamFor\(video\)\) await startCamera\(video\)/);
  assert.match(mobile, /const currentStream = liveStreamFor\(video\)/);
  assert.match(mobile, /if \(currentStream\) \{\s*video\.hidden = false;\s*return currentStream;/s);
});
