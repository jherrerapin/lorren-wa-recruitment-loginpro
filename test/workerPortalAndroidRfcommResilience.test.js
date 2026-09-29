import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(path, 'utf8');

test('auxiliar anuncia silenciosamente SERVICE_UUID por BLE y conserva RFCOMM', async () => {
  const [activity, bridge, manager] = await Promise.all([
    read('mobile/android/app/src/main/java/com/loginpro/lorren/portal/MainActivity.java'),
    read('mobile/android/app/src/main/java/com/loginpro/lorren/portal/PresenceBridge.java'),
    read('mobile/android/app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java')
  ]);

  assert.doesNotMatch(activity, /ACTION_REQUEST_DISCOVERABLE|BLUETOOTH_DISCOVERABLE_SECONDS/);
  assert.doesNotMatch(bridge, /ensureNearbyDiscoverable|onBluetoothDiscoverableResult/);
  assert.match(activity, /Manifest\.permission\.BLUETOOTH_ADVERTISE/);
  assert.match(manager, /BluetoothLeAdvertiser/);
  assert.match(manager, /addServiceUuid\(SERVICE_PARCEL_UUID\)/);
  assert.match(manager, /advertiser\.startAdvertising\(settings, data, callback\)/);
  assert.match(manager, /listenUsingInsecureRfcommWithServiceRecord[\s\S]{0,120}SERVICE_UUID/);
  assert.match(manager, /setPresenceKeepScreenOn\(true\)/);
});

test('líder descubre por BLE filtrado por SERVICE_UUID y conecta challenge-proof por RFCOMM', async () => {
  const manager = await read('mobile/android/app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java');

  assert.match(manager, /BluetoothLeScanner/);
  assert.match(manager, /new ScanFilter\.Builder\(\)[\s\S]{0,120}setServiceUuid\(SERVICE_PARCEL_UUID\)/);
  assert.match(manager, /ScanSettings\.SCAN_MODE_LOW_LATENCY/);
  assert.match(manager, /scanner\.startScan\(Collections\.singletonList\(filter\), settings, callback\)/);
  assert.match(manager, /startLeaderBleScan\(nextAttemptId\)/);
  assert.match(manager, /BLE_SERVICE_FOUND/);
  assert.match(manager, /createInsecureRfcommSocketToServiceRecord\(SERVICE_UUID\)/);
  assert.match(manager, /payload\.put\("type", "challenge"\)/);
  assert.match(manager, /PROOF_VERIFIED/);
});

test('frontend conserva dos reintentos completos y fallback manual', async () => {
  const source = await read('mobile/android/app/src/main/assets/native-presence.js');

  assert.match(source, /const MAX_SCAN_RETRIES = 2/);
  assert.match(source, /let scanRetries = 0/);
  assert.doesNotMatch(source, /autoRetryRemaining/);
  assert.match(source, /scanRetries < MAX_SCAN_RETRIES/);
  assert.match(source, /BLUETOOTH_SCAN_RETRY/);
  assert.match(source, /startLeaderScan\(completionMarkType, true\)/);
  assert.match(source, /reason: 'scan_retries_exhausted'/);
  assert.match(source, /bluetoothFallbackActive = true/);
});
