import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const routeSource = fs.readFileSync(new URL('../src/routes/workerPortalCore.js', import.meta.url), 'utf8');
const strictRouteSource = fs.readFileSync(new URL('../src/routes/workerPortal.js', import.meta.url), 'utf8');
const viewSource = fs.readFileSync(new URL('../src/views/workerPortal.ejs', import.meta.url), 'utf8');
const offlineSource = fs.readFileSync(new URL('../src/public/worker-portal-offline.js', import.meta.url), 'utf8');
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


test('los recursos offline están dentro del alcance', () => {
  assert.match(viewSource, /src="\/operaciones\/portal\/offline\.js"/);
  assert.match(serviceWorkerSource, /'\/operaciones\/portal\/offline\.js'/);
  assert.match(serviceWorkerSource, /'\/operaciones\/portal\/manifest\.webmanifest'/);
  assert.match(serviceWorkerSource, /'\/operaciones\/portal\/icon\.svg'/);
});


test('la cola heredada conserva idempotencia pero producción exige biometría en línea', () => {
  assert.match(offlineSource, /indexedDB\.open/);
  assert.match(offlineSource, /arrivalQueue/);
  assert.match(offlineSource, /arrivalReceipts/);
  assert.match(offlineSource, /idempotencyKey/);
  assert.match(offlineSource, /markType/);
  assert.match(strictRouteSource, /online_biometric_required/);
  assert.match(serviceWorkerSource, /La asistencia requiere conexión/);
});


test('la sincronización heredada conserva evidencia para registros antiguos', () => {
  assert.match(serviceWorkerSource, /credentials: 'include'/);
  assert.match(serviceWorkerSource, /form\.set\('clientCapturedAt'/);
  assert.match(serviceWorkerSource, /form\.set\('captureMode', 'OFFLINE_WEB'\)/);
  assert.match(serviceWorkerSource, /record\.markType === 'DEPARTURE' \? 'salida' : 'llegada'/);
});


test('la sincronización tiene Background Sync y respaldo por mensaje', () => {
  assert.match(offlineSource, /registration\.sync\.register\(SYNC_TAG\)/);
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
