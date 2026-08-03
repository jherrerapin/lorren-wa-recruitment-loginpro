import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const mobile = fs.readFileSync('src/public/worker-biometric-mobile.js', 'utf8');


test('la biometría permanece disponible durante una jornada completa', () => {
  assert.match(mobile, /RUNTIME_MAX_IDLE_MS = 12 \* 60 \* 60 \* 1000/);
  assert.doesNotMatch(mobile, /RUNTIME_MAX_IDLE_MS = 10 \* 60 \* 1000/);
  assert.match(mobile, /suspendStreamsForLifecycle\('document-hidden'\)/);
  assert.doesNotMatch(mobile, /suspendForLifecycle\('document-hidden'\)/);
  assert.match(mobile, /if \(document\.wasDiscarded\) invalidateRuntime\('page-discarded'\)/);
});


test('la preparación biométrica nunca queda esperando indefinidamente', () => {
  assert.match(mobile, /RUNTIME_PREPARE_TIMEOUT_MS = 30_000/);
  assert.match(mobile, /function withTimeout\(promise, timeoutMs, errorCode\)/);
  assert.match(mobile, /withTimeout\(\s*humanInstance\(\),\s*RUNTIME_PREPARE_TIMEOUT_MS,\s*'biometric_runtime_unavailable'/s);
  assert.match(mobile, /await invalidateRuntime\('prepare-failed'\)/);
});


test('la cámara se muestra antes de esperar los modelos y no se reinicia si ya está viva', () => {
  assert.match(mobile, /const video = activePreparationVideo\(\)/);
  assert.match(mobile, /if \(video && !liveStreamFor\(video\)\) await startCamera\(video\)/);
  assert.match(mobile, /const currentStream = liveStreamFor\(video\)/);
  assert.match(mobile, /if \(currentStream\) \{\s*video\.hidden = false;\s*return currentStream;/s);
});
