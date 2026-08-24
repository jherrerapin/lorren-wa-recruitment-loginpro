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

test('Nearby de cuadrilla separa permisos de transporte y geocerca, con compatibilidad por versión', async () => {
  const [manifest, mainActivity, gradle, presenceManager] = await Promise.all([
    read('app/src/main/AndroidManifest.xml'),
    read('app/src/main/java/com/loginpro/lorren/portal/MainActivity.java'),
    read('app/build.gradle'),
    read('app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java')
  ]);

  assert.match(manifest, /android\.permission\.ACCESS_WIFI_STATE/);
  assert.match(manifest, /android\.permission\.CHANGE_WIFI_STATE/);
  assert.doesNotMatch(
    manifest,
    /android:maxSdkVersion="31"\s+android:name="android\.permission\.(?:ACCESS_WIFI_STATE|CHANGE_WIFI_STATE)"/
  );
  assert.match(
    manifest,
    /android:minSdkVersion="33"\s+android:name="android\.permission\.NEARBY_WIFI_DEVICES"/
  );
  assert.doesNotMatch(
    manifest,
    /android:minSdkVersion="32"\s+android:name="android\.permission\.NEARBY_WIFI_DEVICES"/
  );
  assert.doesNotMatch(manifest, /BLUETOOTH_SCAN[^>]*neverForLocation/);
  assert.match(manifest, /android\.permission\.ACCESS_COARSE_LOCATION/);
  assert.match(manifest, /android\.permission\.ACCESS_FINE_LOCATION/);
  assert.match(manifest, /android\.permission\.BLUETOOTH_SCAN/);
  assert.match(manifest, /android\.permission\.BLUETOOTH_CONNECT/);
  assert.match(manifest, /android\.permission\.BLUETOOTH_ADVERTISE/);
  assert.match(manifest, /android\.hardware\.bluetooth_le/);

  const legacyLocationGranted = methodBody(
    mainActivity,
    'private boolean hasNearbyLegacyLocationPermission()',
    'private void addNearbyLegacyLocationPermissionIfNeeded'
  );
  assert.match(legacyLocationGranted, /Build\.VERSION\.SDK_INT > Build\.VERSION_CODES\.S/);
  assert.match(legacyLocationGranted, /Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.Q[\s\S]{0,80}hasPreciseLocationPermission\(\)/);
  assert.match(legacyLocationGranted, /Manifest\.permission\.ACCESS_COARSE_LOCATION/);

  const legacyLocationRequest = methodBody(
    mainActivity,
    'private void addNearbyLegacyLocationPermissionIfNeeded',
    'private boolean hasNearbyBluetoothPermissions()'
  );
  assert.match(legacyLocationRequest, /Build\.VERSION\.SDK_INT > Build\.VERSION_CODES\.S/);
  assert.match(legacyLocationRequest, /Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.Q/);
  assert.match(legacyLocationRequest, /addPreciseLocationPermissionsIfNeeded\(permissions\)/);
  assert.match(legacyLocationRequest, /Manifest\.permission\.ACCESS_COARSE_LOCATION/);

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
  assert.match(wifiGroup, /Build\.VERSION\.SDK_INT < Build\.VERSION_CODES\.TIRAMISU/);
  assert.match(wifiGroup, /Manifest\.permission\.NEARBY_WIFI_DEVICES/);

  const transportPermissions = methodBody(
    mainActivity,
    'private List<String> nearbyTransportPermissions()',
    'private boolean nearbyTransportPermissionsGranted()'
  );
  assert.match(transportPermissions, /addNearbyLegacyLocationPermissionIfNeeded\(missing\)/);
  assert.match(transportPermissions, /addNearbyBluetoothPermissionsIfNeeded\(missing\)/);
  assert.match(transportPermissions, /addNearbyWifiPermissionIfNeeded\(missing\)/);
  assert.doesNotMatch(transportPermissions, /attendancePermissions/);

  const transportGranted = methodBody(
    mainActivity,
    'private boolean nearbyTransportPermissionsGranted()',
    'private List<String> attendancePermissions(boolean includeCamera)'
  );
  assert.match(transportGranted, /hasNearbyLegacyLocationPermission\(\)/);
  assert.match(transportGranted, /hasNearbyBluetoothPermissions\(\)/);
  assert.match(transportGranted, /hasNearbyWifiPermission\(\)/);

  const ensureNearby = methodBody(
    mainActivity,
    'boolean ensureNearbyPermissions()',
    'boolean ensureAttendanceLocationPermission()'
  );
  assert.match(ensureNearby, /nearbyTransportPermissions\(\)/);
  assert.doesNotMatch(ensureNearby, /attendancePermissions/);

  const ensureAttendanceLocation = methodBody(
    mainActivity,
    'boolean ensureAttendanceLocationPermission()',
    'String ensureNearbyRadioReady()'
  );
  assert.match(ensureAttendanceLocation, /hasPreciseLocationPermission\(\)/);
  assert.match(ensureAttendanceLocation, /locationRuntimePermissions\(\)/);
  assert.match(ensureAttendanceLocation, /REQUEST_ATTENDANCE_LOCATION/);

  const attendancePermissions = methodBody(
    mainActivity,
    'private List<String> attendancePermissions(boolean includeCamera)',
    'private BluetoothAdapter bluetoothAdapter()'
  );
  assert.match(attendancePermissions, /addPreciseLocationPermissionsIfNeeded\(missing\)/);
  assert.match(attendancePermissions, /missing\.addAll\(nearbyTransportPermissions\(\)\)/);

  const balancedPolicies = presenceManager.match(/ConnectionType\.BALANCED/g) || [];
  assert.equal(balancedPolicies.length, 2, 'advertising y conexión deben permitir que Nearby gestione el medio local necesario');
  assert.match(presenceManager, /AdvertisingOptions\.Builder\(\)[\s\S]{0,220}setConnectionType\(ConnectionType\.BALANCED\)/);
  assert.match(presenceManager, /ConnectionOptions\.Builder\(\)[\s\S]{0,180}setConnectionType\(ConnectionType\.BALANCED\)/);
  assert.doesNotMatch(presenceManager, /ConnectionType\.(?:NON_DISRUPTIVE|DISRUPTIVE)/);
  assert.match(presenceManager, /Strategy\.P2P_CLUSTER/);
  assert.match(presenceManager, /setLowPower\(false\)/);

  assert.doesNotMatch(mainActivity, /WifiManager|setWifiEnabled|startLocalOnlyHotspot/);
  assert.match(gradle, /play-services-nearby:19\.4\.0/);
  assert.match(gradle, /coreLibraryDesugaringEnabled true/);
  assert.match(gradle, /coreLibraryDesugaring 'com\.android\.tools:desugar_jdk_libs:2\.1\.5'/);
});
