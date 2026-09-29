import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(path, 'utf8');

test('auxiliar renueva discoverability de 300s y mantiene pantalla encendida durante READY', async () => {
  const [activity, manager] = await Promise.all([
    read('mobile/android/app/src/main/java/com/loginpro/lorren/portal/MainActivity.java'),
    read('mobile/android/app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java')
  ]);

  assert.match(activity, /BLUETOOTH_DISCOVERABLE_SECONDS = 300/);
  assert.match(activity, /Manifest\.permission\.BLUETOOTH_ADVERTISE/);
  assert.match(activity, /ACTION_REQUEST_DISCOVERABLE/);
  assert.match(activity, /void setPresenceKeepScreenOn\(boolean enabled\)/);
  assert.match(activity, /FLAG_KEEP_SCREEN_ON/);
  assert.match(activity, /boolean refreshNearbyDiscoverableWindow\(\)/);

  assert.match(manager, /role = Role\.READY;[\s\S]{0,160}setPresenceKeepScreenOn\(true\)/);
  assert.match(manager, /DISCOVERABILITY_REFRESH_MS = 240_000L/);
  assert.match(manager, /scheduleAuxiliaryDiscoverabilityRefresh\(DISCOVERABILITY_REFRESH_MS\)/);
  assert.match(manager, /refreshNearbyDiscoverableWindow\(\)/);
  assert.match(manager, /cancelAuxiliaryDiscoverabilityRefresh\(\)/);
});

test('líder ejecuta como máximo tres ráfagas Classic antes de terminar', async () => {
  const manager = await read('mobile/android/app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java');

  assert.match(manager, /MAX_DISCOVERY_BURSTS = 3/);
  assert.match(manager, /leaderDiscoveryBurst = 0/);
  assert.match(manager, /startLeaderDiscoveryBurst\(nextAttemptId\)/);
  assert.match(manager, /BluetoothAdapter\.ACTION_DISCOVERY_FINISHED/);
  assert.match(manager, /proofsByKey\.size\(\) < expectedProofCount[\s\S]{0,120}leaderDiscoveryBurst < MAX_DISCOVERY_BURSTS/);
  assert.match(manager, /scheduleLeaderDiscoveryRestart\(completedAttemptId\)/);
  assert.match(manager, /CLASSIC_DISCOVERY_RETRY/);
  assert.match(manager, /leaderDiscoveryBurst \+= 1/);
  assert.match(manager, /scheduleLeaderInquiryCheckpoint\(currentAttemptId\)/);
});

test('frontend usa dos reintentos completos y activa fallback manual solo al agotarlos', async () => {
  const source = await read('mobile/android/app/src/main/assets/native-presence.js');

  assert.match(source, /const MAX_SCAN_RETRIES = 2/);
  assert.match(source, /let scanRetries = 0/);
  assert.doesNotMatch(source, /autoRetryRemaining/);
  assert.match(source, /scanRetries < MAX_SCAN_RETRIES/);
  assert.match(source, /scanRetries \+= 1/);
  assert.match(source, /BLUETOOTH_SCAN_RETRY/);
  assert.match(source, /startLeaderScan\(completionMarkType, true\)/);
  assert.match(source, /reason: 'scan_retries_exhausted'/);
  assert.match(source, /bluetoothFallbackActive = true/);
  assert.doesNotMatch(source, /window\.LorrenNative/);
});

test('bitácora registra el cierre de resiliencia Bluetooth', async () => {
  const audit = await read('auditoria y correccion lorren.md');

  assert.match(audit, /Bluetooth RFCOMM: resiliencia de descubrimiento/);
  assert.match(audit, /FLAG_KEEP_SCREEN_ON/);
  assert.match(audit, /MAX_SCAN_RETRIES = 2/);
});
