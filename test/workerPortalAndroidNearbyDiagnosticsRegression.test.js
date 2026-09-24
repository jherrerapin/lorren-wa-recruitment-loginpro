import test from 'node:test';
import assert from 'node:assert/strict';
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
  assert.match(bridge, /onBluetoothDiscoverableResult[\s\S]{0,1200}manager\.startReady\(serviceRequestId\)/);

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

test('los fallos de inicio Bluetooth activan la marcación manual sin dejar la interfaz cargando', async () => {
  const [manager, bridge, nativePresence] = await Promise.all([
    read(managerPath),
    read(bridgePath),
    read(nativePresencePath)
  ]);

  assert.match(manager, /DISCOVERY_FAILED_STATUS = 8029/);
  assert.match(manager, /emit\("bluetooth_unavailable"/);
  assert.match(manager, /failLeaderBluetooth\("leader_discovery", error\)/);
  assert.match(bridge, /emitBluetoothUnavailable\("leader_discovery", error\)/);
  assert.match(bridge, /event\.put\("type", "bluetooth_unavailable"\)/);

  assert.match(nativePresence, /type === 'bluetooth_unavailable'/);
  assert.match(nativePresence, /function activateBluetoothFallback/);
  assert.match(nativePresence, /activeMode = 'IDLE'/);
  assert.match(nativePresence, /bluetoothFallbackActive \? 'Marcación Manual'/);
  assert.match(nativePresence, /function markMemberManually/);
  assert.match(nativePresence, /Marcado \(Manual\)/);
});
