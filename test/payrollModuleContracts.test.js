import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Nómina queda montada dentro del módulo protegido de Asistencia', async () => {
  const source = await read('src/routes/dispatchAttendanceAdmin.js');
  assert.match(source, /import \{ dispatchPayrollRouter \} from '\.\/dispatchPayroll\.js';/);
  assert.match(source, /router\.use\('\/nomina', dispatchPayrollRouter\(prisma\)\);/);
});

test('el portal valida su propio permiso antes de mostrar información', async () => {
  const source = await read('src/routes/dispatchPayroll.js');
  assert.match(source, /resolvePayrollFeatureAccess/);
  assert.match(source, /No tienes permiso para acceder a Nómina y tiempo trabajado/);
  assert.match(source, /router\.get\('\/export\.csv'/);
  assert.match(source, /router\.get\('\/export\.xlsx'/);
});

test('la configuración de usuarios solo recibe el control cuando el perfil actual es DEV', async () => {
  const middleware = await read('src/services/dispatchAuditMiddleware.js');
  const client = await read('src/public/payroll-user-access.js');
  assert.match(middleware, /path !== '\/admin\/users' \|\| role !== 'dev'/);
  assert.match(middleware, /PAYROLL_USERS_SCRIPT/);
  assert.doesNotMatch(client, /:has\(/);
  assert.match(client, /Nómina y tiempo trabajado/);
});

test('conceder Nómina exige DEV y activa los módulos padre', async () => {
  const source = await read('src/services/payrollFeatureAccess.js');
  assert.match(source, /actorRole !== 'dev'/);
  assert.match(source, /canAccessDispatch: true, canAccessAttendance: true/);
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
