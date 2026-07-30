import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Nómina global excluye pruebas por defecto y solo DEV puede solicitar su inclusión', async () => {
  const report = await read('src/modules/dispatch-payroll/application/payrollReport.js');
  const route = await read('src/routes/dispatchPayroll.js');
  assert.match(report, /DEV_TEST_REQUEST_SOURCE/);
  assert.match(report, /!filters\.includeTest && sessionIsTest/);
  assert.match(report, /isTestProfile: false/);
  assert.match(route, /roleFromRequest\(req\) === 'dev'/);
  assert.match(route, /delete input\.includeTest/);
  assert.doesNotMatch(route, /resolveTestWorkspaceFeatureAccess/);
});

test('el entorno autorizado crea solicitudes aisladas sin depender del módulo operativo', async () => {
  const view = await read('src/views/operacionesPruebasNomina.ejs');
  const bridge = await read('src/routes/dispatchBridge.js');
  const route = await read('src/routes/dispatchDevPayrollTest.js');
  assert.match(view, /Nueva solicitud de prueba/);
  assert.match(view, /Cliente existente/);
  assert.match(view, /\/admin\/operaciones\/pruebas\/solicitudes/);
  assert.match(bridge, /router\.use\('\/pruebas', dispatchDevPayrollTestRouter\(prisma\)\)/);
  assert.match(route, /requireTestWorkspaceAccess\(prisma\)/);
});

test('los estados DEV no se confunden con solicitudes o asignaciones operativas', async () => {
  const service = await read('src/services/dispatchDevPayrollTest.js');
  const attendance = await read('src/modules/dispatch-attendance/application/adminAttendance.js');
  assert.match(service, /status: 'DEV_TEST_PENDING'/);
  assert.match(service, /status: 'DEV_TEST_ASSIGNED'/);
  assert.match(service, /DEV_TEST_PARTIAL/);
  assert.match(service, /DEV_TEST_COMPLETE/);
  assert.doesNotMatch(service, /status: 'CONFIRMED'/);
  assert.match(attendance, /'ASSIGNED',[\s\S]*'CONFIRMATION_PENDING',[\s\S]*'CONFIRMED'/);
  assert.doesNotMatch(attendance, /DEV_TEST_ASSIGNED/);
});

test('el resultado interno usa solo sesiones DEV_TEST_MANUAL', async () => {
  const resultService = await read('src/services/testWorkspacePayrollReport.js');
  assert.match(resultService, /attendanceSession\?\.source === 'DEV_TEST_MANUAL'/);
  assert.match(resultService, /compensationByWorkerDate: new Map\(\)/);
  assert.match(resultService, /calculatePayrollConceptReport/);
});

test('el dashboard y sus exportaciones no cargan solicitudes DEV_TEST', async () => {
  const dashboard = await read('src/routes/dispatchDashboardMetrics.js');
  assert.match(dashboard, /DEV_TEST_REQUEST_SOURCE = 'DEV_TEST'/);
  assert.match(dashboard, /source: \{ not: DEV_TEST_REQUEST_SOURCE \}/);
  assert.match(dashboard, /request\.source === DEV_TEST_REQUEST_SOURCE/);
});
