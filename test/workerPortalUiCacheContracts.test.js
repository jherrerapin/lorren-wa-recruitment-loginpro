import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const serviceWorker = read('src/public/worker-portal-sw.js');
const loader = read('src/public/worker-biometric.js');
const mobile = read('src/public/worker-biometric-mobile.js');
const biometricFlow = read('src/public/worker-portal-biometric-flow.js');

test('la caché vigente usa los módulos actuales y no depende de archivos retirados', () => {
  assert.match(serviceWorker, /CACHE_NAME\s*=\s*'lorren-worker-portal-shell-v11'/);
  assert.match(serviceWorker, /NETWORK_FIRST_ASSETS/);
  assert.match(serviceWorker, /cache\.addAll\(STATIC_ASSETS\)/);
  assert.match(serviceWorker, /name !== CACHE_NAME/);
  assert.match(serviceWorker, /Abre el portal una vez con conexión/);
  assert.match(loader, /BIOMETRIC_ASSET_RELEASE\s*=\s*'20260803-worker-portal-runtime-v5'/);
  assert.match(loader, /worker-biometric-mobile\.js\?v=\$\{BIOMETRIC_ASSET_RELEASE\}/);
  assert.match(loader, /worker-portal-biometric-flow\.js\?v=\$\{BIOMETRIC_ASSET_RELEASE\}/);
  assert.doesNotMatch(loader, /worker-biometric-accessibility\.js|worker-portal-hardening\.js|worker-portal-offline-v2\.js/);
});

test('la verificación vigente conserva liveness y anti-spoof por muestra', () => {
  assert.match(mobile, /scores\.realScore < MIN_REAL_SCORE/);
  assert.match(mobile, /scores\.liveScore < MIN_LIVE_SCORE/);
  assert.match(mobile, /MODEL_AND_ACTIVE_CHALLENGE_V2/);
  assert.match(mobile, /faces\.length !== 1/);
  assert.match(mobile, /const REQUIRED_ACTION_FRAMES = 3/);
  assert.doesNotMatch(mobile, /requireModelLiveness:\s*false/);
  assert.doesNotMatch(mobile, /Math\.max\(modelLiveScore,\s*MIN_LIVE_SCORE\)/);
  assert.match(biometricFlow, /MAX_AUTOMATIC_ATTEMPTS = 2/);
});

test('la cola reprograma red, 408, 425, 429 y errores 5xx sin duplicar envíos', () => {
  assert.match(serviceWorker, /RETRYABLE_HTTP_STATUSES = new Set\(\[408, 425, 429\]\)/);
  assert.match(serviceWorker, /function retryDelayMs\(response/);
  assert.match(serviceWorker, /response\.headers\.get\('Retry-After'\)/);
  assert.match(serviceWorker, /retryNotBefore/);
  assert.match(serviceWorker, /if \(Number\.isFinite\(retryNotBefore\) && retryNotBefore > nowMs\)/);
  assert.match(serviceWorker, /return RETRYABLE_HTTP_STATUSES\.has\(status\) \|\| status >= 500/);
  assert.match(serviceWorker, /if \(throwOnRetry && shouldRetry\) throw new Error\('arrival_sync_retry_required'\)/);
  assert.match(serviceWorker, /idempotencyKey/);
});
