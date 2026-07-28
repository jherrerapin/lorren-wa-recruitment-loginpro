import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Nómina excluye pruebas por defecto y solo DEV puede solicitar su inclusión', async () => {
  const report = await read('src/modules/dispatch-payroll/application/payrollReport.js');
  const route = await read('src/routes/dispatchPayroll.js');
  assert.match(report, /DEV_TEST_REQUEST_SOURCE/);
  assert.match(report, /!filters\.includeTest && sessionIsTest/);
  assert.match(report, /isTestProfile: false/);
  assert.match(route, /roleFromRequest\(req\) === 'dev'/);
  assert.match(route, /delete input\.includeTest/);
});

test('el formulario de solicitudes ofrece check de prueba solamente a DEV', async () => {
  const view = await read('src/views/operacionesSolicitudes.ejs');
  const bridge = await read('src/routes/dispatchBridge.js');
  assert.match(view, /role === 'dev'[\s\S]*Solicitud de prueba/);
  assert.match(view, /\/admin\/operaciones\/pruebas\/solicitudes/);
  assert.match(bridge, /router\.use\('\/pruebas', dispatchDevPayrollTestRouter\(prisma\)\)/);
});
