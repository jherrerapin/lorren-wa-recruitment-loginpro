import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../mobile/android/', import.meta.url);

function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

test('Android privado reutiliza el Portal y una sola autoridad BLE nativa sin introducir escritor de asistencia', async () => {
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
  assert.doesNotMatch(appBuild, /loginpro\.(com|co)|railway\.app|railway\.com/i);

  for (const permission of [
    'ACCESS_COARSE_LOCATION',
    'ACCESS_FINE_LOCATION',
    'BLUETOOTH_ADVERTISE',
    'BLUETOOTH_CONNECT',
    'BLUETOOTH_SCAN'
  ]) {
    assert.match(manifest, new RegExp(`android\\.permission\\.${permission}`));
  }
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
  assert.match(mainActivity, /hasNearbyLegacyLocationPermission\(\)/);
  assert.match(mainActivity, /addNearbyLegacyLocationPermissionIfNeeded\(missing\)/);
  assert.match(mainActivity, /Manifest\.permission\.BLUETOOTH_SCAN/);
  assert.match(mainActivity, /Manifest\.permission\.BLUETOOTH_CONNECT/);
  assert.match(mainActivity, /Manifest\.permission\.BLUETOOTH_ADVERTISE/);
  assert.doesNotMatch(mainActivity, /Manifest\.permission\.NEARBY_WIFI_DEVICES/);
  assert.doesNotMatch(mainActivity, /hasNearbyWifiPermission|addNearbyWifiPermissionIfNeeded/);
  assert.match(mainActivity, /BluetoothAdapter\.ACTION_REQUEST_ENABLE/);
  assert.match(mainActivity, /"bluetooth_unavailable"/);
  assert.match(mainActivity, /"bluetooth_disabled"/);
  assert.match(mainActivity, /nearbyTransportPermissionsGranted\(\)[\s\S]{0,180}hasNearbyLegacyLocationPermission\(\)[\s\S]{0,100}hasNearbyBluetoothPermissions\(\)/);
  assert.doesNotMatch(mainActivity, /nearbyTransportPermissionsGranted\(\)[\s\S]{0,220}hasNearbyWifiPermission/);
  assert.match(mainActivity, /ensureAttendanceLocationPermission\(\)[\s\S]{0,180}hasPreciseLocationPermission\(\)[\s\S]{0,180}REQUEST_ATTENDANCE_LOCATION/);

  assert.match(keyStore, /AndroidKeyStore/);
  assert.match(keyStore, /secp256r1/);
  assert.match(keyStore, /SHA256withECDSA/);
  assert.match(keyStore, /setUserAuthenticationRequired\(false\)/);
  assert.doesNotMatch(keyStore, /encodeToString\([^\n]*getPrivate|privateKey\.getEncoded|getPrivate\(\)\.getEncoded/);

  assert.match(presenceManager, /BluetoothLeScanner/);
  assert.match(presenceManager, /BluetoothLeAdvertiser/);
  assert.match(presenceManager, /BluetoothGattServer/);
  assert.match(presenceManager, /BluetoothGattCallback/);
  assert.match(presenceManager, /BluetoothDevice\.TRANSPORT_LE/);
  assert.match(presenceManager, /ScanSettings\.SCAN_MODE_LOW_LATENCY/);
  assert.match(presenceManager, /AdvertiseSettings\.ADVERTISE_MODE_LOW_LATENCY/);
  assert.match(presenceManager, /AdvertiseSettings\.ADVERTISE_TX_POWER_HIGH/);
  assert.match(presenceManager, /setConnectable\(true\)/);
  assert.match(presenceManager, /SERVICE_PARCEL_UUID/);
  assert.doesNotMatch(presenceManager, /Nearby\.getConnectionsClient|ConnectionsClient|Strategy\.P2P_|ConnectionType\.|setLowPower\(/);
  assert.doesNotMatch(presenceManager, /WifiManager|setWifiEnabled|startLocalOnlyHotspot/);
  assert.match(presenceManager, /"attemptId"/);
  assert.match(presenceManager, /"serviceRequestId"/);
  assert.match(presenceManager, /"challenge"/);
  assert.match(presenceManager, /"signature"/);
  assert.match(presenceManager, /DeviceKeyStore\.signBase64/);
  assert.match(presenceManager, /DeviceKeyStore\.verifyBase64/);
  assert.match(presenceManager, /proofsByKey/);

  assert.match(bridge, /JS_NAME = "LorrenAndroidPresence"/);
  assert.match(bridge, /"attendanceWriter", false/);
  assert.match(bridge, /"presenceCredentialReady", hasUsablePresenceCredential\(\)/);
  assert.match(bridge, /setReady\(/);
  assert.match(bridge, /startCrewScan\(/);
  assert.match(bridge, /getProofBundle\(/);
  assert.match(bridge, /manager\.startReady/);
  assert.match(bridge, /manager\.startLeaderScan/);
  assert.match(bridge, /startCrewScan\(String inputJson\)[\s\S]{0,260}activity\.ensureAttendanceLocationPermission\(\)/);
  assert.match(bridge, /requestAttendanceLocation\(String inputJson\)[\s\S]{0,260}activity\.ensureAttendanceLocationPermission\(\)/);

  assert.match(nativePresence, /Marcación de cuadrilla/);
  assert.match(nativePresence, /Marcar entrada de la cuadrilla/);
  assert.match(nativePresence, /Iniciar almuerzo de la cuadrilla/);
  assert.match(nativePresence, /Finalizar almuerzo de la cuadrilla/);
  assert.match(nativePresence, /Registrar salida de la cuadrilla/);
  assert.match(nativePresence, /const DEFAULT_SCAN_MS = 15_000/);
  assert.match(nativePresence, /queueCrewPresence/);
  assert.doesNotMatch(nativePresence, /\/llegada|\/salida|inicio-almuerzo|fin-almuerzo|registerDispatchArrival|registerCrewArrivalForLeader/);
  assert.doesNotMatch(nativePresence, /alert\s*\(|confirm\s*\(|prompt\s*\(/);

  for (const pattern of ['*.jks', '*.keystore', '*.apk', '*.aab']) {
    assert.ok(ignore.includes(pattern), `falta ignorar ${pattern}`);
  }
});

test('auxiliar queda listo por visibilidad con scan BLE activo y sin depender de WAN ni foco del WebView', async () => {
  const [nativePresence, presenceManager] = await Promise.all([
    read('app/src/main/assets/native-presence.js'),
    read('app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java')
  ]);
  const memberStatus = nativePresence.match(
    /function memberStatus\(context, member, markType\) \{([\s\S]*?)\n  \}\n\n  function expectedAuxiliaryProofCount/
  );
  const ensureReady = nativePresence.match(
    /async function ensureAuxiliaryReady\(forceRestart = false\) \{([\s\S]*?)\n  \}\n\n  async function startReady/
  );
  const startReady = nativePresence.match(
    /async function startReady\(\) \{([\s\S]*?)\n  \}\n\n  async function startLeaderScan/
  );
  const onlineHandler = nativePresence.match(
    /window\.addEventListener\('online', async \(\) => \{([\s\S]*?)\n  \}\);\n  window\.addEventListener\('offline'/
  );
  const offlineHandler = nativePresence.match(
    /window\.addEventListener\('offline', \(\) => \{([\s\S]*?)\n  \}\);\n  window\.addEventListener\('focus'/
  );

  assert.ok(memberStatus);
  assert.ok(ensureReady);
  assert.ok(startReady);
  assert.ok(onlineHandler);
  assert.ok(offlineHandler);
  assert.match(memberStatus[1], /if \(member\.isLeader\) return 'LEADER_DEVICE';/);
  assert.match(nativePresence, /status === 'LEADER_DEVICE'[\s\S]{0,120}label: 'Este teléfono'/);
  assert.match(ensureReady[1], /document\.visibilityState === 'hidden'/);
  assert.doesNotMatch(ensureReady[1], /document\.hasFocus/);
  assert.match(startReady[1], /activeMode = 'PREPARING'/);
  assert.match(startReady[1], /navigator\.onLine && !credentialPrepared\(\)[\s\S]{0,80}provisionCredential\(\)/);
  assert.doesNotMatch(startReady[1], /if \(!navigator\.onLine\)[\s\S]{0,180}return/);
  assert.match(startReady[1], /bridgeCall\('setReady'/);
  assert.doesNotMatch(startReady[1], /activeMode = 'READY'/);
  assert.match(nativePresence, /if \(type === 'ready'\)[\s\S]{0,420}activeMode = 'READY'/);
  assert.match(nativePresence, /Bluetooth listo\. Esperando la marcación del encargado\./);
  assert.match(presenceManager, /startReadyScanner\(true\)/);
  assert.match(presenceManager, /getBluetoothLeScanner\(\)/);
  assert.match(presenceManager, /readyScanner\.startScan\([\s\S]{0,260}readyScanSettings\(\)[\s\S]{0,200}auxiliaryScanCallback/);
  assert.match(presenceManager, /emitDiagnostic\("AUX", "DISCOVERY_READY"\)[\s\S]{0,100}emitReady\(\)/);
  assert.match(onlineHandler[1], /ensureAuxiliaryReady\(\)/);
  assert.match(offlineHandler[1], /ensureAuxiliaryReady\(\)/);
  assert.doesNotMatch(onlineHandler[1], /scheduleAuxiliaryRearm|stopReady/);
  assert.doesNotMatch(offlineHandler[1], /scheduleAuxiliaryRearm|stopReady/);
});

test('replay físico: el botón no destruye READY y BLE tiene watchdogs acotados y cola global de notificaciones', async () => {
  const [nativePresence, presenceManager] = await Promise.all([
    read('app/src/main/assets/native-presence.js'),
    read('app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java')
  ]);

  const prepareBlock = nativePresence.match(
    /const prepare = element\([\s\S]*?actions\.appendChild\(prepare\);/
  );
  assert.ok(prepareBlock, 'falta acción manual del auxiliar');
  assert.match(prepareBlock[0], /prepare\.disabled = \['PREPARING', 'READY'\]\.includes\(activeMode\)/);
  assert.match(prepareBlock[0], /if \(\['PREPARING', 'READY'\]\.includes\(activeMode\)\) return;/);
  assert.match(prepareBlock[0], /ensureAuxiliaryReady\(\)/);
  assert.doesNotMatch(prepareBlock[0], /ensureAuxiliaryReady\(true\)/);

  assert.match(presenceManager, /LEADER_START_TIMEOUT_MS = 25_000L/);
  assert.match(presenceManager, /AUXILIARY_EXCHANGE_TIMEOUT_MS = 12_000L/);
  assert.match(presenceManager, /scheduleAuxiliaryExchangeTimeout\(gatt\)/);
  assert.match(presenceManager, /handler\.postDelayed\(auxiliaryExchangeTimeout, AUXILIARY_EXCHANGE_TIMEOUT_MS\)/);
  assert.match(presenceManager, /cancelAuxiliaryExchangeTimeout\(\)/);
  assert.match(presenceManager, /BluetoothDevice\.TRANSPORT_LE/);
  assert.match(presenceManager, /requestConnectionPriority\(BluetoothGatt\.CONNECTION_PRIORITY_HIGH\)/);
  assert.match(presenceManager, /requestMtu\(REQUESTED_MTU\)/);
  assert.match(presenceManager, /SERVICE_DISCOVERY_FALLBACK_MS = 700L/);

  assert.match(presenceManager, /Deque<PendingNotification> leaderNotificationQueue = new ArrayDeque<>\(\)/);
  assert.match(presenceManager, /PendingNotification leaderNotificationInFlight/);
  assert.match(presenceManager, /enqueueLeaderChallengeFrames/);
  assert.match(presenceManager, /if \(leaderNotificationInFlight != null\) return/);
  assert.match(presenceManager, /onNotificationSent[\s\S]{0,500}leaderNotificationInFlight = null[\s\S]{0,500}drainLeaderNotificationQueue\(\)/);

  const startSuccess = presenceManager.match(
    /public void onStartSuccess\(AdvertiseSettings settingsInEffect\) \{([\s\S]*?)\n        \}\n\n        @Override\n        public void onStartFailure/
  );
  assert.ok(startSuccess, 'falta callback real de advertising BLE');
  assert.match(startSuccess[1], /cancelLeaderStartTimeout\(\)/);
  assert.match(startSuccess[1], /ADVERTISING_READY/);
  assert.match(startSuccess[1], /scheduleLeaderTimeout\(attemptId, leaderTimeoutMs\)/);
  assert.match(presenceManager, /handler\.postDelayed\(leaderStartTimeout, LEADER_START_TIMEOUT_MS\)/);
});

test('credencial persistida en Android es la autoridad para responder sin Internet', async () => {
  const [bridge, nativePresence] = await Promise.all([
    read('app/src/main/java/com/loginpro/lorren/portal/PresenceBridge.java'),
    read('app/src/main/assets/native-presence.js')
  ]);

  assert.match(bridge, /CREDENTIAL_VERSION = "cp1"/);
  assert.match(bridge, /CREDENTIAL_AUDIENCE = "lorren-crew-presence"/);
  assert.match(bridge, /credentialExpirationMs\(presenceCredential\(\)\)/);
  assert.match(bridge, /payload\.optLong\("exp", 0L\)/);
  assert.match(bridge, /setReady\(String serviceRequestId\)[\s\S]{0,180}!hasUsablePresenceCredential\(\)[\s\S]{0,80}native_presence_credential_required/);
  assert.match(bridge, /startCrewScan\(String inputJson\)[\s\S]{0,180}!hasUsablePresenceCredential\(\)/);
  assert.match(nativePresence, /function credentialPrepared\(\)[\s\S]{0,100}presenceCredentialReady === true/);
  assert.doesNotMatch(nativePresence, /lorren-native-presence-credential-meta-v1|CREDENTIAL_META_KEY|readCredentialMeta|rememberCredential/);
  assert.match(nativePresence, /if \(!navigator\.onLine\) return credentialPrepared\(\);/);
});

test('sin contexto de cuadrilla el módulo nativo no tapa ni reemplaza el Portal individual', async () => {
  const nativePresence = await read('app/src/main/assets/native-presence.js');
  const renderPanel = nativePresence.match(/function renderPanel\(\) \{([\s\S]*?)\n  \}\n\n  function insertPanel/);

  assert.ok(renderPanel, 'no se encontró la autoridad renderPanel');
  assert.match(renderPanel[1], /if \(!contexts\.length\) return;/);
  assert.match(nativePresence, /function hideIndividualCrewMarks\(\)/);
  assert.match(nativePresence, /if \(!context\?\.isCrewLeader\) return;/);
});

test('advertisement BLE del encargado publica solo UUID técnico y no PII', async () => {
  const presenceManager = await read('app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java');

  assert.match(presenceManager, /new AdvertiseData\.Builder\(\)[\s\S]{0,220}addServiceUuid\(SERVICE_PARCEL_UUID\)/);
  assert.match(presenceManager, /setIncludeDeviceName\(false\)/);
  assert.match(presenceManager, /setIncludeTxPowerLevel\(false\)/);
  assert.doesNotMatch(presenceManager, /fullName|workerName|documentNumber|phoneNumber/i);
  assert.match(presenceManager, /keyId\(publicKey\)/);
  assert.match(presenceManager, /proofsByKey\.put\(keyId, stored\)/);
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

test('diagnóstico visible conserva checkpoints sanitizados de ambos roles', async () => {
  const [nativePresence, presenceManager] = await Promise.all([
    read('app/src/main/assets/native-presence.js'),
    read('app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java')
  ]);

  const diagnosticEmitter = presenceManager.match(
    /private void emitDiagnostic\(String actor, String stage, int statusCode, int retryCount\) \{([\s\S]*?)\n    \}\n\n    private void emitError/
  );
  assert.ok(diagnosticEmitter, 'falta emisor diagnóstico nativo sanitizado');
  assert.match(diagnosticEmitter[1], /emit\("diagnostic"/);
  assert.match(diagnosticEmitter[1], /event\.put\("actor", actor\)/);
  assert.match(diagnosticEmitter[1], /event\.put\("stage", stage\)/);
  assert.doesNotMatch(
    diagnosticEmitter[1],
    /address|workerId|serviceRequestId|attemptId|challenge|credential|publicKey|signature/
  );

  for (const stage of [
    'DISCOVERY_START',
    'DISCOVERY_READY',
    'ENDPOINT_FOUND',
    'CONNECTION_REQUEST',
    'CONNECTION_ESTABLISHED',
    'CHALLENGE_RECEIVED',
    'PROOF_DISPATCHED'
  ]) {
    assert.match(presenceManager, new RegExp(`emitDiagnostic\\(\\"AUX\\", \\"${stage}\\"`));
  }
  for (const stage of [
    'ADVERTISING_START',
    'ADVERTISING_READY',
    'CONNECTION_ESTABLISHED',
    'CHALLENGE_DISPATCHED',
    'PROOF_RECEIVED_RAW',
    'PROOF_VERIFIED',
    'SCAN_COMPLETE'
  ]) {
    assert.match(presenceManager, new RegExp(`emitDiagnostic\\(\\"ENC\\", \\"${stage}\\"`));
  }

  assert.match(nativePresence, /const DIAGNOSTIC_LIMIT = 20/);
  assert.match(nativePresence, /function recordDiagnostic\(actor, stage, detail = \{\}\)/);
  assert.match(nativePresence, /dataNativePresenceDiagnostics|nativePresenceDiagnostics/);
  assert.match(nativePresence, /if \(type === 'diagnostic'\)[\s\S]{0,140}recordDiagnostic\(detail\.actor, detail\.stage, detail\)/);
  assert.match(nativePresence, /Temporal y solo visible en este teléfono\. No guarda identificadores ni se envía al servidor\./);
  assert.match(nativePresence, /QUEUE_WRITE_START/);
  assert.match(nativePresence, /QUEUE_STORED/);
  assert.match(nativePresence, /SYNC_DEFERRED/);

  const recordDiagnostic = nativePresence.match(
    /function recordDiagnostic\(actor, stage, detail = \{\}\) \{([\s\S]*?)\n  \}\n\n  function resetDiagnosticLog/
  );
  assert.ok(recordDiagnostic, 'falta autoridad de traza visible en memoria');
  assert.doesNotMatch(recordDiagnostic[1], /fetch\(|localStorage|sessionStorage|bridgeCall\(/);
});
