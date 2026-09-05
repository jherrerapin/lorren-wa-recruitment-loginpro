import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const adminRoute = fs.readFileSync('src/routes/dispatchWorkerPortalActivationAdmin.js', 'utf8');
const portalCore = fs.readFileSync('src/routes/workerPortalCore.js', 'utf8');
const adminControl = fs.readFileSync('src/public/attendance-admin-portal-control.js', 'utf8');
const adminRuntime = fs.readFileSync('src/public/attendance-admin-runtime.js', 'utf8');

test('el interruptor administrativo existe solo detrás de autorización DEV', () => {
  assert.match(adminRoute, /function requireDevOnly/);
  assert.match(adminRoute, /currentRole\(req\) !== 'dev'/);
  assert.match(adminRoute, /status\(404\)\.json\(\{ ok: false, error: 'not_found' \}\)/);
  assert.match(adminRoute, /router\.get\('\/service-state', requireDevOnly/);
  assert.match(adminRoute, /router\.post\('\/service-state', requireDevOnly, requireAdminJson, adminJson/);
});

test('la interfaz no crea el botón hasta que el endpoint DEV confirme acceso', () => {
  assert.match(adminControl, /const STATE_ENDPOINT = '\/admin\/operaciones\/portal-activaciones\/service-state'/);
  assert.match(adminControl, /if \(!response\.ok\) return;/);
  assert.match(adminControl, /renderControl\(payload\)/);
  assert.doesNotMatch(adminControl, /confirm\s*\(/);
  assert.doesNotMatch(adminControl, /lorren-dialog/);
  assert.match(adminRuntime, /attendance-admin-portal-control\.js/);
});

test('el portal público se cierra en servidor y ordena limpiar el shell activo de la PWA', () => {
  assert.match(portalCore, /isWorkerPortalServiceEnabled/);
  assert.match(portalCore, /portalServiceEnabledFn/);
  assert.match(portalCore, /renderPortal\(res, 'unavailable', nonce, \{ headerMode: 'inactive' \}\)/);
  assert.match(portalCore, /portal_service_disabled/);
  assert.match(portalCore, /portal_service_disabled_at_capture/);
  assert.match(portalCore, /isWorkerPortalServiceEnabledAt/);
});
