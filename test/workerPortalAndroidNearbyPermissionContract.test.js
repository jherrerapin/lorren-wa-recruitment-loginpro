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

test('presencia Bluetooth Classic separa permisos de transporte, Wi-Fi y geocerca con compatibilidad por versión', async () => {
  const [manifest, mainActivity, manager, gradle] = await Promise.all([
    read('app/src/main/AndroidManifest.xml'),
    read('app/src/main/java/com/loginpro/lorren/portal/MainActivity.java'),
    read('app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java'),
    read('app/build.gradle')
  ]);

  // Las declaraciones Wi-Fi históricas se conservan temporalmente por rollback,
  // pero ya no forman parte del gate runtime de presencia.
  assert.match(manifest, /android\.permission\.ACCESS_WIFI_STATE/);
  assert.match(manifest, /android\.permission\.CHANGE_WIFI_STATE/);
  assert.match(manifest, /android\.permission\.NEARBY_WIFI_DEVICES/);
  assert.doesNotMatch(manifest, /BLUETOOTH_SCAN[^>]*neverForLocation/);
  assert.match(manifest, /android\.permission\.ACCESS_COARSE_LOCATION/);
  assert.match(manifest, /android\.permission\.ACCESS_FINE_LOCATION/);
  assert.match(manifest, /android\.permission\.BLUETOOTH_SCAN/);
  assert.match(manifest, /android\.permission\.BLUETOOTH_CONNECT/);
  assert.match(manifest, /android\.permission\.BLUETOOTH_ADVERTISE/);

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

  const transportPermissions = methodBody(
    mainActivity,
    'private List<String> nearbyTransportPermissions()',
    'private boolean nearbyTransportPermissionsGranted()'
  );
  assert.match(transportPermissions, /addNearbyLegacyLocationPermissionIfNeeded\(missing\)/);
  assert.match(transportPermissions, /addNearbyBluetoothPermissionsIfNeeded\(missing\)/);
  assert.doesNotMatch(transportPermissions, /Wifi|WIFI|NEARBY_WIFI_DEVICES/);
  assert.doesNotMatch(transportPermissions, /attendancePermissions/);

  const transportGranted = methodBody(
    mainActivity,
    'private boolean nearbyTransportPermissionsGranted()',
    'private List<String> attendancePermissions(boolean includeCamera)'
  );
  assert.match(transportGranted, /hasNearbyLegacyLocationPermission\(\)/);
  assert.match(transportGranted, /hasNearbyBluetoothPermissions\(\)/);
  assert.doesNotMatch(transportGranted, /Wifi|WIFI|NEARBY_WIFI_DEVICES/);

  assert.doesNotMatch(mainActivity, /hasNearbyWifiPermission|addNearbyWifiPermissionIfNeeded/);
  assert.doesNotMatch(mainActivity, /Manifest\.permission\.NEARBY_WIFI_DEVICES/);

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

  const discoverableGate = methodBody(
    mainActivity,
    'boolean ensureNearbyDiscoverable()',
    'private String[] locationRuntimePermissions()'
  );
  assert.match(discoverableGate, /BluetoothAdapter\.SCAN_MODE_CONNECTABLE_DISCOVERABLE/);
  assert.match(discoverableGate, /requestBluetoothDiscoverable\(\)/);
  assert.match(mainActivity, /BluetoothAdapter\.ACTION_REQUEST_DISCOVERABLE/);
  assert.match(mainActivity, /BluetoothAdapter\.EXTRA_DISCOVERABLE_DURATION/);
  assert.match(mainActivity, /BLUETOOTH_DISCOVERABLE_SECONDS = 300/);

  const attendancePermissions = methodBody(
    mainActivity,
    'private List<String> attendancePermissions(boolean includeCamera)',
    'private BluetoothAdapter bluetoothAdapter()'
  );
  assert.match(attendancePermissions, /addPreciseLocationPermissionsIfNeeded\(missing\)/);
  assert.match(attendancePermissions, /missing\.addAll\(nearbyTransportPermissions\(\)\)/);

  assert.match(manager, /BluetoothServerSocket/);
  assert.match(manager, /BluetoothSocket/);
  assert.match(manager, /listenUsingInsecureRfcommWithServiceRecord/);
  assert.match(manager, /createInsecureRfcommSocketToServiceRecord/);
  assert.match(manager, /startDiscovery\(\)/);
  assert.match(manager, /fetchUuidsWithSdp\(\)/);
  assert.doesNotMatch(manager, /BluetoothLeAdvertiser|BluetoothGatt|Nearby\.getConnectionsClient|ConnectionsClient|WifiManager|setWifiEnabled|startLocalOnlyHotspot/);
  assert.doesNotMatch(mainActivity, /WifiManager|setWifiEnabled|startLocalOnlyHotspot/);

  // La dependencia de Play Services queda declarada por rollback, pero ya no tiene
  // importador en la autoridad runtime de presencia de esta rama.
  assert.match(gradle, /play-services-nearby:19\.4\.0/);
  assert.match(gradle, /coreLibraryDesugaringEnabled true/);
  assert.match(gradle, /coreLibraryDesugaring 'com\.android\.tools:desugar_jdk_libs:2\.1\.5'/);
});