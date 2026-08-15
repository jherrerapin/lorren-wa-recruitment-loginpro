import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const loaderSource = fs.readFileSync(new URL('../src/public/worker-biometric.js', import.meta.url), 'utf8');
const bootstrapSource = fs.readFileSync(new URL('../src/public/worker-biometric-core.js', import.meta.url), 'utf8');
const installSource = fs.readFileSync(new URL('../src/public/worker-portal-install.js', import.meta.url), 'utf8');
const handoffSource = fs.readFileSync(new URL('../src/public/worker-portal-session-handoff.js', import.meta.url), 'utf8');
const handoffRouteSource = fs.readFileSync(new URL('../src/routes/workerPortalSessionHandoff.js', import.meta.url), 'utf8');
const androidBuildSource = fs.readFileSync(new URL('../mobile/android/app/build.gradle', import.meta.url), 'utf8');
const serviceWorkerSource = fs.readFileSync(new URL('../src/public/worker-portal-sw.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../src/public/worker-portal.webmanifest', import.meta.url), 'utf8'));


test('el cargador incluye instalación, sesión y actualización sin duplicar el nombre de caché', () => {
  assert.match(loaderSource, /worker-portal-install\.js/);
  assert.match(loaderSource, /worker-portal-session-handoff\.js/);
  assert.match(loaderSource, /20260803-worker-portal-runtime-v5/);
  assert.match(loaderSource, /PORTAL_SHELL_UPDATED/);
  assert.match(loaderSource, /message\.cacheName/);
  assert.match(loaderSource, /registration\?\.update/);
  assert.match(loaderSource, /window\.location\.reload\(\)/);
  assert.match(loaderSource, /LOAD_WORKER_PORTAL_HANDOFF = \/Android/);
  assert.doesNotMatch(loaderSource, /BIOMETRIC_SHELL_CACHE|lorren-worker-portal-shell-v\d+/);
  assert.doesNotMatch(loaderSource, /LOAD_WORKER_PORTAL_HANDOFF[\s\S]*WhatsApp\|FBAN/);
  assert.doesNotMatch(bootstrapSource, /humanConfig|captureEnrollment|captureVerification|getUserMedia|human\.detect/);
});


test('el portal conserva un único CTA de descarga aunque el rostro ya estuviera registrado', () => {
  assert.match(installSource, /portal-install-cta/);
  assert.match(installSource, /open-worker-portal-install/);
  assert.match(installSource, /Descargar app/);
  assert.match(installSource, /buildPersistentCta\(\)/);
  assert.match(installSource, /insertAdjacentElement\('afterend', cta\)/);
  assert.doesNotMatch(installSource, /portal-install-cta-v2|android-install-cta-final/i);
});


test('la oferta automática sigue apareciendo después de confirmar el registro facial', () => {
  assert.match(installSource, /rostro\\s\+registrado/i);
  assert.match(installSource, /MutationObserver/);
  assert.match(installSource, /classList\?\.contains\('ok'\)/);
  assert.match(installSource, /scheduleInstallOffer/);
  assert.match(installSource, /lorren:face-enrolled/);
});


test('Android usa el APK privado autenticado y no el instalador PWA', () => {
  assert.match(installSource, /sesion-transferencia\/android-app/);
  assert.match(installSource, /APK privado/);
  assert.match(installSource, /downloadUrl\.startsWith\('\/operaciones\/portal\/'\)/);
  assert.match(installSource, /window\.location\.href = downloadUrl/);
  assert.match(installSource, /open-worker-portal-native/);
  assert.match(installSource, /Ya la instalé · abrir Lórren/);
  assert.match(installSource, /beforeinstallprompt[\s\S]*if \(isAndroid\(\)\) return/);
  assert.doesNotMatch(installSource, /No se descarga un APK/);
});


