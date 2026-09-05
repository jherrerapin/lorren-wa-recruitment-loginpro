import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFile } from 'node:fs/promises';
import { ADMIN_MODULE_PATHS } from '../src/services/adminNavigation.js';
import { dispatchAttendanceAdminRouter, legacyPayrollRedirectTarget } from '../src/routes/dispatchAttendanceAdmin.js';

const TIME_MANAGEMENT_PATH = '/admin/operaciones/asistencia/gestion-tiempo';
const LEGACY_TIME_MANAGEMENT_PATH = '/admin/operaciones/asistencia/nomina';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await run(origin);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('Gestión de Tiempo usa una sola ruta pública canónica en vistas y navegación', async () => {
  const [mainView, exportView, testWorkspaceView] = await Promise.all([
    source('src/views/operacionesGestionTiempo.ejs'),
    source('src/views/operacionesGestionTiempoExport.ejs'),
    source('src/views/operacionesPruebasGestionTiempo.ejs')
  ]);

  assert.equal(ADMIN_MODULE_PATHS.payroll, TIME_MANAGEMENT_PATH);
  for (const rawView of [mainView, exportView, testWorkspaceView]) {
    assert.match(rawView, new RegExp(TIME_MANAGEMENT_PATH.replaceAll('/', '\\/')));
    assert.doesNotMatch(rawView, new RegExp(LEGACY_TIME_MANAGEMENT_PATH.replaceAll('/', '\\/')));
  }
});

test('el alias histórico redirige 308 a Gestión de Tiempo sin crear otra autoridad', async () => {
  assert.equal(legacyPayrollRedirectTarget({ url: '/' }), TIME_MANAGEMENT_PATH);
  assert.equal(
    legacyPayrollRedirectTarget({ url: '/?periodType=CUSTOM&from=2026-08-01' }),
    `${TIME_MANAGEMENT_PATH}?periodType=CUSTOM&from=2026-08-01`
  );
  assert.equal(
    legacyPayrollRedirectTarget({ url: '/export.xlsx?download=1' }),
    `${TIME_MANAGEMENT_PATH}/export.xlsx?download=1`
  );

  const app = express();
  app.use('/admin/operaciones/asistencia', dispatchAttendanceAdminRouter({}));
  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}${LEGACY_TIME_MANAGEMENT_PATH}/export.xlsx?download=1`, { redirect: 'manual' });
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('location'), `${TIME_MANAGEMENT_PATH}/export.xlsx?download=1`);
  });
});

test('la compatibilidad histórica queda limitada a routing, permisos y auditoría', async () => {
  const [attendance, bridge, audit, navigation] = await Promise.all([
    source('src/routes/dispatchAttendanceAdmin.js'),
    source('src/routes/dispatchBridge.js'),
    source('src/services/dispatchAuditMiddleware.js'),
    source('src/services/adminNavigation.js')
  ]);

  assert.match(attendance, /PAYROLL_LEGACY_ROUTE/);
  assert.match(bridge, /LEGACY_PAYROLL_PATH/);
  assert.match(audit, /gestion-tiempo/);
  assert.doesNotMatch(navigation, /LEGACY_PAYROLL_PATH|normalizePayrollPaths/);
});
