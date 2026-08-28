import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const PAYROLL_PATH = '/admin/operaciones/asistencia/nomina';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('los enlaces visibles del módulo usan Gestión de Tiempo sin cambiar la ruta canónica', async () => {
  const [navigation, exportView, testWorkspaceView] = await Promise.all([
    source('src/services/adminNavigation.js'),
    source('src/views/operacionesNominaExport.ejs'),
    source('src/views/operacionesPruebasNomina.ejs')
  ]);

  assert.match(navigation, /menuLink\(PAYROLL_PATH, 'Gestión de Tiempo'\)/);
  assert.match(navigation, /key: 'payroll', label: 'Gestión de Tiempo'/);
  assert.match(navigation, new RegExp(PAYROLL_PATH.replaceAll('/', '\\/')));
  assert.doesNotMatch(navigation, /menuLink\(PAYROLL_PATH, 'Nómina/);
  assert.doesNotMatch(navigation, /key: 'payroll', label: 'Nómina'/);

  assert.match(exportView, />Gestión de Tiempo<\/a>/);
  assert.match(exportView, />Volver a Gestión de Tiempo<\/a>/);
  assert.doesNotMatch(exportView, />Nómina<\/a>|>Volver a nómina<\/a>/);

  assert.match(testWorkspaceView, />Gestión de Tiempo con pruebas<\/a>/);
  assert.match(testWorkspaceView, />Abrir Gestión de Tiempo con pruebas<\/a>/);
  assert.doesNotMatch(testWorkspaceView, />Nómina con pruebas<\/a>|>Abrir Nómina con pruebas<\/a>/);
});
