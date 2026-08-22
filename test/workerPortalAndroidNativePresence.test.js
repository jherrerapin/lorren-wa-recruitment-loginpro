import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../mobile/android/', import.meta.url);

function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

test('Android privado reutiliza el Portal y BLE nativo sin introducir un escritor de asistencia', async () => {
  const [
    rootBuild,
    appBuild,
    manifest,
    mainActivity,
    bridge,
    presenceManager,
    keyStore,
    nativePresence,
    ignore
  ] = await Promise.all([
    read('build.gradle'),
    read('app/build.gradle'),
    read('app/src/main/AndroidManifest.xml'),
    read('app/src/main/java/com/loginpro/lorren/portal/MainActivity.java'),
    read('app/src/main/java/com/loginpro/lorren/portal/PresenceBridge.java'),
    read('app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java'),
    read('app/src/main/java/com/loginpro/lorren/portal/DeviceKeyStore.java'),
    read('app/src/main/assets/native-presence.js'),
    read('.gitignore')
  ]);

  assert.match(rootBuild, /com\.android\.application[^\n]*version '9\.3\.0'/);
  assert.match(appBuild, /compileSdk 37/);
  assert.match(appBuild, /targetSdk 36/);
  assert.match(appBuild, /minSdk 26/);
  assert.match(appBuild, /lorrenPortalBaseUrl/);
  assert.match(appBuild, /https:\/\/example\.invalid/);
  assert.doesNotMatch(appBuild, /play-services-nearby|loginpro\.(com|co)|railway\.app|railway\.com/i);

  for (const permission of [
    'ACCESS_COARSE_LOCATION',
    'ACCESS_FINE_LOCATION',
    'BLUETOOTH_ADVERTISE',
    'BLUETOOTH_CONNECT',
    'BLUETOOTH_SCAN'
  ]) {
    assert.match(manifest, new RegExp(`android\\.permission\\.${permission}`));
  }
  assert.doesNotMatch(manifest, /android\.permission\.(?:ACCESS_WIFI_STATE|CHANGE_WIFI_STATE|NEARBY_WIFI_DEVICES)/);
  assert.doesNotMatch(manifest, /BLUETOOTH_SCAN[^>]*neverForLocation/);
  assert.match(manifest, /android\.hardware\.bluetooth_le/);
  assert.match(manifest, /android:usesCleartextTraffic="false"/);
  assert.match(manifest, /android:scheme="lorren"/);
  assert.match(manifest, /android:host="portal"/);
  assert.match(manifest, /android:pathPrefix="\/transferencia"/);

  assert.match(mainActivity, /PresenceBridge\.JS_NAME/);
  assert.match(mainActivity, /\/operaciones\/portal\/sesion-transferencia\/continuar/);
  assert.match(mainActivity, /Uri\.encode\(token\.trim\(\)\)/);
  assert.match(mainActivity, /setMixedContentMode\(WebSettings\.MIXED_CONTENT_NEVER_ALLOW\)/);
  assert.match(mainActivity, /setAllowFileAccess\(false\)/);
  assert.match(mainActivity, /setAcceptThirdPartyCookies\(webView, false\)/);
  assert.match(mainActivity, /NATIVE_USER_AGENT_TOKEN = "LorrenNative\/1"/);
  assert.doesNotMatch(mainActivity, /Log\.[vdiew]|System\.out|System\.err/);

  assert.match(mainActivity, /attendancePermissions\(true\)/);
  assert.match(mainActivity, /addPreciseLocationPermissionsIfNeeded\(missing\)/);
  assert.match(mainActivity, /Manifest\.permission\.BLUETOOTH_SCAN/);
  assert.match(mainActivity, /Manifest\.permission\.BLUETOOTH_CONNECT/);
  assert.match(mainActivity, /Manifest\.permission\.BLUETOOTH_ADVERTISE/);
  assert.doesNotMatch(mainActivity, /NEARBY_WIFI_DEVICES|requiresNearbyWifiPermission/);
  assert.match(mainActivity, /BluetoothAdapter\.ACTION_REQUEST_ENABLE/);
  assert.match(mainActivity, /"bluetooth_unavailable"/);
  assert.match(mainActivity, /"bluetooth_disabled"/);
  assert.match(mainActivity, /nearbyPermissionsGranted\(\)[\s\S]{0,220}hasPreciseLocationPermission\(\)[\s\S]{0,120}hasNearbyBluetoothPermissions\(\)/);

  assert.match(keyStore, /AndroidKeyStore/);
  assert.match(keyStore, /secp256r1/);
  assert.match(keyStore, /SHA256withECDSA/);
  assert.match(keyStore, /setUserAuthenticationRequired\(false\)/);
  assert.doesNotMatch(keyStore, /encodeToString\([^\n]*getPrivate|privateKey\.getEncoded|getPrivate\(\)\.getEncoded/);

  assert.match(presenceManager, /BluetoothLeAdvertiser/);
  assert.match(presenceManager, /BluetoothLeScanner/);
  assert.match(presenceManager, /BluetoothGattServer/);
  assert.match(presenceManager, /openGattServer\(appContext, gattServerCallback\)/);
  assert.match(presenceManager, /AdvertiseCallback[\s\S]{0,800}onStartSuccess/);
  assert.match(presenceManager, /ScanFilter\.Builder\(\)[\s\S]{0,140}setServiceUuid\(new ParcelUuid\(SERVICE_UUID\)\)/);
  assert.match(presenceManager, /setScanMode\(ScanSettings\.SCAN_MODE_LOW_LATENCY\)/);
  assert.match(presenceManager, /connectGatt\([\s\S]{0,200}BluetoothDevice\.TRANSPORT_LE/);
  assert.match(presenceManager, /startReady\(String serviceRequestId\)[\s\S]{0,260}startReadyScanner\(true\)/);
  assert.match(presenceManager, /startReadyScanner\(boolean emitReady\)[\s\S]{0,500}getBluetoothLeScanner\(\)/);
  assert.match(presenceManager, /startLeaderScan\(JSONObject input\)[\s\S]{0,2200}getBluetoothLeAdvertiser\(\)/);
  assert.match(presenceManager, /isMultipleAdvertisementSupported\(\)/);
  assert.match(presenceManager, /"attemptId"/);
  assert.match(presenceManager, /"serviceRequestId"/);
  assert.match(presenceManager, /"challenge"/);
  assert.match(presenceManager, /"signature"/);
  assert.match(presenceManager, /DeviceKeyStore\.signBase64/);
  assert.match(presenceManager, /DeviceKeyStore\.verifyBase64/);
  assert.match(presenceManager, /proofsByKey/);
  assert.doesNotMatch(presenceManager, /com\.google\.android\.gms\.nearby|ConnectionsClient|Strategy\.P2P_/);
  assert.doesNotMatch(presenceManager, /WifiManager|setWifiEnabled|NEARBY_WIFI_DEVICES/);

  assert.match(bridge, /JS_NAME = "LorrenAndroidPresence"/);
  assert.match(bridge, /"attendanceWriter", false/);
  assert.match(bridge, /setReady\(/);
  assert.match(bridge, /startCrewScan\(/);
  assert.match(bridge, /getProofBundle\(/);
  assert.match(bridge, /manager\.startReady/);
  assert.match(bridge, /manager\.startLeaderScan/);

  assert.match(nativePresence, /Marcación de cuadrilla/);
  assert.match(nativePresence, /Marcar entrada de la cuadrilla/);
  assert.match(nativePresence, /Iniciar almuerzo de la cuadrilla/);
  assert.match(nativePresence, /Finalizar almuerzo de la cuadrilla/);
  assert.match(nativePresence, /Registrar salida de la cuadrilla/);
  assert.match(nativePresence, /queueCrewPresence/);
  assert.doesNotMatch(nativePresence, /\/llegada|\/salida|inicio-almuerzo|fin-almuerzo|registerDispatchArrival|registerCrewArrivalForLeader/);
  assert.doesNotMatch(nativePresence, /alert\s*\(|confirm\s*\(|prompt\s*\(/);

  for (const pattern of ['*.jks', '*.keystore', '*.apk', '*.aab']) {
    assert.ok(ignore.includes(pattern), `falta ignorar ${pattern}`);
  }
});

test('auxiliar queda listo por visibilidad y confirmación nativa, sin depender del foco del WebView', async () => {
  const nativePresence = await read('app/src/main/assets/native-presence.js');
  const memberStatus = nativePresence.match(
    /function memberStatus\(context, member, markType\) \{([\s\S]*?)\n  \}\n\n  function expectedAuxiliaryProofCount/
  );
  const ensureReady = nativePresence.match(
    /async function ensureAuxiliaryReady\(forceRestart = false\) \{([\s\S]*?)\n  \}\n\n  async function startReady/
  );
  const startReady = nativePresence.match(
    /async function startReady\(\) \{([\s\S]*?)\n  \}\n\n  async function startLeaderScan/
  );

  assert.ok(memberStatus, 'no se encontró la autoridad memberStatus');
  assert.ok(ensureReady, 'no se encontró ensureAuxiliaryReady');
  assert.ok(startReady, 'no se encontró startReady');
  assert.match(memberStatus[1], /if \(member\.isLeader\) return 'LEADER_DEVICE';/);
  assert.match(nativePresence, /status === 'LEADER_DEVICE'[\s\S]{0,120}label: 'Este teléfono'/);
  assert.match(ensureReady[1], /document\.visibilityState === 'hidden'/);
  assert.doesNotMatch(ensureReady[1], /document\.hasFocus/);
  assert.match(ensureReady[1], /forceRestart && \['PREPARING', 'READY'\]\.includes\(activeMode\)[\s\S]{0,120}bridgeCall\('stopReady'\)/);
  assert.match(startReady[1], /activeMode = 'PREPARING'/);
  assert.match(startReady[1], /bridgeCall\('setReady'/);
  assert.doesNotMatch(startReady[1], /activeMode = 'READY'/);
  assert.match(nativePresence, /if \(type === 'ready'\)[\s\S]{0,220}activeMode = 'READY'/);
  assert.match(nativePresence, /Bluetooth listo\. Esperando la marcación del encargado\./);
  assert.match(nativePresence, /window\.addEventListener\('focus', scheduleAuxiliaryRearm\)/);
  assert.match(nativePresence, /visibilityState === 'visible'[\s\S]{0,120}scheduleAuxiliaryRearm\(\)/);
});

test('sin contexto de cuadrilla el módulo nativo no tapa ni reemplaza el Portal individual', async () => {
  const nativePresence = await read('app/src/main/assets/native-presence.js');
  const renderPanel = nativePresence.match(/function renderPanel\(\) \{([\s\S]*?)\n  \}\n\n  function insertPanel/);

  assert.ok(renderPanel, 'no se encontró la autoridad renderPanel');
  assert.match(renderPanel[1], /if \(!contexts\.length\) return;/);
  assert.match(nativePresence, /function hideIndividualCrewMarks\(\)/);
  assert.match(nativePresence, /if \(!context\?\.isCrewLeader\) return;/);
});

test('advertisement BLE no publica PII ni usa la dirección Bluetooth como identidad de trabajador', async () => {
  const presenceManager = await read('app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java');

  assert.match(presenceManager, /AdvertiseData\.Builder\(\)[\s\S]{0,180}addServiceUuid\(new ParcelUuid\(SERVICE_UUID\)\)/);
  assert.match(presenceManager, /setIncludeDeviceName\(false\)/);
  assert.match(presenceManager, /setIncludeTxPowerLevel\(false\)/);
  assert.doesNotMatch(presenceManager, /fullName|workerName|documentNumber|phoneNumber/i);
  assert.match(presenceManager, /keyId\(publicKey\)/);
  assert.match(presenceManager, /proofsByKey\.put\(keyId, stored\)/);
  assert.doesNotMatch(presenceManager, /proofsByKey\.put\([^\n]*(?:address|getAddress)/);
});

test('BLE solo transporta la prueba; servidor y cola siguen siendo autoridades de asistencia', async () => {
  const [nativePresence, bridge, presenceManager] = await Promise.all([
    read('app/src/main/assets/native-presence.js'),
    read('app/src/main/java/com/loginpro/lorren/portal/PresenceBridge.java'),
    read('app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java')
  ]);
  const nativeCode = `${bridge}\n${presenceManager}`;

  assert.doesNotMatch(nativeCode, /prisma|DispatchAttendanceMark|DispatchAttendanceSession/);
  assert.match(bridge, /"attendanceWriter", false/);
  assert.match(presenceManager, /"lorren-presence-v1\\n"/);
  assert.match(presenceManager, /DeviceKeyStore\.signBase64\(canonical\)/);
  assert.match(presenceManager, /DeviceKeyStore\.verifyBase64\(publicKey, canonical, signature\)/);
  assert.match(nativePresence, /offline\.queueCrewPresence/);
  assert.doesNotMatch(nativePresence, /fetch\([^\n]*(?:llegada|salida|almuerzo)/i);
});
