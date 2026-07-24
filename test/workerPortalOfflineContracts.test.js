import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const routeSource = fs.readFileSync(new URL('../src/routes/workerPortal.js', import.meta.url), 'utf8');
const viewSource = fs.readFileSync(new URL('../src/views/workerPortal.ejs', import.meta.url), 'utf8');
const offlineSource = fs.readFileSync(new URL('../src/public/worker-portal-offline.js', import.meta.url), 'utf8');
const serviceWorkerSource = fs.readFileSync(new URL('../src/public/worker-portal-sw.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../src/public/worker-portal.webmanifest', import.meta.url), 'utf8'));
const release = JSON.parse(fs.readFileSync(new URL('../src/public/attendance-portal-release.json', import.meta.url), 'utf8'));

test('el portal es instalable y su alcance incluye la URL raíz de la jornada', () => {
  assert.equal(manifest.id, '/operaciones/portal');
  assert.equal(manifest.start_url, '/operaciones/portal');
  assert.equal(manifest.scope, '/operaciones/portal');
  assert.equal(manifest.display, 'standalone');
  assert.match(viewSource, /rel="manifest" href="\/operaciones\/portal\/manifest\.webmanifest"/);
  assert.ok(manifest.icons.every((icon) => icon.src === '/operaciones/portal/icon.svg'));
});

test('el service worker se sirve desde el portal con alcance explícito y sin caché HTTP', () => {
  assert.match(routeSource, /router\.get\('\/service-worker\.js'/);
  assert.match(routeSource, /Service-Worker-Allowed', WORKER_PORTAL_HOME_PATH/);
  assert.match(routeSource, /no-cache, no-store, must-revalidate/);
  assert.match(routeSource, /worker-src 'self'/);
  assert.match(routeSource, /manifest-src 'self'/);
});

test('el runtime, manifest e icono se solicitan dentro del alcance del service worker', () => {
  assert.match(viewSource, /src="\/operaciones\/portal\/offline\.js"/);
  assert.match(viewSource, /href="\/operaciones\/portal\/icon\.svg"/);
  assert.match(routeSource, /router\.get\('\/offline\.js'/);
  assert.match(routeSource, /router\.get\('\/manifest\.webmanifest'/);
  assert.match(routeSource, /router\.get\('\/icon\.svg'/);
  assert.match(serviceWorkerSource, /'\/operaciones\/portal\/offline\.js'/);
  assert.match(serviceWorkerSource, /'\/operaciones\/portal\/manifest\.webmanifest'/);
  assert.match(serviceWorkerSource, /'\/operaciones\/portal\/icon\.svg'/);
  assert.doesNotMatch(serviceWorkerSource, /'\/public\/worker-portal-offline\.js'/);
});

test('la cola offline usa IndexedDB, conserva la selfie y exige idempotencia', () => {
  assert.match(offlineSource, /indexedDB\.open/);
  assert.match(offlineSource, /arrivalQueue/);
  assert.match(offlineSource, /arrivalReceipts/);
  assert.match(offlineSource, /selfie: payload\.selfie/);
  assert.match(offlineSource, /idempotencyKey/);
  assert.doesNotMatch(offlineSource, /activationToken/);
  assert.doesNotMatch(serviceWorkerSource, /activationToken/);
});

test('la sincronización reenvía multipart con cookies, conserva la hora capturada y no borra antes de confirmar', () => {
  assert.match(serviceWorkerSource, /credentials: 'include'/);
  assert.match(serviceWorkerSource, /form\.set\('clientCapturedAt'/);
  assert.match(serviceWorkerSource, /form\.set\('captureMode', 'OFFLINE_WEB'\)/);
  const fetchIndex = serviceWorkerSource.indexOf('response = await fetch');
  const completionIndex = serviceWorkerSource.indexOf('await completeQueueRecord(record', fetchIndex);
  assert.ok(fetchIndex >= 0);
  assert.ok(completionIndex > fetchIndex);
});

test('la sincronización tiene Background Sync y respaldo por mensaje del portal', () => {
  assert.match(offlineSource, /registration\.sync\.register\(SYNC_TAG\)/);
  assert.match(offlineSource, /SYNC_ARRIVALS/);
  assert.match(serviceWorkerSource, /self\.addEventListener\('sync'/);
  assert.match(serviceWorkerSource, /self\.addEventListener\('message'/);
  assert.match(serviceWorkerSource, /CACHE_PORTAL/);
});

test('solo se conserva offline una página autenticada y activa', () => {
  assert.match(routeSource, /X-Lorren-Worker-Portal-Mode/);
  assert.match(serviceWorkerSource, /mode === 'active'/);
  assert.match(serviceWorkerSource, /mode === 'inactive'/);
  assert.match(serviceWorkerSource, /cache\.delete\(PORTAL_CACHE_KEY\)/);
});

test('la interfaz comunica claramente la marca local y sus estados de sincronización', () => {
  assert.match(viewSource, /Guardar llegada sin internet/);
  assert.match(viewSource, /Llegada guardada offline/);
  assert.match(viewSource, /Sincronizando llegada/);
  assert.match(viewSource, /Llegada sincronizada · en revisión/);
  assert.match(viewSource, /no se eliminará hasta que Lórren confirme/);
});

test('el marcador de versión publica las capacidades offline', () => {
  assert.ok(Array.isArray(release.features));
  assert.ok(release.features.includes('offline-web-arrival'));
  assert.ok(release.features.includes('indexeddb-queue'));
  assert.ok(release.features.includes('background-sync'));
});
