import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const routeSource = fs.readFileSync(new URL('../src/routes/workerPortalCore.js', import.meta.url), 'utf8');
const strictRouteSource = fs.readFileSync(new URL('../src/routes/workerPortal.js', import.meta.url), 'utf8');
const viewSource = fs.readFileSync(new URL('../src/views/workerPortal.ejs', import.meta.url), 'utf8');
const loaderSource = fs.readFileSync(new URL('../src/public/worker-biometric.js', import.meta.url), 'utf8');
const biometricFlowSource = fs.readFileSync(new URL('../src/public/worker-portal-biometric-flow.js', import.meta.url), 'utf8');
const offlineSource = fs.readFileSync(new URL('../src/public/worker-portal-offline.js', import.meta.url), 'utf8');
const offlineControllerSource = fs.readFileSync(new URL('../src/public/worker-portal-offline-controller.js', import.meta.url), 'utf8');
const serviceWorkerSource = fs.readFileSync(new URL('../src/public/worker-portal-sw.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../src/public/worker-portal.webmanifest', import.meta.url), 'utf8'));
const release = JSON.parse(fs.readFileSync(new URL('../src/public/attendance-portal-release.json', import.meta.url), 'utf8'));


test('el portal es instalable y su alcance incluye la jornada', () => {
  assert.equal(manifest.id, '/operaciones/portal');
  assert.equal(manifest.start_url, '/operaciones/portal');
  assert.equal(manifest.scope, '/operaciones/portal');
  assert.equal(manifest.display, 'standalone');
  assert.match(viewSource, /rel="manifest" href="\/operaciones\/portal\/manifest\.webmanifest"/);
});


