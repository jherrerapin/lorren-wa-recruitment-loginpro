import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../mobile/android/', import.meta.url);

function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

test('Android privado reutiliza el Portal y Nearby Connections sin introducir un escritor de asistencia', async () => {
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
  assert.match(appBuild, /com\.google\.android\.gms:play-services-nearby:19\.4\.0/);
  assert.doesNotMatch(appBuild, /loginpro\.(com|co)|railway\.app|railway\.com/i);

  for (const permission of [
    'ACCESS_COARSE_LOCATION',
    'ACCESS_FINE_LOCATION',
    'ACCESS_WIFI_STATE',
    'CHANGE_WIFI_STATE',
    'BLUETOOTH_ADVERTISE',
    'BLUETOOTH_CONNECT',
    'BLUETOOTH_SCAN',
    'NEARBY_WIFI_DEVICES'
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
  assert.match(mainActivity, /Manifest\.permission\.NEARBY_WIFI_DEVICES/);
  assert.match(mainActivity, /addNearbyWifiPermissionIfNeeded\(missing\)/);
  assert.match(mainActivity, /BluetoothAdapter\.ACTION_REQUEST_ENABLE/);
  assert.match(mainActivity, /"bluetooth_unavailable"/);
  assert.match(mainActivity, /"bluetooth_disabled"/);
  assert.match(mainActivity, /nearbyTransportPermissionsGranted\(\)[\s\S]{0,220}hasNearbyLegacyLocationPermission\(\)[\s\S]{0,100}hasNearbyBluetoothPermissions\(\)[\s\S]{0,100}hasNearbyWifiPermission\(\)/);
  assert.match(mainActivity, /ensureAttendanceLocationPermission\(\)[\s\S]{0,180}hasPreciseLocationPermission\(\)[\s\S]{0,180}REQUEST_ATTENDANCE_LOCATION/);
  assert.doesNotMatch(mainActivity, /nearbyPermissionsGranted\(\)/);

  assert.match(keyStore, /AndroidKeyStore/);
  assert.match(keyStore, /secp256r1/);
  assert.match(keyStore, /SHA256withECDSA/);
  assert.match(keyStore, /setUserAuthenticationRequired\(false\)/);
  assert.doesNotMatch(keyStore, /encodeToString\([^\n]*getPrivate|privateKey\.getEncoded|getPrivate\(\)\.getEncoded/);

  assert.match(presenceManager, /Nearby\.getConnectionsClient/);
  assert.match(presenceManager, /ConnectionsClient/);
  assert.match(presenceManager, /Strategy\.P2P_STAR/);
  assert.match(presenceManager, /AdvertisingOptions\.Builder/);
  assert.match(presenceManager, /DiscoveryOptions\.Builder/);
  assert.match(presenceManager, /ConnectionOptions\.Builder/);
  assert.match(presenceManager, /setLowPower\(true\)/);
  assert.match(presenceManager, /setLowPower\(false\)/);
  assert.equal((presenceManager.match(/ConnectionType\.NON_DISRUPTIVE/g) || []).length, 2);
  assert.doesNotMatch(presenceManager, /ConnectionType\.(?:BALANCED|DISRUPTIVE)/);
  assert.match(presenceManager, /startReady\(String serviceRequestId\)[\s\S]{0,420}startReadyDiscovery\(normalizedService, 0\)/);
  assert.match(presenceManager, /startLeaderScan\(JSONObject input\)[\s\S]{0,1400}startLeaderAdvertising\(nextAttemptId, serviceRequestId, timeoutMs, 0\)/);
  assert.match(presenceManager, /client\.startAdvertising/);
  assert.match(presenceManager, /client\.startDiscovery/);
  assert.match(presenceManager, /role != Role\.READY[\s\S]{0,800}requestAuxiliaryConnection\(endpointId, 0\)/);
  assert.match(presenceManager, /MAX_CONNECTION_REQUEST_RETRIES = 1/);
  assert.match(presenceManager, /isRecoverableConnectionRequestFailure[\s\S]{0,260}STATUS_RADIO_ERROR[\s\S]{0,160}STATUS_ERROR/);
  assert.match(presenceManager, /role == Role\.LEADER && requestedEndpoints\.add\(endpointId\)[\s\S]{0,180}endpoint_found/);
  assert.match(presenceManager, /Payload\.fromBytes/);
  assert.match(presenceManager, /"attemptId"/);
  assert.match(presenceManager, /"serviceRequestId"/);
  assert.match(presenceManager, /"challenge"/);
  assert.match(presenceManager, /"signature"/);
  assert.match(presenceManager, /DeviceKeyStore\.signBase64/);
  assert.match(presenceManager, /DeviceKeyStore\.verifyBase64/);
  assert.match(presenceManager, /proofsByKey/);
  assert.doesNotMatch(presenceManager, /BluetoothLeAdvertiser|BluetoothLeScanner|BluetoothGatt|ScanFilter/);
  assert.doesNotMatch(presenceManager, /WifiManager|setWifiEnabled|startLocalOnlyHotspot/);

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

test('auxiliar queda listo por visibilidad y discovery confirmado de Nearby, sin depender del foco del WebView', async () => {
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

  assert.ok(memberStatus, 'no se encontró la autoridad memberStatus');
  assert.ok(ensureReady, 'no se encontró ensureAuxiliaryReady');
  assert.ok(startReady, 'no se encontró startReady');
  assert.ok(onlineHandler, 'no se encontró el manejador online');
  assert.ok(offlineHandler, 'no se encontró el manejador offline');
  assert.match(memberStatus[1], /if \(member\.isLeader\) return 'LEADER_DEVICE';/);
  assert.match(nativePresence, /status === 'LEADER_DEVICE'[\s\S]{0,120}label: 'Este teléfono'/);
  assert.match(ensureReady[1], /document\.visibilityState === 'hidden'/);
  assert.doesNotMatch(ensureReady[1], /document\.hasFocus/);
  assert.match(ensureReady[1], /forceRestart && \['PREPARING', 'READY'\]\.includes\(activeMode\)[\s\S]{0,120}bridgeCall\('stopReady'\)/);
  assert.match(startReady[1], /activeMode = 'PREPARING'/);
  assert.match(startReady[1], /navigator\.onLine && !credentialPrepared\(\)[\s\S]{0,80}provisionCredential\(\)/);
  assert.match(startReady[1], /bridgeCall\('setReady'/);
  assert.doesNotMatch(startReady[1], /!navigator\.onLine[\s\S]{0,180}return/);
  assert.doesNotMatch(startReady[1], /activeMode = 'READY'/);
  assert.match(nativePresence, /if \(type === 'ready'\)[\s\S]{0,220}activeMode = 'READY'/);
  assert.match(nativePresence, /Bluetooth listo\. Esperando la marcación del encargado\./);
  assert.match(presenceManager, /startReadyDiscovery\(normalizedService, 0\)/);
  assert.match(presenceManager, /client\.startDiscovery[\s\S]{0,900}addOnSuccessListener[\s\S]{0,500}emit\("ready"/);
  assert.match(onlineHandler[1], /ensureAuxiliaryReady\(\)/);
  assert.match(offlineHandler[1], /ensureAuxiliaryReady\(\)/);
  assert.doesNotMatch(onlineHandler[1], /scheduleAuxiliaryRearm|stopReady/);
  assert.doesNotMatch(offlineHandler[1], /scheduleAuxiliaryRearm|stopReady/);
  assert.match(nativePresence, /window\.addEventListener\('focus', scheduleAuxiliaryRearm\)/);
  assert.match(nativePresence, /visibilityState === 'visible'[\s\S]{0,120}scheduleAuxiliaryRearm\(\)/);
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

test('advertisement Nearby del encargado no publica PII ni usa el identificador de servicio como identidad de trabajador', async () => {
  const presenceManager = await read('app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java');

  assert.match(presenceManager, /ENDPOINT_NAME = "LORREN"/);
  assert.match(presenceManager, /startLeaderAdvertising[\s\S]{0,700}client\.startAdvertising\([\s\S]{0,180}ENDPOINT_NAME[\s\S]{0,100}SERVICE_ID/);
  assert.doesNotMatch(presenceManager, /fullName|workerName|documentNumber|phoneNumber/i);
  assert.match(presenceManager, /keyId\(publicKey\)/);
  assert.match(presenceManager, /proofsByKey\.put\(keyId, stored\)/);
  assert.doesNotMatch(presenceManager, /ENDPOINT_NAME\s*=\s*readyServiceRequestId|startAdvertising\(readyServiceRequestId/);
});

test('Nearby solo transporta la prueba; servidor y cola siguen siendo autoridades de asistencia', async () => {
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

test('diagnóstico visible muestra checkpoints Nearby de ambos roles sin persistir ni exponer identificadores', async () => {
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
  assert.match(diagnosticEmitter[1], /event\.put\("statusCode", statusCode\)/);
  assert.match(diagnosticEmitter[1], /event\.put\("retryCount", retryCount\)/);
  assert.doesNotMatch(
    diagnosticEmitter[1],
    /endpointId|workerId|serviceRequestId|attemptId|challenge|credential|publicKey|signature/
  );

  for (const stage of [
    'DISCOVERY_START',
    'DISCOVERY_READY',
    'ENDPOINT_FOUND',
    'CONNECTION_REQUEST',
    'CONNECTION_INITIATED',
    'CONNECTION_ESTABLISHED',
    'CHALLENGE_RECEIVED',
    'PROOF_DISPATCHED'
  ]) {
    assert.match(presenceManager, new RegExp(`emitDiagnostic\\(\\"AUX\\", \\"${stage}\\"`));
  }
  for (const stage of [
    'ADVERTISING_START',
    'ADVERTISING_READY',
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
