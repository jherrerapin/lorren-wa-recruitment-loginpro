import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../mobile/android/', import.meta.url);

function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

test('Android privado reutiliza el Portal y una sola autoridad Bluetooth Classic sin introducir escritor de asistencia', async () => {
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
  assert.match(mainActivity, /Manifest\.permission\.BLUETOOTH_SCAN/);
  assert.match(mainActivity, /Manifest\.permission\.BLUETOOTH_CONNECT/);
  assert.match(mainActivity, /Manifest\.permission\.BLUETOOTH_ADVERTISE/);
  assert.doesNotMatch(mainActivity, /Manifest\.permission\.NEARBY_WIFI_DEVICES/);
  assert.doesNotMatch(mainActivity, /hasNearbyWifiPermission|addNearbyWifiPermissionIfNeeded/);
  assert.match(mainActivity, /BluetoothAdapter\.ACTION_REQUEST_ENABLE/);
  assert.match(mainActivity, /BluetoothAdapter\.ACTION_REQUEST_DISCOVERABLE/);
  assert.match(mainActivity, /BluetoothAdapter\.EXTRA_DISCOVERABLE_DURATION/);
  assert.match(mainActivity, /BLUETOOTH_DISCOVERABLE_SECONDS = 300/);
  assert.match(mainActivity, /BluetoothAdapter\.SCAN_MODE_CONNECTABLE_DISCOVERABLE/);
  assert.match(mainActivity, /REQUEST_BLUETOOTH_DISCOVERABLE = 4107/);
  assert.match(mainActivity, /onBluetoothDiscoverableResult\(resultCode > 0\)/);
  assert.doesNotMatch(mainActivity, /WifiManager|setWifiEnabled|startLocalOnlyHotspot/);

  assert.match(keyStore, /AndroidKeyStore/);
  assert.match(keyStore, /secp256r1/);
  assert.match(keyStore, /SHA256withECDSA/);
  assert.match(keyStore, /setUserAuthenticationRequired\(false\)/);
  assert.doesNotMatch(keyStore, /encodeToString\([^\n]*getPrivate|privateKey\.getEncoded|getPrivate\(\)\.getEncoded/);

  assert.match(presenceManager, /BluetoothServerSocket/);
  assert.match(presenceManager, /BluetoothSocket/);
  assert.match(presenceManager, /listenUsingInsecureRfcommWithServiceRecord/);
  assert.match(presenceManager, /createInsecureRfcommSocketToServiceRecord/);
  assert.match(presenceManager, /bluetoothAdapter\.startDiscovery\(\)/);
  assert.match(presenceManager, /BluetoothAdapter\.ACTION_DISCOVERY_STARTED/);
  assert.match(presenceManager, /fetchUuidsWithSdp\(\)/);
  assert.match(presenceManager, /BluetoothDevice\.ACTION_UUID/);
  assert.match(presenceManager, /SERVICE_PARCEL_UUID/);
  assert.match(presenceManager, /MIN_SCAN_MS = 35_000L/);
  assert.match(presenceManager, /INQUIRY_CHECKPOINT_MS = 15_000L/);
  assert.match(presenceManager, /appContext\.registerReceiver\(leaderDiscoveryReceiver, filter\)/);
  assert.doesNotMatch(presenceManager, /registerReceiver\(leaderDiscoveryReceiver, filter, Context\.RECEIVER_EXPORTED\)/);
  assert.doesNotMatch(presenceManager, /BluetoothLeAdvertiser|BluetoothGatt|Nearby\.getConnectionsClient|ConnectionsClient|Strategy\.P2P_|ConnectionType\.|setLowPower\(/);
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
  assert.match(bridge, /pendingReadyServiceRequestId/);
  assert.match(bridge, /activity\.ensureNearbyDiscoverable\(\)/);
  assert.match(bridge, /onBluetoothDiscoverableResult\(boolean granted\)/);
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

test('auxiliar queda listo por visibilidad con discoverability confirmada y servidor RFCOMM sin depender de WAN ni foco del WebView', async () => {
  const [nativePresence, presenceManager, bridge] = await Promise.all([
    read('app/src/main/assets/native-presence.js'),
    read('app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java'),
    read('app/src/main/java/com/loginpro/lorren/portal/PresenceBridge.java')
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
  assert.match(presenceManager, /startAuxiliaryServer\(\)/);
  assert.match(presenceManager, /SCAN_MODE_CONNECTABLE_DISCOVERABLE[\s\S]{0,300}DISCOVERABLE_CONFIRMED[\s\S]{0,420}RFCOMM_SERVER_READY[\s\S]{0,80}emitReady\(\)/);
  assert.match(presenceManager, /listenUsingInsecureRfcommWithServiceRecord/);
  assert.match(bridge, /if \(!activity\.ensureNearbyDiscoverable\(\)\) return jsonOk\(\)/);
  assert.match(bridge, /onBluetoothDiscoverableResult[\s\S]{0,1200}manager\.startReady\(serviceRequestId\)/);
  assert.match(onlineHandler[1], /ensureAuxiliaryReady\(\)/);
  assert.match(offlineHandler[1], /ensureAuxiliaryReady\(\)/);
  assert.doesNotMatch(onlineHandler[1], /scheduleAuxiliaryRearm|stopReady/);
  assert.doesNotMatch(offlineHandler[1], /scheduleAuxiliaryRearm|stopReady/);
});

test('replay físico: discovery Classic se confirma por broadcast y tiene checkpoint para iniciar SDP aunque no llegue FINISHED', async () => {
  const [nativePresence, presenceManager, mainActivity] = await Promise.all([
    read('app/src/main/assets/native-presence.js'),
    read('app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java'),
    read('app/src/main/java/com/loginpro/lorren/portal/MainActivity.java')
  ]);

  const prepareBlock = nativePresence.match(
    /const prepare = element\([\s\S]*?actions\.appendChild\(prepare\);/
  );
  assert.ok(prepareBlock, 'falta acción manual del auxiliar');
  assert.match(prepareBlock[0], /prepare\.disabled = \['PREPARING', 'READY'\]\.includes\(activeMode\)/);
  assert.match(prepareBlock[0], /if \(\['PREPARING', 'READY'\]\.includes\(activeMode\)\) return;/);
  assert.match(prepareBlock[0], /ensureAuxiliaryReady\(\)/);
  assert.doesNotMatch(prepareBlock[0], /ensureAuxiliaryReady\(true\)/);

  assert.match(mainActivity, /ACTION_REQUEST_DISCOVERABLE/);
  assert.match(mainActivity, /BLUETOOTH_DISCOVERABLE_SECONDS = 300/);
  assert.match(presenceManager, /MIN_SCAN_MS = 35_000L/);
  assert.match(presenceManager, /INQUIRY_CHECKPOINT_MS = 15_000L/);
  assert.match(presenceManager, /RFCOMM_EXCHANGE_TIMEOUT_MS = 12_000L/);
  assert.match(presenceManager, /bluetoothAdapter\.startDiscovery\(\)/);
  assert.match(presenceManager, /BluetoothAdapter\.ACTION_DISCOVERY_STARTED/);
  assert.match(presenceManager, /CLASSIC_DISCOVERY_READY/);
  assert.match(presenceManager, /BluetoothAdapter\.ACTION_DISCOVERY_FINISHED/);
  assert.match(presenceManager, /scheduleLeaderInquiryCheckpoint\(nextAttemptId\)/);
  assert.match(presenceManager, /CLASSIC_INQUIRY_CHECKPOINT[\s\S]{0,260}bluetoothAdapter\.cancelDiscovery\(\)[\s\S]{0,220}requestSdpForDiscoveredDevices\(\)/);
  assert.match(presenceManager, /handler\.postDelayed\(leaderInquiryCheckpoint, INQUIRY_CHECKPOINT_MS\)/);
  assert.match(presenceManager, /device\.fetchUuidsWithSdp\(\)/);
  assert.match(presenceManager, /BluetoothDevice\.ACTION_UUID/);
  assert.match(presenceManager, /device\.createInsecureRfcommSocketToServiceRecord\(SERVICE_UUID\)/);
  assert.match(presenceManager, /socket\.connect\(\)/);
  assert.match(presenceManager, /handler\.postDelayed\(timeout, RFCOMM_EXCHANGE_TIMEOUT_MS\)/);
  assert.match(presenceManager, /WINDOW_CLOSED[\s\S]{0,180}stopLeaderDiscovery\(\)[\s\S]{0,220}CONNECTION_GRACE_MS/);
  assert.doesNotMatch(presenceManager, /BluetoothLeAdvertiser|BluetoothGattServer|BluetoothGattCallback/);
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

test('servicio RFCOMM publica solo UUID/nombre técnico y no PII', async () => {
  const presenceManager = await read('app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java');

  assert.match(presenceManager, /SERVICE_NAME = "LORREN_CREW_PRESENCE"/);
  assert.match(presenceManager, /listenUsingInsecureRfcommWithServiceRecord\([\s\S]{0,120}SERVICE_NAME[\s\S]{0,80}SERVICE_UUID/);
  assert.match(presenceManager, /fetchUuidsWithSdp\(\)/);
  assert.match(presenceManager, /SERVICE_PARCEL_UUID\.equals/);
  assert.doesNotMatch(presenceManager, /fullName|workerName|documentNumber|phoneNumber/i);
  assert.match(presenceManager, /keyId\(publicKey\)/);
  assert.match(presenceManager, /proofsByKey\.put\(keyId, stored\)/);
});

test('Bluetooth Classic solo transporta la prueba; servidor y cola siguen siendo autoridades de asistencia', async () => {
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
    /private void emitDiagnostic\(String actor, String stage\) \{([\s\S]*?)\n    \}\n\n    private void emitError/
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
    'DISCOVERABLE_CONFIRMED',
    'RFCOMM_SERVER_START',
    'RFCOMM_SERVER_READY',
    'RFCOMM_CONNECTION_ACCEPTED',
    'CONNECTION_ESTABLISHED',
    'CHALLENGE_RECEIVED',
    'PROOF_DISPATCHED'
  ]) {
    assert.match(presenceManager, new RegExp(`emitDiagnostic\\(\\"AUX\\", \\"${stage}\\"`));
  }
  for (const stage of [
    'CLASSIC_DISCOVERY_START',
    'CLASSIC_DISCOVERY_READY',
    'CLASSIC_DEVICE_FOUND',
    'CLASSIC_INQUIRY_CHECKPOINT',
    'SDP_REQUESTED',
    'SDP_MATCHED',
    'RFCOMM_CONNECTING',
    'RFCOMM_CONNECTED',
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
