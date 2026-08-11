import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const mobile = read('src/public/worker-biometric-mobile.js');
const flow = read('src/public/worker-portal-biometric-flow.js');
const service = read('src/services/workerBiometricService.js');
const loader = read('src/public/worker-biometric.js');
const serviceWorker = read('src/public/worker-portal-sw.js');

 test('un registro facial sirve para llegada, almuerzos y salida', () => {
  assert.match(mobile, /const ENROLLMENT_SAMPLES = 3/);
  assert.match(flow, /\['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE'\]\.includes/);
  assert.match(service, /BIOMETRIC_MARK_TYPES = new Set\(\['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE'\]\)/);
});

test('Android evita WebGL y reduce el reconocimiento a dos muestras frontales', () => {
  assert.match(mobile, /const IS_ANDROID = \/Android\/i/);
  assert.match(mobile, /IS_ANDROID \? \['cpu'\] : \['webgl', 'wasm', 'cpu'\]/);
  assert.match(mobile, /mesh: \{ enabled: !IS_ANDROID/);
  assert.match(mobile, /iris: \{ enabled: !IS_ANDROID/);
  const start = mobile.indexOf('async function captureVerification');
  const end = mobile.indexOf('function stopStream', start);
  const verification = mobile.slice(start, end);
  assert.match(verification, /VERIFICATION_STAGE_SAMPLES/);
  assert.match(verification, /MODEL_PASSIVE_LIVENESS_V2/);
  assert.doesNotMatch(verification, /captureActiveChallenge/);
});

test('el servidor conserva anti-spoof, liveness y comparación de identidad', () => {
  assert.match(service, /PASSIVE_VERIFICATION_SAMPLE_COUNT = 2/);
  assert.match(service, /validateStrictSamples\(input, verificationSampleCount/);
  assert.match(service, /REAL_THRESHOLD = 0\.55/);
  assert.match(service, /LIVE_THRESHOLD = 0\.55/);
  assert.match(service, /MATCH_THRESHOLD = 0\.82/);
  assert.match(service, /PASSIVE_CHALLENGE_KIND = 'MODEL_PASSIVE_LIVENESS_V2'/);
});

test('no encadena reinicios automáticos y fuerza actualización del portal', () => {
  assert.match(flow, /MAX_AUTOMATIC_ATTEMPTS = 1/);
  assert.match(loader, /20260804-worker-portal-biometric-v8/);
  assert.match(serviceWorker, /lorren-worker-portal-shell-v14/);
});
