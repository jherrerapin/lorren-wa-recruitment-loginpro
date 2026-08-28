import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFile } from 'node:fs/promises';
import {
  ADMIN_MODULE_PATHS,
  injectAdminModuleNavigation
} from '../src/services/adminNavigation.js';
import {
  dispatchAttendanceAdminRouter,
  legacyPayrollRedirectTarget
} from '../src/routes/dispatchAttendanceAdmin.js';

const PAYROLL_PATH = '/admin/operaciones/asistencia/gestion-tiempo';
const LEGACY_PAYROLL_PATH = '/admin/operaciones/asistencia/nomina';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

function adminRequest(path = PAYROLL_PATH) {
  return {
    originalUrl: path,
    userRole: 'dev',
    canAccessPayroll: true,
    session: { userRole: 'dev', canAccessPayroll: true }
  };
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

test('Gestión de Tiempo usa una ruta pública canónica y normaliza enlaces heredados al renderizar', async () => {
  const [exportView, testWorkspaceView] = await Promise.all([
    source('src/views/operacionesNominaExport.ejs'),
    source('src/views/operacionesPruebasNomina.ejs')
  ]);

  assert.equal(ADMIN_MODULE_PATHS.payroll, PAYROLL_PATH);

  const representativeHtml = `<!DOCTYPE html><html><head><title>Nómina y tiempo trabajado — LoginPro</title></head><body>
    <nav class="navbar"><a href="${LEGACY_PAYROLL_PATH}">Gestión de Tiempo</a></nav>
    <main><h1>Nómina y tiempo trabajado</h1><form action="${LEGACY_PAYROLL_PATH}/imports/preview" method="post"></form></main>
  </body></html>`;
  const normalized = injectAdminModuleNavigation(representativeHtml, adminRequest());
  assert.match(normalized, new RegExp(PAYROLL_PATH.replaceAll('/', '\\/')));
  assert.doesNotMatch(normalized, new RegExp(LEGACY_PAYROLL_PATH.replaceAll('/', '\\/')));
  assert.match(normalized, /<title>Gestión de Tiempo — LoginPro<\/title>/);
  assert.match(normalized, /<h1>Gestión de Tiempo<\/h1>/);
  assert.doesNotMatch(normalized, /Nómina y tiempo trabajado/);

  for (const rawView of [exportView, testWorkspaceView]) {
    const visibleHtml = injectAdminModuleNavigation(rawView, adminRequest());
    assert.doesNotMatch(visibleHtml, new RegExp(LEGACY_PAYROLL_PATH.replaceAll('/', '\\/')));
    assert.match(visibleHtml, new RegExp(PAYROLL_PATH.replaceAll('/', '\\/')));
  }
});

test('el enlace viejo redirige permanentemente a Gestión de Tiempo sin crear otra autoridad', async () => {
  assert.equal(legacyPayrollRedirectTarget({ url: '/' }), PAYROLL_PATH);
  assert.equal(
    legacyPayrollRedirectTarget({ url: '/?periodType=CUSTOM&from=2026-08-01' }),
    `${PAYROLL_PATH}?periodType=CUSTOM&from=2026-08-01`
  );
  assert.equal(
    legacyPayrollRedirectTarget({ url: '/export.xlsx?download=1' }),
    `${PAYROLL_PATH}/export.xlsx?download=1`
  );

  const app = express();
  app.use('/admin/operaciones/asistencia', dispatchAttendanceAdminRouter({}));
  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}${LEGACY_PAYROLL_PATH}/export.xlsx?download=1`, { redirect: 'manual' });
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('location'), `${PAYROLL_PATH}/export.xlsx?download=1`);
  });
});

test('los nombres visibles y el acceso conservan Gestión de Tiempo como presentación pública', async () => {
  const [navigation, bridge] = await Promise.all([
    source('src/services/adminNavigation.js'),
    source('src/routes/dispatchBridge.js')
  ]);
  assert.match(navigation, /menuLink\(PAYROLL_PATH, 'Gestión de Tiempo'\)/);
  assert.match(navigation, /key: 'payroll', label: 'Gestión de Tiempo'/);
  assert.match(navigation, /<title>Gestión de Tiempo — LoginPro<\/title>/);
  assert.doesNotMatch(navigation, /menuLink\(PAYROLL_PATH, 'Nómina/);
  assert.doesNotMatch(navigation, /key: 'payroll', label: 'Nómina'/);

  assert.match(bridge, /const PAYROLL_PATH = '\/admin\/operaciones\/asistencia\/gestion-tiempo'/);
  assert.match(bridge, /const LEGACY_PAYROLL_PATH = '\/admin\/operaciones\/asistencia\/nomina'/);
  assert.match(bridge, /path\.startsWith\(PAYROLL_PATH\) \|\| path\.startsWith\(LEGACY_PAYROLL_PATH\)/);
});
