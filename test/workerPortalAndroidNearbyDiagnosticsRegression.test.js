import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const managerPath = new URL(
  '../mobile/android/app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java',
  import.meta.url
);
const bridgePath = new URL(
  '../mobile/android/app/src/main/java/com/loginpro/lorren/portal/PresenceBridge.java',
  import.meta.url
);
const mainActivityPath = new URL(
  '../mobile/android/app/src/main/java/com/loginpro/lorren/portal/MainActivity.java',
  import.meta.url
);
const manifestPath = new URL(
  '../mobile/android/app/src/main/AndroidManifest.xml',
  import.meta.url
);
const nativePresencePath = new URL(
  '../mobile/android/app/src/main/assets/native-presence.js',
  import.meta.url
);

async function read(url) {
  return readFile(url, 'utf8');
}

test('la autoridad nativa permanece en Bluetooth Classic RFCOMM/SDP y no vuelve a Nearby Connections', async () => {
  const [manager, bridge, mainActivity, nativePresence] = await Promise.all([
    read(managerPath),
    read(bridgePath),
    read(mainActivityPath),
    read(nativePresencePath)
  ]);

  assert.match(manager, /BluetoothServerSocket/);
  assert.match(manager, /BluetoothSocket/);
  assert.match(manager, /listenUsingInsecureRfcommWithServiceRecord/);
  assert.match(manager, /createInsecureRfcommSocketToServiceRecord/);
  assert.match(manager, /bluetoothAdapter\.startDiscovery\(\)/);
  assert.match(manager, /BluetoothAdapter\.ACTION_DISCOVERY_STARTED/);
  assert.match(manager, /BluetoothAdapter\.ACTION_DISCOVERY_FINISHED/);
  assert.match(manager, /BluetoothDevice\.ACTION_UUID/);
  assert.match(manager, /fetchUuidsWithSdp\(\)/);
  assert.match(manager, /INQUIRY_CHECKPOINT_MS = 15_000L/);
  assert.match(manager, /RFCOMM_EXCHANGE_TIMEOUT_MS = 12_000L/);
  assert.match(manager, /SCAN_MODE_CONNECTABLE_DISCOVERABLE/);
  assert.match(manager, /DISCOVERABLE_CONFIRMED/);
  assert.match(manager, /RFCOMM_SERVER_READY/);
  assert.doesNotMatch(manager, /com\.google\.android\.gms\.nearby|Nearby\.getConnectionsClient|ConnectionsClient|Strategy\.P2P_/);

  assert.match(bridge, /pendingReadyServiceRequestId/);
  assert.match(bridge, /activity\.ensureNearbyDiscoverable\(\)/);
  assert.match(bridge, /onBluetoothDiscoverableResult\(boolean granted\)/);
  assert.match(bridge, /onBluetoothDiscoverableResult[\s\S]{0,1400}manager\.startReady\(serviceRequestId\)/);

  assert.match(mainActivity, /REQUEST_BLUETOOTH_DISCOVERABLE = 4107/);
  assert.match(mainActivity, /BLUETOOTH_DISCOVERABLE_SECONDS = 300/);
  assert.match(mainActivity, /BluetoothAdapter\.ACTION_REQUEST_DISCOVERABLE/);
  assert.match(mainActivity, /BluetoothAdapter\.EXTRA_DISCOVERABLE_DURATION/);
  assert.match(mainActivity, /onBluetoothDiscoverableResult\(resultCode > 0\)/);
  assert.match(mainActivity, /event\.put\(key, value\)/);
  assert.doesNotMatch(mainActivity, /event\.put\("key", value\)/);

  assert.match(
    nativePresence,
    /discovery_failed:\s*'No fue posible iniciar la escucha Bluetooth para la marcación\. Intenta nuevamente\.'/
  );
});

