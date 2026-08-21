import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../mobile/android/', import.meta.url);

function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

function methodBody(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `no se encontró ${signature}`);
  const end = source.indexOf(nextSignature, start + signature.length);
  assert.notEqual(end, -1, `no se encontró límite después de ${signature}`);
  return source.slice(start, end);
}

test('Nearby solicita su permiso Wi-Fi desde API 32 y mantiene coherente el grupo Bluetooth', async () => {
  const [manifest, mainActivity] = await Promise.all([
    read('app/src/main/AndroidManifest.xml'),
    read('app/src/main/java/com/loginpro/lorren/portal/MainActivity.java')
  ]);

  assert.match(
    manifest,
    /android:minSdkVersion="32" android:name="android\.permission\.NEARBY_WIFI_DEVICES"/
  );

  const wifiGate = methodBody(
    mainActivity,
    'private boolean requiresNearbyWifiPermission()',
    'private List<String> attendancePermissions'
  );
  assert.match(wifiGate, /Build\.VERSION_CODES\.S_V2/);
  assert.doesNotMatch(wifiGate, /Build\.VERSION_CODES\.TIRAMISU/);

  const bluetoothGroup = methodBody(
    mainActivity,
    'private boolean hasNearbyBluetoothPermissions()',
    'private boolean requiresNearbyWifiPermission()'
  );
  for (const permission of ['BLUETOOTH_SCAN', 'BLUETOOTH_CONNECT', 'BLUETOOTH_ADVERTISE']) {
    assert.match(bluetoothGroup, new RegExp(`Manifest\\.permission\\.${permission}`));
  }
  assert.match(bluetoothGroup, /addNearbyBluetoothPermissionsIfNeeded/);

  const attendancePermissions = methodBody(
    mainActivity,
    'private List<String> attendancePermissions(boolean includeCamera)',
    'private BluetoothAdapter bluetoothAdapter()'
  );
  assert.match(attendancePermissions, /addPreciseLocationPermissionsIfNeeded\(missing\)/);
  assert.match(attendancePermissions, /addNearbyBluetoothPermissionsIfNeeded\(missing\)/);
  assert.match(attendancePermissions, /requiresNearbyWifiPermission\(\)/);
  assert.match(attendancePermissions, /Manifest\.permission\.NEARBY_WIFI_DEVICES/);

  const grantedCheck = methodBody(
    mainActivity,
    'private boolean nearbyPermissionsGranted()',
    'void emitPresenceEvent(JSONObject event)'
  );
  assert.match(grantedCheck, /hasPreciseLocationPermission\(\)/);
  assert.match(grantedCheck, /hasNearbyBluetoothPermissions\(\)/);
  assert.match(grantedCheck, /requiresNearbyWifiPermission\(\)/);
  assert.match(grantedCheck, /Manifest\.permission\.NEARBY_WIFI_DEVICES/);
});
