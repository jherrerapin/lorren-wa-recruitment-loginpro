import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('Gestión de Tiempo conserva una sola ruta canónica sin redirect heredado', () => {
  const attendanceRoute = source('src/routes/dispatchAttendanceAdmin.js');
  const navigation = source('src/services/adminNavigation.js');
  const bridge = source('src/routes/dispatchBridge.js');
  const audit = source('src/services/dispatchAuditMiddleware.js');

  assert.match(attendanceRoute, /PAYROLL_CANONICAL_ROUTE = '\/gestion-tiempo'/);
  assert.doesNotMatch(attendanceRoute, /legacyPayrollRedirectTarget|PAYROLL_LEGACY_ROUTE/);
  assert.doesNotMatch(navigation, /LEGACY_PAYROLL_PATH|normalizePayrollPaths/);
  assert.doesNotMatch(bridge, /LEGACY_PAYROLL_PATH/);
  assert.match(audit, /asistencia\/gestion-tiempo/);
});

test('las vistas y exportaciones usan el nombre canónico del módulo', () => {
  const mainView = source('src/views/operacionesGestionTiempo.ejs');
  const exportView = source('src/views/operacionesGestionTiempoExport.ejs');
  const testView = source('src/views/operacionesPruebasGestionTiempo.ejs');

  for (const content of [mainView, exportView, testView]) {
    assert.match(content, /Gestión de Tiempo|gestion-tiempo/);
  }
});
