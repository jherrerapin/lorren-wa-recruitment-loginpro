import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);

function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

test('Nearby de cuadrilla usa transporte local no disruptivo y low-power', async () => {
  const nearby = await read('mobile/android/app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java');

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
  assert.match(nearby, /requestConnection\(ENDPOINT_NAME, endpointId, connectionLifecycleCallback, LOCAL_CONNECTION_OPTIONS\)/);
  assert.doesNotMatch(nearby, /WifiManager|setWifiEnabled\s*\(/);
});

test('scan termina temprano cuando ya tiene proofs esperadas y ubicación del encargado', async () => {
  const [nearby, bridge, nativePresence] = await Promise.all([
    read('mobile/android/app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java'),
    read('mobile/android/app/src/main/java/com/loginpro/lorren/portal/PresenceBridge.java'),
    read('mobile/android/app/src/main/assets/native-presence.js')
  ]);

  assert.match(nearby, /expectedProofCount/);
  assert.match(nearby, /leaderLocationReady/);
  assert.match(nearby, /markLeaderLocationReady\(String locationAttemptId\)/);
  assert.match(
    nearby,
    /maybeCompleteLeaderScan\(\)[\s\S]{0,500}leaderLocationReady[\s\S]{0,260}proofsByKey\.size\(\) >= expectedProofCount[\s\S]{0,300}completeLeaderScan/
  );
  assert.match(bridge, /manager\.markLeaderLocationReady\(attemptId\)/);
  assert.match(nativePresence, /expectedProofCount:\s*pendingAuxiliaryCount\(context\)/);
});

test('APK oculta Web Bluetooth legacy y reintenta automáticamente una detección incompleta', async () => {
  const nativePresence = await read('mobile/android/app/src/main/assets/native-presence.js');

  assert.match(nativePresence, /MAX_AUTOMATIC_RETRIES\s*=\s*2/);
  assert.match(nativePresence, /function pendingAuxiliaryCount\(context\)/);
  assert.match(nativePresence, /\[data-crew-bluetooth-status\]/);
  assert.match(
    nativePresence,
    /proofCount < expectedProofCount[\s\S]{0,500}autoRetryRemaining > 0[\s\S]{0,700}startLeaderScan\(true\)/
  );
});

test('marcación de cuadrilla conserva cola offline y no exige Internet para iniciar el scan', async () => {
  const [nativePresence, offline] = await Promise.all([
    read('mobile/android/app/src/main/assets/native-presence.js'),
    read('src/public/worker-portal-offline.js')
  ]);

  const startLeaderScan = nativePresence.match(/async function startLeaderScan\(automaticRetry = false\) \{([\s\S]*?)\n  \}\n\n  function stopNativeModes/);
  assert.ok(startLeaderScan, 'falta autoridad startLeaderScan');
  assert.doesNotMatch(startLeaderScan[1], /navigator\.onLine|fetch\s*\(/);
  assert.match(nativePresence, /offline\.queueCrewPresence\(/);
  assert.match(nativePresence, /if \(navigator\.onLine && typeof offline\?\.syncNow === 'function'\)/);
  assert.match(offline, /const CREW_QUEUE_STORE = 'crewPresenceQueue'/);
  assert.match(offline, /async function queueCrewPresence\(payload\)/);
});
