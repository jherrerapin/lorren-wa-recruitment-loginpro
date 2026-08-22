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

test('Nearby de cuadrilla declara permisos requeridos y desugaring sin encender Wi-Fi desde Lórren', async () => {
  const [manifest, mainActivity, gradle] = await Promise.all([
    read('app/src/main/AndroidManifest.xml'),
    read('app/src/main/java/com/loginpro/lorren/portal/MainActivity.java'),
    read('app/build.gradle')
  ]);

  assert.match(manifest, /android\.permission\.ACCESS_WIFI_STATE/);
  assert.match(manifest, /android\.permission\.CHANGE_WIFI_STATE/);
  assert.match(manifest, /android\.permission\.NEARBY_WIFI_DEVICES/);
  assert.doesNotMatch(manifest, /BLUETOOTH_SCAN[^>]*neverForLocation/);
  assert.match(manifest, /android\.permission\.ACCESS_COARSE_LOCATION/);
  assert.match(manifest, /android\.permission\.ACCESS_FINE_LOCATION/);
  assert.match(manifest, /android\.permission\.BLUETOOTH_SCAN/);
  assert.match(manifest, /android\.permission\.BLUETOOTH_CONNECT/);
  assert.match(manifest, /android\.permission\.BLUETOOTH_ADVERTISE/);
  assert.match(manifest, /android\.hardware\.bluetooth_le/);

  const bluetoothGroup = methodBody(
    mainActivity,
    'private boolean hasNearbyBluetoothPermissions()',
    'private void addNearbyBluetoothPermissionsIfNeeded'
  );
  for (const permission of ['BLUETOOTH_SCAN', 'BLUETOOTH_CONNECT', 'BLUETOOTH_ADVERTISE']) {
    assert.match(bluetoothGroup, new RegExp(`Manifest\\.permission\\.${permission}`));
  }

  const wifiGroup = methodBody(
    mainActivity,
    'private boolean hasNearbyWifiPermission()',
    'private void addNearbyWifiPermissionIfNeeded'
  );
  assert.match(wifiGroup, /Manifest\.permission\.NEARBY_WIFI_DEVICES/);

  const attendancePermissions = methodBody(
    mainActivity,
    'private List<String> attendancePermissions(boolean includeCamera)',
    'private BluetoothAdapter bluetoothAdapter()'
  );
  assert.match(attendancePermissions, /addPreciseLocationPermissionsIfNeeded\(missing\)/);
  assert.match(attendancePermissions, /addNearbyBluetoothPermissionsIfNeeded\(missing\)/);
  assert.match(attendancePermissions, /addNearbyWifiPermissionIfNeeded\(missing\)/);

  const grantedCheck = methodBody(
    mainActivity,
    'private boolean nearbyPermissionsGranted()',
    'void emitPresenceEvent(JSONObject event)'
  );
  assert.match(grantedCheck, /hasPreciseLocationPermission\(\)/);
  assert.match(grantedCheck, /hasNearbyBluetoothPermissions\(\)/);
  assert.match(grantedCheck, /hasNearbyWifiPermission\(\)/);
  assert.doesNotMatch(mainActivity, /WifiManager|setWifiEnabled|startLocalOnlyHotspot/);

  assert.match(gradle, /play-services-nearby:19\.4\.0/);
  assert.match(gradle, /coreLibraryDesugaringEnabled true/);
  assert.match(gradle, /coreLibraryDesugaring 'com\.android\.tools:desugar_jdk_libs:2\.1\.5'/);
});