test('la app Android ya instalada no recibe otra oferta de instalación', () => {
  assert.match(installSource, /function isNativeAndroidApp\(\)/);
  assert.match(installSource, /window\.LorrenAndroidPresence/);
  assert.match(installSource, /if \(isNativeAndroidApp\(\)\) \{[\s\S]*removeInstallUi\(\)/);
});


test('el APK se sirve solo desde sesión activa y sin revelar la ruta del servidor', () => {
  assert.match(handoffRouteSource, /ATTENDANCE_ANDROID_APK_PATH/);
  assert.match(handoffRouteSource, /ATTENDANCE_ANDROID_APP_VERSION_NAME/);
  assert.match(handoffRouteSource, /ATTENDANCE_ANDROID_APP_VERSION_CODE/);
  assert.match(handoffRouteSource, /resolveActiveSession/);
  assert.match(handoffRouteSource, /portal_session_required/);
  assert.match(handoffRouteSource, /stat\(androidDistribution\.apkPath\)/);
  assert.match(handoffRouteSource, /application\/vnd\.android\.package-archive/);
  assert.match(handoffRouteSource, /res\.sendFile\(androidDistribution\.apkPath\)/);
  assert.match(handoffRouteSource, /downloadUrl: ANDROID_APP_DOWNLOAD_PATH/);
  assert.doesNotMatch(handoffRouteSource, /downloadUrl:\s*androidDistribution\.apkPath/);
});


test('Android transfiere la sesión a la app mediante el deep link ya declarado', () => {
  assert.match(handoffSource, /sesion-transferencia\/crear/);
  assert.match(handoffSource, /X-Requested-With/);
  assert.match(handoffSource, /credentials: 'include'/);
  assert.match(handoffSource, /open-worker-portal-native/);
  assert.match(handoffSource, /lorren:\/\/portal\/transferencia\?transferencia=/);
  assert.match(handoffSource, /encodeURIComponent\(handoffToken\)/);
  assert.match(handoffSource, /window\.location\.href = nativeDeepLink\(handoffToken\)/);
  assert.match(handoffSource, /stopImmediatePropagation/);
});


test('el navegador interno primero rota la sesión hacia Chrome para descargar', () => {
  assert.match(handoffSource, /isAndroidInAppBrowser/);
  assert.match(handoffSource, /sesion-transferencia\/continuar/);
  assert.match(handoffSource, /package=com\.android\.chrome/);
  assert.match(handoffSource, /Abrir en Chrome y descargar/);
  assert.match(handoffSource, /window\.location\.href = chromeIntentUrl\(handoffToken\)/);
});


test('el observador de handoff solo procesa controles de instalación relevantes', () => {
  assert.match(handoffSource, /function mutationAddsInstallButton\(mutation\)/);
  assert.match(handoffSource, /mutations\.some\(mutationAddsInstallButton\)/);
  assert.match(handoffSource, /NATIVE_OPEN_BUTTON_ID/);
  assert.doesNotMatch(handoffSource, /new MutationObserver\(prepareInstallButtons\)/);
});


test('versionCode y versionName Android son configurables sin versionar llaves de firma', () => {
  assert.match(androidBuildSource, /gradleProperty\('lorrenVersionCode'\)/);
  assert.match(androidBuildSource, /gradleProperty\('lorrenVersionName'\)/);
  assert.match(androidBuildSource, /versionCode lorrenVersionCode/);
  assert.match(androidBuildSource, /versionName lorrenVersionName/);
  assert.doesNotMatch(androidBuildSource, /storePassword|keyPassword|\.jks|\.keystore|signingConfig\s*\{/i);
});


test('iPhone conserva la instalación PWA guiada por Safari', () => {
  assert.match(installSource, /iPad\|iPhone\|iPod/);
  assert.match(installSource, /Agregar a pantalla de inicio/);
  assert.match(installSource, /Apple no permite iniciar esta instalación desde un botón/);
});


test('la PWA no se ofrece dentro de una instalación standalone', () => {
  assert.match(installSource, /display-mode: standalone/);
  assert.match(installSource, /navigator\.standalone/);
  assert.match(installSource, /appinstalled/);
  assert.match(installSource, /removeInstallUi/);
});


test('el service worker usa la versión de shell vigente de Fase B y actualiza los módulos activos', () => {
  assert.match(serviceWorkerSource, /lorren-worker-portal-shell-v15/);
  assert.match(serviceWorkerSource, /NETWORK_FIRST_ASSETS/);
  for (const path of [
    '/public/worker-biometric.js',
    '/public/worker-biometric-core.js',
    '/public/worker-biometric-mobile.js',
    '/public/worker-portal-biometric-flow.js',
    '/public/worker-portal-offline.js',
    '/public/worker-portal-offline-controller.js',
    '/public/worker-portal-install.js'
  ]) {
    assert.match(serviceWorkerSource, new RegExp(`'${path.replaceAll('/', '\\/').replaceAll('.', '\\.')}'`));
  }
  assert.doesNotMatch(serviceWorkerSource, /worker-portal-offline-v2\.js/);
  assert.match(serviceWorkerSource, /networkFirstStatic/);
  assert.match(serviceWorkerSource, /fetch\(request, \{ cache: 'no-store' \}\)/);
  assert.match(serviceWorkerSource, /PORTAL_SHELL_UPDATED/);
});


test('la ruta visual admite el portal con o sin barra final', () => {
  assert.match(installSource, /window\.location\.pathname\.replace\(\/\\\/\+\$\//);
  assert.match(installSource, /normalizedPath !== '\/operaciones\/portal'/);
});


test('el manifiesto conserva PWA para plataformas no Android', () => {
  assert.equal(manifest.id, '/operaciones/portal');
  assert.equal(manifest.start_url, '/operaciones/portal');
  assert.equal(manifest.scope, '/operaciones/portal');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.prefer_related_applications, false);
  assert.ok(Array.isArray(manifest.icons));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192'));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'));
});
