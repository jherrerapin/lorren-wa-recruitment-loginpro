import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const [nativePresence, nearby, bridge, offline] = await Promise.all([
  readFile(new URL('mobile/android/app/src/main/assets/native-presence.js', ROOT), 'utf8'),
  readFile(new URL('mobile/android/app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java', ROOT), 'utf8'),
  readFile(new URL('mobile/android/app/src/main/java/com/loginpro/lorren/portal/PresenceBridge.java', ROOT), 'utf8'),
  readFile(new URL('src/public/worker-portal-offline.js', ROOT), 'utf8')
]);

test('la cuadrilla encola la ubicación Android firmada y no depende del GPS del WebView', () => {
  assert.doesNotMatch(nativePresence, /navigator\.geolocation|getCurrentPosition|function requestLocation/);
  assert.match(nativePresence, /function nativeLocationFromBundle\(proofBundle\)/);
  assert.match(nativePresence, /proofBundle\?\.leaderLocationProof/);
  assert.match(nativePresence, /clientCapturedAt: new Date\(capturedAtMs\)\.toISOString\(\)/);
  assert.match(nativePresence, /queueCrewPresence\(\{ \.\.\.attempt, \.\.\.nativeLocation, proofBundle \}\)/);
  assert.match(nativePresence, /proof\.isMock === true/);
});

test('un scan terminado conserva reintento manual aunque no haya respuesta del servidor', () => {
  assert.match(nativePresence, /if \(type === 'scan_complete'\)[\s\S]*markRetryAvailable\(\)/);
  assert.match(nativePresence, /hasCompletedLeaderScan/);
  assert.match(nativePresence, /Reintentar no detectados/);
  assert.match(nativePresence, /Aún faltan teléfonos; puedes reintentar los no detectados/);
});

test('fallos transitorios o teléfonos ausentes producen hasta dos retries automáticos y conservan cada intento', () => {
  assert.match(nativePresence, /const MAX_AUTOMATIC_RETRIES = 2/);
  assert.match(nativePresence, /let autoRetryRemaining = MAX_AUTOMATIC_RETRIES/);
  assert.match(nativePresence, /TRANSIENT_SCAN_ERRORS/);
  assert.match(nativePresence, /const incompleteDetection = proofCount < expectedProofCount/);
  assert.match(nativePresence, /transientFailures > 0 \|\| incompleteDetection/);
  assert.match(nativePresence, /autoRetryRemaining -= 1/);
  assert.match(nativePresence, /startLeaderScan\(true\)/);
  assert.match(nativePresence, /const attemptId = newAttemptId\(\)/);
  assert.match(nativePresence, /challenge: randomToken\(32\)/);
  assert.match(nativePresence, /offline\.queueCrewPresence/);
});

test('el scan local no exige Internet y conserva la cola IndexedDB canónica', () => {
  const startLeaderScan = nativePresence.match(/async function startLeaderScan\(automaticRetry = false\) \{([\s\S]*?)\n  \}\n\n  function stopNativeModes/);
  assert.ok(startLeaderScan, 'falta autoridad startLeaderScan');
  assert.doesNotMatch(startLeaderScan[1], /navigator\.onLine|fetch\s*\(/);
  assert.match(nativePresence, /if \(navigator\.onLine && typeof offline\?\.syncNow === 'function'\)/);
  assert.match(offline, /const CREW_QUEUE_STORE = 'crewPresenceQueue'/);
  assert.match(offline, /async function queueCrewPresence\(payload\)/);
});

test('Nearby usa conexión local low-power no disruptiva y no cambia Wi-Fi desde la app', () => {
  assert.match(nearby, /import com\.google\.android\.gms\.nearby\.connection\.ConnectionOptions;/);
  assert.match(nearby, /import com\.google\.android\.gms\.nearby\.connection\.ConnectionType;/);
  assert.match(
    nearby,
    /AdvertisingOptions\.Builder\(\)[\s\S]{0,300}setStrategy\(STRATEGY\)[\s\S]{0,180}setLowPower\(true\)[\s\S]{0,180}setConnectionType\(ConnectionType\.NON_DISRUPTIVE\)/
  );
  assert.match(
    nearby,
    /DiscoveryOptions\.Builder\(\)[\s\S]{0,240}setStrategy\(STRATEGY\)[\s\S]{0,180}setLowPower\(true\)/
  );
  assert.match(
    nearby,
    /ConnectionOptions\.Builder\(\)[\s\S]{0,240}setLowPower\(true\)[\s\S]{0,180}setConnectionType\(ConnectionType\.NON_DISRUPTIVE\)/
  );
  assert.match(
    nearby,
    /requestConnection\([\s\S]{0,120}ENDPOINT_NAME[\s\S]{0,100}endpointId[\s\S]{0,100}connectionLifecycleCallback[\s\S]{0,100}LOCAL_CONNECTION_OPTIONS[\s\S]{0,60}\)/
  );
  assert.doesNotMatch(nearby, /WifiManager|setWifiEnabled\s*\(/);
});

test('scan exitoso termina temprano solo con todas las proofs esperadas y ubicación del encargado', () => {
  assert.match(nearby, /expectedProofCount/);
  assert.match(nearby, /leaderLocationReady/);
  assert.match(nearby, /markLeaderLocationReady\(String locationAttemptId\)/);
  assert.match(
    nearby,
    /maybeCompleteLeaderScan\(\)[\s\S]{0,500}leaderLocationReady[\s\S]{0,260}proofsByKey\.size\(\) < expectedProofCount[\s\S]{0,300}completeLeaderScan/
  );
  assert.match(bridge, /manager\.markLeaderLocationReady\(attemptId\)/);
  assert.match(nativePresence, /const expectedProofCount = pendingAuxiliaryCount\(context\);/);
  assert.match(nativePresence, /timeoutMs: DEFAULT_SCAN_MS,\s*expectedProofCount/);
});

test('APK oculta el Web Bluetooth heredado y el retry local no crea otra autoridad de asistencia', () => {
  assert.match(nativePresence, /\[data-crew-bluetooth-status\]/);
  assert.doesNotMatch(nativePresence, /registerDispatchArrival|registerCrewArrivalForLeader/);
  assert.doesNotMatch(nativePresence, /fetch\([^\n]*(?:llegada|salida|almuerzo)/i);
  assert.match(nativePresence, /attendanceWriter !== false/);
});