test('el service worker se sirve con alcance explícito', () => {
  assert.match(routeSource, /router\.get\('\/service-worker\.js'/);
  assert.match(routeSource, /Service-Worker-Allowed', WORKER_PORTAL_HOME_PATH/);
  assert.match(routeSource, /worker-src 'self'/);
});


test('el cargador incluye una sola cola offline y su controlador', () => {
  assert.match(loaderSource, /worker-portal-offline\.js/);
  assert.doesNotMatch(loaderSource, /worker-portal-offline-v2\.js/);
  assert.match(loaderSource, /worker-portal-offline-controller\.js/);
  assert.match(serviceWorkerSource, /'\/public\/worker-biometric\.js'/);
  assert.match(serviceWorkerSource, /'\/public\/worker-biometric-core\.js'/);
  assert.match(serviceWorkerSource, /'\/public\/worker-biometric-mobile\.js'/);
  assert.match(serviceWorkerSource, /'\/public\/worker-portal-biometric-flow\.js'/);
  assert.match(serviceWorkerSource, /'\/public\/worker-portal-offline\.js'/);
  assert.doesNotMatch(serviceWorkerSource, /worker-portal-offline-v2\.js/);
  assert.match(serviceWorkerSource, /'\/public\/worker-portal-offline-controller\.js'/);
});


test('perder internet no se interpreta como ausencia de registro facial', () => {
  assert.match(biometricFlowSource, /async function loadBiometricStatus\(\) \{\s*if \(!navigator\.onLine\) \{\s*closeEnrollmentDialog\(\);\s*return;/s);
  assert.match(biometricFlowSource, /window\.addEventListener\('offline', enterOfflineMode\)/);
  assert.match(biometricFlowSource, /if \(navigator\.onLine\) loadBiometricStatus\(\);\s*else closeEnrollmentDialog\(\);/s);
  assert.doesNotMatch(
    biometricFlowSource,
    /catch\s*\{[\s\S]*?showModal\(enrollmentDialog\)[\s\S]*?startEnrollmentButton\.disabled = true/
  );
});


test('los botones regenerados por el modo offline conservan control online al reconectar', () => {
  assert.match(biometricFlowSource, /function currentMarkButtons\(\)/);
  assert.match(biometricFlowSource, /function markButtonFromEvent\(event\)/);
  assert.match(biometricFlowSource, /document\.addEventListener\('click',[\s\S]*openMarkDialog\(button\)/);
  assert.doesNotMatch(biometricFlowSource, /const markButtons =/);
  assert.match(biometricFlowSource, /data-offline-disabled/);
});


test('la cola offline cubre llegada, almuerzo y salida con idempotencia', () => {
  assert.match(offlineSource, /indexedDB\.open/);
  assert.match(offlineSource, /arrivalQueue/);
  assert.match(offlineSource, /arrivalReceipts/);
  assert.match(offlineSource, /idempotencyKey/);
  assert.match(offlineSource, /'ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE'/);
  assert.match(offlineSource, /queueBreakStart/);
  assert.match(offlineSource, /queueBreakEnd/);
  assert.match(offlineSource, /queueDeparture/);
});


test('la sincronización envía las cuatro marcaciones al endpoint correcto', () => {
  assert.match(serviceWorkerSource, /ARRIVAL: 'llegada'/);
  assert.match(serviceWorkerSource, /BREAK_START: 'inicio-almuerzo'/);
  assert.match(serviceWorkerSource, /BREAK_END: 'fin-almuerzo'/);
  assert.match(serviceWorkerSource, /DEPARTURE: 'salida'/);
  assert.match(serviceWorkerSource, /form\.set\('clientCapturedAt'/);
  assert.match(serviceWorkerSource, /form\.set\('captureMode', 'OFFLINE_WEB'\)/);
  assert.match(serviceWorkerSource, /credentials: 'include'/);
});


test('producción conserva biometría verificada online y admite evidencia offline para revisión', () => {
  assert.match(strictRouteSource, /captureMode === ONLINE_WEB_CAPTURE_MODE/);
  assert.match(strictRouteSource, /verifiedBiometricMetadata/);
  assert.match(strictRouteSource, /captureMode === OFFLINE_WEB_CAPTURE_MODE/);
  assert.match(strictRouteSource, /requiresReview: captureMode === OFFLINE_WEB_CAPTURE_MODE/);
  assert.doesNotMatch(strictRouteSource, /Esta marcación requiere conexión para validar el rostro/);
});


test('el controlador permite continuar la secuencia completa sin conexión', () => {
  assert.match(offlineControllerSource, /document\.addEventListener\('click'.*true\);/s);
  assert.match(offlineControllerSource, /Sin conexión: se guardarán la hora, la ubicación y una selfie/);
  assert.match(offlineControllerSource, /stage === 1/);
  assert.match(offlineControllerSource, /createMarkButton\('BREAK_START'\)/);
  assert.match(offlineControllerSource, /createMarkButton\('BREAK_END'\)/);
  assert.match(offlineControllerSource, /createMarkButton\('DEPARTURE'\)/);
  assert.match(offlineControllerSource, /MutationObserver/);
});


test('la sincronización tiene Background Sync y respaldo por mensaje', () => {
  assert.match(offlineSource, /await ready\.sync\.register\(SYNC_TAG\)/);
  assert.match(offlineSource, /SYNC_ARRIVALS/);
  assert.match(serviceWorkerSource, /self\.addEventListener\('sync'/);
  assert.match(serviceWorkerSource, /self\.addEventListener\('message'/);
  assert.match(serviceWorkerSource, /CACHE_PORTAL/);
});


test('solo se conserva offline una página autenticada', () => {
  assert.match(routeSource, /X-Lorren-Worker-Portal-Mode/);
  assert.match(serviceWorkerSource, /mode === 'active'/);
  assert.match(serviceWorkerSource, /mode === 'inactive'/);
  assert.match(serviceWorkerSource, /cache\.delete\(PORTAL_CACHE_KEY\)/);
  assert.match(serviceWorkerSource, /Abre el portal una vez con conexión/);
});


test('el marcador conserva capacidades de cálculo de jornada', () => {
  assert.ok(release.features.includes('worked-hours'));
  assert.ok(release.features.includes('break-start'));
  assert.ok(release.features.includes('break-end'));
  assert.ok(release.features.includes('actual-break-deduction'));
  assert.ok(release.features.includes('incomplete-break-90-minute-penalty'));
  assert.ok(release.features.includes('seven-hour-standard-workday'));
  assert.ok(release.features.includes('overtime-after-seven-hours'));
  assert.ok(release.features.includes('short-break-time-credit'));
  assert.ok(release.features.includes('no-break-time-credit'));
  assert.ok(release.features.includes('flexible-departure'));
  assert.ok(release.features.includes('open-arrival-marking'));
  assert.ok(release.features.includes('audited-early-time-recognition'));
  assert.equal(release.features.includes('bounded-arrival-window'), false);
  assert.equal(release.features.includes('unpaid-flexible-break'), false);
});