test('Android 12+ valida y solicita permisos Bluetooth antes de iniciar escucha, discovery o conexión', async () => {
  const [manager, mainActivity, manifest] = await Promise.all([
    read(managerPath),
    read(mainActivityPath),
    read(manifestPath)
  ]);

  assert.match(manager, /Manifest\.permission\.BLUETOOTH_SCAN/);
  assert.match(manager, /Manifest\.permission\.BLUETOOTH_ADVERTISE/);
  assert.match(manager, /Manifest\.permission\.BLUETOOTH_CONNECT/);
  assert.match(manager, /ensureNearbyTransportPermissions\(\)/);
  assert.match(manager, /activity\.ensureNearbyPermissions\(\)/);
  assert.match(manager, /checkSelfPermission/);
  assert.doesNotMatch(manager, /Manifest\.permission\.NEARBY_WIFI_DEVICES/);

  assert.match(mainActivity, /Manifest\.permission\.BLUETOOTH_SCAN/);
  assert.match(mainActivity, /Manifest\.permission\.BLUETOOTH_ADVERTISE/);
  assert.match(mainActivity, /Manifest\.permission\.BLUETOOTH_CONNECT/);
  assert.doesNotMatch(mainActivity, /Manifest\.permission\.NEARBY_WIFI_DEVICES/);

  assert.match(manifest, /android\.permission\.BLUETOOTH_SCAN/);
  assert.match(manifest, /android\.permission\.BLUETOOTH_ADVERTISE/);
  assert.match(manifest, /android\.permission\.BLUETOOTH_CONNECT/);
  assert.match(manifest, /android\.permission\.NEARBY_WIFI_DEVICES/);
});

test('status 8029 heredado se trata como permiso pendiente y no como discovery Bluetooth roto', async () => {
  const [manager, bridge] = await Promise.all([read(managerPath), read(bridgePath)]);

  assert.match(manager, /MISSING_PERMISSION_NEARBY_WIFI_DEVICES_STATUS = 8029/);
  assert.match(bridge, /MISSING_PERMISSION_NEARBY_WIFI_DEVICES_STATUS = 8029/);
  assert.match(bridge, /statusCode == MISSING_PERMISSION_NEARBY_WIFI_DEVICES_STATUS/);
  assert.match(bridge, /return "permissions_pending"/);
  assert.doesNotMatch(manager, /DISCOVERY_FAILED_STATUS = 8029/);
  assert.doesNotMatch(bridge, /DISCOVERY_FAILED_STATUS = 8029/);
});

test('hardware sin BLE Advertising activa fallback manual sin forzar advertiser runtime', async () => {
  const [manager, nativePresence] = await Promise.all([read(managerPath), read(nativePresencePath)]);

  assert.match(manager, /supportsBleAdvertising\(\)/);
  assert.match(manager, /PackageManager\.FEATURE_BLUETOOTH_LE/);
  assert.match(manager, /isMultipleAdvertisementSupported\(\)/);
  assert.doesNotMatch(manager, /BluetoothLeAdvertiser/);
  assert.match(manager, /"advertising_unsupported"/);
  assert.match(manager, /emit\("bluetooth_unavailable"/);

  assert.match(nativePresence, /type === 'bluetooth_unavailable'/);
  assert.match(nativePresence, /function activateBluetoothFallback/);
  assert.match(nativePresence, /activeMode = 'IDLE'/);
  assert.match(nativePresence, /bluetoothFallbackActive \? 'Marcación Manual'/);
  assert.match(nativePresence, /function markMemberManually/);
  assert.match(nativePresence, /Marcado \(Manual\)/);
});

test('native-presence.js conserva sintaxis ES6 válida y promesas críticas observadas', async () => {
  const nativePresence = await read(nativePresencePath);

  assert.doesNotThrow(() => new vm.Script(nativePresence, { filename: 'native-presence.js' }));
  assert.match(nativePresence, /startManualArrival\(member\)\.catch\(/);
  assert.match(nativePresence, /ensureAuxiliaryReady\(\)\.catch\(/);
  assert.match(nativePresence, /handleServiceWorkerMessage\(event\)\.catch\(/);
  assert.match(nativePresence, /syncNow\?\.\(\)\.catch\(/);
  assert.doesNotMatch(nativePresence, /\bundefinedVariableForNearby\b/);
});
