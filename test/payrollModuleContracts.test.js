import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Nómina conserva su ruta pero atraviesa las guardas con permiso propio', async () => {
  const bridge = await read('src/routes/dispatchBridge.js');
  const attendance = await read('src/routes/dispatchAttendanceAdmin.js');
  assert.match(attendance, /router\.use\('\/nomina', dispatchPayrollRouter\(prisma\)\);/);
  assert.match(bridge, /isPayrollRequest/);
  assert.match(bridge, /req\.canAccessPayrollFeature/);
  assert.match(bridge, /resolvePayrollFeatureAccess/);
});

test('Nómina operativa conserva exclusivamente su permiso propio', async () => {
  const source = await read('src/routes/dispatchPayroll.js');
  assert.match(source, /resolvePayrollFeatureAccess/);
  assert.doesNotMatch(source, /resolveTestWorkspaceFeatureAccess/);
  assert.match(source, /No tienes permiso para acceder a Nómina y tiempo trabajado/);
  assert.match(source, /router\.get\('\/export\.csv'/);
  assert.match(source, /router\.get\('\/export\.xlsx'/);
});

test('el entorno de pruebas valida su permiso y calcula dentro de su propia ruta', async () => {
  const route = await read('src/routes/dispatchDevPayrollTestV2.js');
  assert.match(route, /resolveTestWorkspaceFeatureAccess/);
  assert.match(route, /loadTestWorkspacePayrollReport/);
  assert.match(route, /No tienes permiso para acceder al entorno de pruebas/);
});

test('la configuración de usuarios solo recibe los controles cuando el perfil actual es DEV', async () => {
  const middleware = await read('src/services/dispatchAuditMiddleware.js');
  const client = await read('src/public/payroll-user-access.js');
  assert.match(middleware, /path !== '\/admin\/users' \|\| role !== 'dev'/);
  assert.match(middleware, /PAYROLL_USERS_SCRIPT/);
  assert.doesNotMatch(client, /:has\(/);
  assert.match(client, /No activa Operaciones ni Asistencia/);
  assert.match(client, /Entorno de pruebas de asistencia y nómina/);
  assert.match(client, /registros DEV_TEST aislados/);
});

test('conceder Nómina exige DEV y no cambia los módulos padre', async () => {
  const source = await read('src/services/payrollFeatureAccess.js');
  assert.match(source, /actorRole !== 'dev'/);
  assert.doesNotMatch(source, /canAccessDispatch: true, canAccessAttendance: true/);
  assert.match(source, /parentPermissionsChanged: false/);
  assert.match(source, /PAYROLL_ACCESS_ENABLED/);
  assert.match(source, /PAYROLL_ACCESS_DISABLED/);
});

test('la exportación incluye los quince conceptos solicitados', async () => {
  const engine = await read('src/modules/dispatch-payroll/domain/payrollConceptEngine.js');
  const expected = [
    'HEDO', 'HENO', 'HEDD', 'HEND', 'HEDF', 'HENF',
    'RNO', 'RDD', 'RND', 'RDF', 'RNF', 'RDDC', 'RNDC', 'RDFC', 'RNFC'
  ];
  for (const code of expected) assert.match(engine, new RegExp(`'${code}'`));
  assert.match(engine, /minutesToDecimalHours/);
});
