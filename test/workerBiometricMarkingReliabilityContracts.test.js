import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const flow = read('src/public/worker-portal-biometric-flow.js');
const mobile = read('src/public/worker-biometric-mobile.js');
const service = read('src/services/workerBiometricService.js');
const route = read('src/routes/workerPortal.js');
const loader = read('src/public/worker-biometric.js');
const serviceWorker = read('src/public/worker-portal-sw.js');

test('un rechazo facial no genera otro rechazo automático ni acelera el bloqueo', () => {
  assert.match(flow, /AUTOMATIC_RETRY_ERRORS = new Set/);
  const retrySet = flow.slice(
    flow.indexOf('AUTOMATIC_RETRY_ERRORS = new Set'),
    flow.indexOf('BACKEND_RECOVERY_ERRORS')
  );
  assert.doesNotMatch(retrySet, /biometric_verification_rejected/);
  assert.match(flow, /if \(!AUTOMATIC_RETRY_ERRORS\.has\(code\)\) break/);
  assert.match(flow, /code === 'attendance_biometric_rate_limited'/);
});

test('el límite temporal muestra cuenta regresiva y bloquea el botón hasta vencer', () => {
  assert.match(flow, /function beginRateLimitCooldown\(secondsValue\)/);
  assert.match(flow, /function startRateLimitCountdown\(\)/);
  assert.match(flow, /Reintentar en \$\{seconds\} s/);
  assert.match(flow, /retryBiometricButton\.disabled = true/);
  assert.match(flow, /activeRateLimitSeconds\(\) > 0/);
});

test('la segunda muestra recibe tiempo adicional sin reducir liveness ni anti-spoof', () => {
  assert.match(mobile, /SAMPLE_COMPLETION_GRACE_MS = 12_000/);
  assert.match(mobile, /ACTION_COMPLETION_GRACE_MS = 8_000/);
  assert.match(mobile, /let sampleGraceGranted = false/);
  assert.match(mobile, /samples\.length < samplesRequired && !sampleGraceGranted/);
  assert.match(mobile, /sampleGraceGranted = true/);
  assert.match(mobile, /activeDeadline = Math\.max\(activeDeadline, Date\.now\(\) \+ SAMPLE_COMPLETION_GRACE_MS\)/);
  assert.match(mobile, /scores\.realScore < MIN_REAL_SCORE/);
  assert.match(mobile, /scores\.liveScore < MIN_LIVE_SCORE/);
});

test('la cámara solo se abre después del consentimiento y el bloqueo se consulta antes', () => {
  assert.match(mobile, /markConsent\?\.checked === true/);
  assert.match(mobile, /enrollmentConsent\?\.checked === true/);
  const challengePosition = flow.indexOf('const challenge = await requestBiometricChallenge()');
  const preparePosition = flow.indexOf('await biometricApi.prepare?.()', challengePosition);
  assert.ok(challengePosition >= 0 && preparePosition > challengePosition);
});

test('el límite se separa por tipo de marcación en cliente y servidor', () => {
  assert.match(service, /const markType = normalizeString\(input\.markType, 40\)/);
  assert.match(service, /metadata\?\.markType/);
  assert.match(route, /markType: context\.markType/);
  assert.match(flow, /`\$\{state\.assignmentId\}:\$\{state\.markType\}`/);
});

test('la aplicación instalada recibe una versión nueva del motor y de la caché', () => {
  assert.match(loader, /20260804-worker-portal-biometric-v7/);
  assert.match(serviceWorker, /lorren-worker-portal-shell-v13/);
});
