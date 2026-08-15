import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const nativePresence = await readFile(
  new URL('../mobile/android/app/src/main/assets/native-presence.js', import.meta.url),
  'utf8'
);

test('la cuadrilla encola la ubicación Android firmada y no depende del GPS del WebView', () => {
  assert.doesNotMatch(nativePresence, /navigator\.geolocation|getCurrentPosition|function requestLocation/);
  assert.match(nativePresence, /function nativeLocationFromBundle\(proofBundle\)/);
  assert.match(nativePresence, /proofBundle\?\.leaderLocationProof/);
  assert.match(nativePresence, /clientCapturedAt: new Date\(capturedAtMs\)\.toISOString\(\)/);
  assert.match(nativePresence, /queueCrewPresence\(\{ \.\.\.attempt, \.\.\.nativeLocation, proofBundle \}\)/);
  assert.match(nativePresence, /proof\.isMock === true/);
});

test('un scan terminado habilita reintento manual incluso sin respuesta del servidor', () => {
  assert.match(nativePresence, /if \(type === 'scan_complete'\)[\s\S]*markRetryAvailable\(\)/);
  assert.match(nativePresence, /hasCompletedLeaderScan/);
  assert.match(nativePresence, /Reintentar no detectados/);
  assert.match(nativePresence, /Puedes pulsar “Reintentar no detectados” aun sin Internet/);
});

test('fallos transitorios producen como máximo un retry automático y conservan cada intento', () => {
  assert.match(nativePresence, /let autoRetryRemaining = 1/);
  assert.match(nativePresence, /TRANSIENT_SCAN_ERRORS/);
  assert.match(nativePresence, /queueCompletedAttempt\(\)[\s\S]*transientFailures > 0 && autoRetryRemaining > 0/);
  assert.match(nativePresence, /autoRetryRemaining -= 1/);
  assert.match(nativePresence, /startLeaderScan\(true\)/);
  assert.match(nativePresence, /const attemptId = newAttemptId\(\)/);
  assert.match(nativePresence, /challenge: randomToken\(32\)/);
  assert.match(nativePresence, /offline\.queueCrewPresence/);
});

test('el retry local no introduce un segundo escritor ni endpoints de asistencia', () => {
  assert.doesNotMatch(nativePresence, /registerDispatchArrival|registerCrewArrivalForLeader/);
  assert.doesNotMatch(nativePresence, /fetch\([^\n]*(?:llegada|salida|almuerzo)/i);
  assert.match(nativePresence, /attendanceWriter !== false/);
});
