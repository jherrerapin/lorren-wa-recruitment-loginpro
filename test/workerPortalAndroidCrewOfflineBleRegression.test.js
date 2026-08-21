import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function read(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('APK usa la autoridad nativa de cuadrilla y no inicia el Web Bluetooth heredado', async () => {
  const [workerBiometric, nativePresence] = await Promise.all([
    read('src/public/worker-biometric.js'),
    read('mobile/android/app/src/main/assets/native-presence.js')
  ]);

  const legacyCrewBlockStart = workerBiometric.indexOf("const CONTEXT_PATH = '/operaciones/portal/cuadrillas/proximidad/contexto';");
  const nativeGuard = workerBiometric.indexOf("if (window.LorrenAndroidPresence || /LorrenNative\\/1/.test(WORKER_PORTAL_USER_AGENT)) return;");
  const webBluetoothCall = workerBiometric.indexOf('navigator.bluetooth.requestDevice');

  assert.ok(legacyCrewBlockStart >= 0, 'falta localizar el flujo web de cuadrilla');
  assert.ok(nativeGuard > legacyCrewBlockStart, 'el APK debe salir del flujo Web Bluetooth al entrar al bloque de cuadrilla');
  assert.ok(webBluetoothCall > nativeGuard, 'el guard nativo debe ejecutarse antes de cualquier requestDevice');
  assert.match(nativePresence, /\[data-crew-bluetooth-status\]/);
});

test('Nearby de cuadrilla queda en BLE no disruptivo y no contiene autoridad para encender WiFi', async () => {
  const nearby = await read('mobile/android/app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java');

  assert.match(nearby, /DiscoveryOptions\.Builder\(\)[\s\S]{0,180}setLowPower\(true\)/);
  assert.match(nearby, /AdvertisingOptions\.Builder\(\)[\s\S]{0,220}setLowPower\(true\)[\s\S]{0,120}setConnectionType\(ConnectionType\.NON_DISRUPTIVE\)/);
  assert.match(nearby, /ConnectionOptions\.Builder\(\)[\s\S]{0,220}setLowPower\(true\)[\s\S]{0,120}setConnectionType\(ConnectionType\.NON_DISRUPTIVE\)/);
  assert.doesNotMatch(nearby, /WifiManager|setWifiEnabled|ACTION_WIFI_STATE_CHANGED|startLocalOnlyHotspot/);
});

test('encargado termina al recibir todas las proofs y hace como máximo un reintento automático si faltan', async () => {
  const [nearby, nativePresence] = await Promise.all([
    read('mobile/android/app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java'),
    read('mobile/android/app/src/main/assets/native-presence.js')
  ]);

  assert.match(nativePresence, /function expectedAuxiliaryProofCount\(context\)/);
  assert.match(nativePresence, /expectedProofCount = expectedAuxiliaryProofCount\(context\)/);
  assert.match(nativePresence, /timeoutMs: DEFAULT_SCAN_MS,[\s\S]{0,80}expectedProofCount/);
  assert.match(nearby, /input\.optInt\("expectedProofCount", 0\)/);
  assert.match(nearby, /expectedProofCount > 0 && proofsByKey\.size\(\) >= expectedProofCount[\s\S]{0,120}completeLeaderScan\(attemptId\)/);

  assert.match(nativePresence, /let autoRetryRemaining = 1;/);
  assert.match(nativePresence, /const incomplete = expectedProofCount > 0 && proofCount < expectedProofCount;/);
  assert.match(nativePresence, /\(transientFailures > 0 \|\| incomplete\) && autoRetryRemaining > 0/);
  assert.match(nativePresence, /autoRetryRemaining -= 1;/);
});

test('verificación local se encola offline y solo sincroniza cuando vuelve Internet', async () => {
  const nativePresence = await read('mobile/android/app/src/main/assets/native-presence.js');

  const startLeaderScan = nativePresence.match(/async function startLeaderScan\(automaticRetry = false\) \{([\s\S]*?)\n  \}\n\n  function stopNativeModes/);
  const queueCompletedAttempt = nativePresence.match(/async function queueCompletedAttempt\(\) \{([\s\S]*?)\n  \}\n\n  function handleNativeEvent/);

  assert.ok(startLeaderScan, 'falta startLeaderScan');
  assert.ok(queueCompletedAttempt, 'falta queueCompletedAttempt');
  assert.doesNotMatch(startLeaderScan[1], /navigator\.onLine/);
  assert.match(queueCompletedAttempt[1], /offline\.queueCrewPresence/);
  assert.match(queueCompletedAttempt[1], /if \(navigator\.onLine && typeof offline\?\.syncNow === 'function'\) offline\.syncNow\(\)/);
  assert.match(nativePresence, /if \(!navigator\.onLine\) return readCachedContexts\(\);/);
  assert.match(nativePresence, /if \(!navigator\.onLine\) return credentialPrepared\(\);/);
  assert.match(nativePresence, /Guardada sin conexión; se sincronizará cuando vuelva Internet\./);
});
