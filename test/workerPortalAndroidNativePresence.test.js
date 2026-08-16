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
  assert.doesNotMatch(mainActivity, /Log\.[vdiew]|System\.out|System\.err/);

  assert.match(keyStore, /AndroidKeyStore/);
  assert.match(keyStore, /secp256r1/);
  assert.match(keyStore, /SHA256withECDSA/);
  assert.match(keyStore, /setUserAuthenticationRequired\(false\)/);
  assert.doesNotMatch(keyStore, /encodeToString\([^\n]*getPrivate|privateKey\.getEncoded|getPrivate\(\)\.getEncoded/);

  assert.match(nearby, /Strategy\.P2P_STAR/);
  assert.match(nearby, /ENDPOINT_NAME = "LORREN"/);
  assert.match(nearby, /synchronized void startReady[\s\S]{0,1200}startDiscovery/);
  assert.match(nearby, /synchronized void startLeaderScan[\s\S]{0,2200}startAdvertising/);
  assert.match(nearby, /role != Role\.READY/);
  assert.match(nearby, /role == Role\.LEADER && requestedEndpoints\.add/);
  assert.match(nearby, /"attemptId"/);
  assert.match(nearby, /"serviceRequestId"/);
  assert.match(nearby, /"challenge"/);
  assert.match(nearby, /"signature"/);
  assert.match(nearby, /DeviceKeyStore\.verifyBase64/);
  assert.match(nearby, /proofsByKey/);
  assert.doesNotMatch(nearby, /fullName|phone|document|documentNumber|workerName/i);

  assert.match(bridge, /JS_NAME = "LorrenAndroidPresence"/);
  assert.match(bridge, /"attendanceWriter", false/);
  assert.match(bridge, /setReady\(/);
  assert.match(bridge, /startCrewScan\(/);
  assert.match(bridge, /getProofBundle\(/);

  assert.match(nativePresence, /Prueba local: todavía no registra asistencia/);
  assert.match(nativePresence, /Marcar llegada de toda la cuadrilla/);
  assert.match(nativePresence, /Quedar listo para asistencia/);
  assert.match(nativePresence, /cuadrillas\/proximidad\/contexto/);
  assert.match(nativePresence, /attendanceWriter !== false/);
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
  assert.match(nativePresence, /Presencia de cuadrilla sin internet/);
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
