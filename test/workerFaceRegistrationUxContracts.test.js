import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const server = read('src/server.js');
const loader = read('src/public/worker-biometric.js');
const presenceUx = read('src/public/worker-biometric-presence-ux.js');
const serviceWorker = read('src/public/worker-portal-sw.js');
const presenceService = read('src/services/workerFacePresenceService.js');

test('el portal vuelve a consultar el registro facial real sin reactivar comparación de identidad', () => {
  assert.match(server, /getEnrollmentFn:\s*\(workerId\)\s*=>\s*getWorkerBiometricEnrollment\(prisma,\s*workerId\)/);
  assert.match(server, /assessBiometricFn:\s*\(input,\s*assessmentOptions\)\s*=>\s*assessWorkerFacePresence\(prisma,\s*input,\s*assessmentOptions\)/);
  assert.doesNotMatch(server, /getEnrollmentFn:\s*async\s*\(\)\s*=>\s*workerFacePresenceStatus/);
  assert.match(presenceService, /identityMatchEnforced:\s*false/);
});

test('la validación de marcación mantiene una ventana visual breve y sin mensajes de comparación', () => {
  const mobilePosition = loader.indexOf('/public/worker-biometric-mobile.js');
  const uxPosition = loader.indexOf('/public/worker-biometric-presence-ux.js');
  const flowPosition = loader.indexOf('/public/worker-portal-biometric-flow.js');

  assert.ok(mobilePosition >= 0 && uxPosition > mobilePosition && flowPosition > uxPosition);
  assert.match(presenceUx, /MIN_VISIBLE_VERIFICATION_MS\s*=\s*5_000/);
  assert.match(presenceUx, /onStatus:\s*\(\)\s*=>\s*\{\}/);
  assert.match(presenceUx, /data-flow-state=\\?"verifying\\?"/);
  assert.match(presenceUx, /data-flow-state=\\?"verified\\?"/);
});

test('el asset de UX facial forma parte del shell offline del portal', () => {
  assert.match(serviceWorker, /worker-biometric-presence-ux\.js/);
  assert.match(serviceWorker, /lorren-worker-portal-shell-v18/);
});