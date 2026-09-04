import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { injectAdminModuleNavigation } from '../src/services/adminNavigation.js';

const userAccess = readFileSync(new URL('../src/public/payroll-user-access.js', import.meta.url), 'utf8');
const payrollRoute = readFileSync(new URL('../src/routes/dispatchPayroll.js', import.meta.url), 'utf8');
const testWorkspaceRoute = readFileSync(new URL('../src/routes/dispatchDevPayrollTest.js', import.meta.url), 'utf8');
const exportView = readFileSync(new URL('../src/views/operacionesNominaExport.ejs', import.meta.url), 'utf8');

const LEGACY_WORD = /nómina/i;
const PRODUCT_NAME = 'Asistencia y Gestión de Tiempo';

test('permisos, Gestión de Tiempo y entorno de pruebas usan la nomenclatura aprobada', () => {
  assert.doesNotMatch(userAccess, LEGACY_WORD);
  assert.match(userAccess, new RegExp(PRODUCT_NAME));
  assert.doesNotMatch(payrollRoute, LEGACY_WORD);
  assert.match(payrollRoute, /workbook\.title = 'Asistencia y Gestión de Tiempo'/);
  assert.match(payrollRoute, /addWorksheet\('Asistencia y Gestión de Tiempo'\)/);
  assert.match(payrollRoute, /asistencia-gestion-tiempo-/);
  assert.doesNotMatch(testWorkspaceRoute, LEGACY_WORD);
  assert.match(testWorkspaceRoute, /Entorno de pruebas de Asistencia y Gestión de Tiempo/);
  assert.doesNotMatch(exportView, LEGACY_WORD);
});

test('el bridge administrativo elimina nomenclatura heredada antes de mostrar HTML', () => {
  const legacyWord = `n${String.fromCharCode(0xf3)}mina`;
  const title = `${legacyWord[0].toUpperCase()}${legacyWord.slice(1)} y tiempo trabajado`;
  const html = `<!doctype html><html><head><title>${title} — LoginPro</title></head><body><nav class="navbar"><a>${legacyWord}</a></nav><main><h1>${title}</h1><p>cálculo de ${legacyWord}</p></main></body></html>`;
  const normalized = injectAdminModuleNavigation(html, {
    originalUrl: '/admin/operaciones/asistencia/gestion-tiempo',
    session: { userRole: 'dev', canAccessPayroll: true, canAccessDispatch: true, canAccessAttendance: true }
  });

  assert.doesNotMatch(normalized, LEGACY_WORD);
  assert.match(normalized, /Asistencia y Gestión de Tiempo/);
});
