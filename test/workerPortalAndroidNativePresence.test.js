import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../mobile/android/', import.meta.url);

function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

test('Android privado reutiliza el Portal y Nearby sin introducir un escritor de asistencia', async () => {
  const [
    rootBuild,
    appBuild,
    manifest,
    mainActivity,
    bridge,
    nearby,
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
  assert.match(appBuild, /play-services-nearby:19\.3\.0/);
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
    'BLUETOOTH_SCAN',
    'NEARBY_WIFI_DEVICES'
  ]) {
    assert.match(manifest, new RegExp(`android\\.permission\\.${permission}`));
  }
  assert.match(manifest, /android:usesCleartextTraffic="false"/);
  assert.match(manifest, /android:scheme="lorren"/);
  assert.match(manifest, /android:host="portal"/);
  assert.match(manifest, /android:pathPrefix="\/transferencia"/);

  assert.match(mainActivity, /PresenceBridge\.JS_NAME/);
  assert.match(mainActivity, /\/operaciones\/portal\/sesion-transferencia\/continuar/);
  assert.match(mainActivity, /Uri\.encode\(token\.trim\(\)\)/);
  assert.match(mainActivity, /path\.equals\(PORTAL_PATH\) \|\| path\.startsWith\(PORTAL_PATH \+ "\/"\)/);
  assert.match(mainActivity, /isPortalOriginUri/);
  assert.match(mainActivity, /setMixedContentMode\(WebSettings\.MIXED_CONTENT_NEVER_ALLOW\)/);
  assert.match(mainActivity, /setAllowFileAccess\(false\)/);
  assert.match(mainActivity, /setAcceptThirdPartyCookies\(webView, false\)/);
  assert.match(mainActivity, /NATIVE_USER_AGENT_TOKEN = "LorrenNative\/1"/);
  assert.match(mainActivity, /setUserAgentString\(userAgent \+ " " \+ NATIVE_USER_AGENT_TOKEN\)/);
  assert.doesNotMatch(mainActivity, /Log\.[vdiew]|System\.out|System\.err/);

  assert.match(mainActivity, /REQUEST_APP_PREPARE/);
  assert.match(mainActivity, /prepareAttendanceDeviceOnce\(\)/);
  assert.match(mainActivity, /attendancePermissions\(true\)/);
  assert.match(mainActivity, /addIfMissing\(missing, Manifest\.permission\.CAMERA\)/);
  assert.match(mainActivity, /addIfMissing\(missing, Manifest\.permission\.ACCESS_COARSE_LOCATION\)/);
  assert.match(mainActivity, /addIfMissing\(missing, Manifest\.permission\.ACCESS_FINE_LOCATION\)/);
  assert.match(mainActivity, /private String\[\] locationRuntimePermissions\(\)/);
  assert.match(
    mainActivity,
    /locationRuntimePermissions\(\)[\s\S]{0,260}ACCESS_COARSE_LOCATION[\s\S]{0,120}ACCESS_FINE_LOCATION/
  );
  assert.match(
    mainActivity,
    /onGeolocationPermissionsShowPrompt[\s\S]{0,700}requestRuntimePermissions\(locationRuntimePermissions\(\), REQUEST_GEOLOCATION\)/
  );
  assert.match(mainActivity, /Manifest\.permission\.BLUETOOTH_SCAN/);
  assert.match(mainActivity, /Manifest\.permission\.BLUETOOTH_CONNECT/);
  assert.match(mainActivity, /Manifest\.permission\.BLUETOOTH_ADVERTISE/);
  assert.match(mainActivity, /Manifest\.permission\.NEARBY_WIFI_DEVICES/);
  assert.match(mainActivity, /BluetoothManager/);
  assert.match(mainActivity, /adapter\.isEnabled\(\)/);
  assert.match(mainActivity, /BluetoothAdapter\.ACTION_REQUEST_ENABLE/);
  assert.match(mainActivity, /REQUEST_ENABLE_BLUETOOTH/);
  assert.match(mainActivity, /"bluetooth_unavailable"/);
  assert.match(mainActivity, /"bluetooth_disabled"/);
  assert.match(
    mainActivity,
    /nearbyPermissionsGranted\(\)[\s\S]{0,700}ACCESS_COARSE_LOCATION[\s\S]{0,180}ACCESS_FINE_LOCATION/
  );

  const stopLifecycle = mainActivity.match(/protected void onStop\(\) \{([\s\S]*?)\n    \}/);
  assert.ok(stopLifecycle, 'falta detectar una salida real de la app');
  assert.match(stopLifecycle[1], /stoppedForBackground = true/);
  assert.match(mainActivity, /private void refreshPortalSilently\(\)/);
  assert.match(mainActivity, /navigator\.onLine/);
  assert.match(mainActivity, /#mark-dialog\[open\],#enrollment-dialog\[open\]/);
  assert.match(mainActivity, /window\.location\.reload\(\)/);
  assert.match(mainActivity, /stoppedForSystemPrompt/);

  assert.match(keyStore, /AndroidKeyStore/);
  assert.match(keyStore, /secp256r1/);
  assert.match(keyStore, /SHA256withECDSA/);
  assert.match(keyStore, /setUserAuthenticationRequired\(false\)/);
  assert.doesNotMatch(keyStore, /encodeToString\([^\n]*getPrivate|privateKey\.getEncoded|getPrivate\(\)\.getEncoded/);

  assert.match(nearby, /Strategy\.P2P_STAR/);
  assert.match(nearby, /ENDPOINT_NAME = "LORREN"/);
  assert.match(nearby, /synchronized void startReady[\s\S]{0,1200}startReadyDiscovery/);
  assert.match(nearby, /private void startReadyDiscovery[\s\S]{0,1800}startDiscovery/);
  assert.match(nearby, /synchronized void startLeaderScan[\s\S]{0,2200}startLeaderAdvertising/);
  assert.match(nearby, /private void startLeaderAdvertising[\s\S]{0,2200}startAdvertising/);
  assert.match(nearby, /role != Role\.READY/);
  assert.match(nearby, /role == Role\.LEADER && requestedEndpoints\.add/);
  assert.match(nearby, /"attemptId"/);
  assert.match(nearby, /"serviceRequestId"/);
  assert.match(nearby, /"challenge"/);
  assert.match(nearby, /"signature"/);
  assert.match(nearby, /DeviceKeyStore\.verifyBase64/);
  assert.match(nearby, /proofsByKey/);
  assert.doesNotMatch(nearby, /fullName|phone|document|documentNumber|workerName/i);

  assert.match(nearby, /com\.google\.android\.gms\.common\.api\.ApiException/);
  assert.match(nearby, /ConnectionsStatusCodes/);
  assert.match(nearby, /MAX_START_RETRIES = 1/);
  assert.match(nearby, /NEARBY_RESTART_DELAY_MS = 350L/);
  for (const status of [
    'STATUS_ALREADY_ADVERTISING',
    'STATUS_ALREADY_DISCOVERING',
    'STATUS_ALREADY_HAVE_ACTIVE_STRATEGY',
    'STATUS_OUT_OF_ORDER_API_CALL'
  ]) {
    assert.match(nearby, new RegExp(`ConnectionsStatusCodes\\.${status}`));
  }
  assert.match(nearby, /STATUS_RADIO_ERROR[\s\S]{0,120}"nearby_radio_error"/);
  assert.match(nearby, /MISSING_PERMISSION_BLUETOOTH_ADVERTISE/);
  assert.match(nearby, /MISSING_PERMISSION_BLUETOOTH_SCAN/);
  assert.match(nearby, /MISSING_PERMISSION_NEARBY_WIFI_DEVICES/);
  assert.match(nearby, /isRecoverableStartFailure\(error\)[\s\S]{0,260}resetNearbyClientForRetry\(\)[\s\S]{0,420}retryCount \+ 1/);
  assert.match(nearby, /resetNearbyClientForRetry\(\)[\s\S]{0,500}stopAdvertising\(\)[\s\S]{0,220}stopDiscovery\(\)[\s\S]{0,220}stopAllEndpoints\(\)/);
  assert.match(nearby, /emit\("scan_started"[\s\S]{0,500}scheduleLeaderScanTimeout\(nextAttemptId, timeoutMs\)/);
  const leaderStart = nearby.match(/synchronized void startLeaderScan\(JSONObject input\) \{([\s\S]*?)\n    \}\n\n    private void startLeaderAdvertising/);
  assert.ok(leaderStart, 'falta autoridad startLeaderScan');
  assert.doesNotMatch(leaderStart[1], /handler\.postDelayed\(scanTimeout/);

  assert.match(bridge, /JS_NAME = "LorrenAndroidPresence"/);
  assert.match(bridge, /"attendanceWriter", false/);
  assert.match(bridge, /setReady\(/);
  assert.match(bridge, /startCrewScan\(/);
  assert.match(bridge, /getProofBundle\(/);
  assert.match(bridge, /setReady[\s\S]{0,500}ensureNearbyRadioReady\(\)[\s\S]{0,500}manager\.startReady/);
  assert.match(bridge, /startCrewScan[\s\S]{0,500}ensureNearbyRadioReady\(\)[\s\S]{0,800}manager\.startLeaderScan/);

  assert.match(nativePresence, /Presencia de cuadrilla/);
  assert.match(nativePresence, /Comprueba quiénes están presentes\./);
  assert.match(nativePresence, /Verificar presencia/);
  assert.match(nativePresence, /Quedar listo para asistencia/);
  assert.match(nativePresence, /Reintentar no detectados/);
  assert.match(nativePresence, /cuadrillas\/proximidad\/contexto/);
  assert.match(nativePresence, /attendanceWriter !== false/);
  assert.match(nativePresence, /bluetooth_disabled: 'Bluetooth está apagado\. Actívalo para continuar\.'/);
  assert.match(nativePresence, /bluetooth_unavailable: 'Este teléfono no tiene Bluetooth disponible/);
  assert.match(nativePresence, /type === 'bluetooth'/);
  assert.match(nativePresence, /Bluetooth listo\. Pulsa nuevamente para continuar\./);
  assert.doesNotMatch(nativePresence, /Los teléfonos Lórren se comprueban entre sí/);
  assert.doesNotMatch(nativePresence, /La app no escribe asistencia por sí sola/);
  assert.doesNotMatch(nativePresence, /Pulsa una vez\. Lórren comprobará los teléfonos cercanos/);
  assert.doesNotMatch(nativePresence, /Prueba local: todavía no registra asistencia/);
  assert.doesNotMatch(nativePresence, /\/llegada|\/salida|inicio-almuerzo|fin-almuerzo|registerDispatchArrival|registerCrewArrivalForLeader/);
  assert.doesNotMatch(nativePresence, /alert\s*\(|confirm\s*\(|prompt\s*\(/);

  for (const pattern of ['*.jks', '*.keystore', '*.apk', '*.aab']) {
    assert.ok(ignore.includes(pattern), `falta ignorar ${pattern}`);
  }
});

test('sin contexto de cuadrilla el módulo nativo no tapa ni reemplaza el Portal individual', async () => {
  const nativePresence = await read('app/src/main/assets/native-presence.js');
  const renderPanel = nativePresence.match(/function renderPanel\(\) \{([\s\S]*?)\n  \}\n\n  function insertPanel/);

  assert.ok(renderPanel, 'no se encontró la autoridad renderPanel');
  assert.match(
    renderPanel[1],
    /document\.getElementById\(PANEL_ID\)[\s\S]{0,160}if \(!contexts\.length\) return;[\s\S]{0,80}installStyles\(\);/
  );
  assert.doesNotMatch(nativePresence, /No hay una cuadrilla disponible para este teléfono en este momento\./);
  assert.match(nativePresence, /Presencia de cuadrilla/);
  assert.match(nativePresence, /if \(!selectedServiceRequestId \|\| !contexts\.some/);
});

test('la prueba Android no contiene PII ni una identidad Bluetooth humana', async () => {
  const [nearby, nativePresence, readme] = await Promise.all([
    read('app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java'),
    read('app/src/main/assets/native-presence.js'),
    read('README.md')
  ]);
  const combined = `${nearby}\n${nativePresence}`;

  assert.doesNotMatch(combined, /\b3\d{9}\b/);
  assert.doesNotMatch(combined, /\b\d{7,10}\b.*(?:cedula|c[eé]dula|documento)/i);
  assert.doesNotMatch(combined, /@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  assert.match(nearby, /private static final String ENDPOINT_NAME = "LORREN"/);
  assert.match(readme, /no anuncia nombre, documento o teléfono/i);
});

test('la fase Android no reemplaza las autoridades server-side de asistencia', async () => {
  const [nativePresence, bridge, nearby, readme] = await Promise.all([
    read('app/src/main/assets/native-presence.js'),
    read('app/src/main/java/com/loginpro/lorren/portal/PresenceBridge.java'),
    read('app/src/main/java/com/loginpro/lorren/portal/NearbyPresenceManager.java'),
    read('README.md')
  ]);
  const nativeCode = `${nativePresence}\n${bridge}\n${nearby}`;

  assert.doesNotMatch(nativeCode, /prisma|DispatchAttendanceMark|DispatchAttendanceSession/);
  assert.doesNotMatch(nativeCode, /fetch\([^\n]*(?:llegada|salida|almuerzo)/i);
  assert.match(readme, /Esta fase no registra asistencia/i);
  assert.match(readme, /no crea un segundo backend de asistencia/i);
  assert.match(readme, /credencial firmada por el servidor/i);
});
