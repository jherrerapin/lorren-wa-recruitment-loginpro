import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const serviceWorker = read('src/public/worker-portal-sw.js');
const loader = read('src/public/worker-biometric.js');
const mobile = read('src/public/worker-biometric-mobile.js');
const accessibility = read('src/public/worker-biometric-accessibility.js');

test('el nuevo flujo invalida el caché anterior y versiona los activos biométricos', () => {
  assert.match(serviceWorker, /CACHE_NAME\s*=\s*'lorren-worker-portal-shell-v6'/);
  assert.match(serviceWorker, /'\/operaciones\/portal\/offline\.js'/);
  assert.match(serviceWorker, /cache\.addAll\(STATIC_ASSETS\)/);
  assert.match(serviceWorker, /name !== CACHE_NAME/);
  assert.match(serviceWorker, /La asistencia requiere conexión/);
  assert.match(loader, /BIOMETRIC_ASSET_VERSION\s*=\s*'20260729-r4'/);
  assert.match(loader, /worker-biometric-mobile\.js\?v=\$\{BIOMETRIC_ASSET_VERSION\}/);
  assert.match(loader, /worker-biometric-accessibility\.js\?v=\$\{BIOMETRIC_ASSET_VERSION\}/);
});

test('la verificación usa el desafío activo sin quedar atrapada esperando el score de liveness', () => {
  assert.match(mobile, /requireModelLiveness\s*=\s*options\.requireModelLiveness !== false/);
  assert.match(mobile, /requireModelLiveness:\s*false/);
  assert.match(mobile, /Movimiento confirmado\. Vuelve a mirar de frente/);
  assert.match(mobile, /liveScore:\s*Math\.max\(modelLiveScore, MIN_LIVE_SCORE\)/);
  assert.match(mobile, /livenessEvidence:\s*'ACTIVE_CHALLENGE'/);
  assert.match(mobile, /faces\.length !== 1/);
  assert.match(mobile, /bestReal >= MIN_REAL_SCORE/);
});

test('un fallo realiza un solo reintento completo con contexto nuevo y sin otro toque', () => {
  assert.match(accessibility, /automaticRetryUsed/);
  assert.match(accessibility, /closeButton\?\.click\(\)/);
  assert.match(accessibility, /activeMarkButton\.click\(\)/);
  assert.match(accessibility, /consent\.checked = true/);
  assert.match(accessibility, /captureButton\.click\(\)/);
  assert.match(accessibility, /Segundo intento automático/);
  assert.doesNotMatch(accessibility, /installSinglePressVerification/);
  assert.doesNotMatch(accessibility, /window\.fetch\s*=/);
  assert.doesNotMatch(accessibility, /getUserMedia\s*=/);
});
