import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readView = (name) => readFile(new URL(`../src/views/${name}`, import.meta.url), 'utf8');

const MODULE_LINKS = [
  ['Reclutamiento', '/admin'],
  ['Operaciones / Despacho', '/admin/operaciones'],
  ['Nómina', '/admin/operaciones/asistencia/nomina']
];

function assertModuleNavigation(source, viewName) {
  assert.match(source, /data-module-navigation/, `${viewName} debe declarar la navegación principal por módulos`);
  for (const [label, href] of MODULE_LINKS) {
    assert.ok(source.includes(label), `${viewName} debe conservar el módulo ${label}`);
    assert.ok(source.includes(`href="${href}"`), `${viewName} debe enlazar ${label} a ${href}`);
  }
}

test('las vistas principales agrupan Reclutamiento, Operaciones y Nómina sin cambiar sus rutas', async () => {
  const [recruitment, operations, payroll] = await Promise.all([
    readView('list.ejs'),
    readView('operacionesDashboard.ejs'),
    readView('operacionesNomina.ejs')
  ]);
  assertModuleNavigation(recruitment, 'list.ejs');
  assertModuleNavigation(operations, 'operacionesDashboard.ejs');
  assertModuleNavigation(payroll, 'operacionesNomina.ejs');
});

test('el agrupamiento conserva accesos especiales DEV existentes', async () => {
  const [recruitment, operations, payroll] = await Promise.all([
    readView('list.ejs'),
    readView('operacionesDashboard.ejs'),
    readView('operacionesNomina.ejs')
  ]);
  assert.match(recruitment, /href="\/admin\/monitor"/);
  assert.match(recruitment, /href="\/admin\/bot-knowledge"/);
  assert.match(operations, /href="\/admin\/monitor"/);
  assert.match(payroll, /href="\/admin\/operaciones\/pruebas"/);
});

test('operaciones mantiene Asistencia dentro del módulo y condiciona Nómina al permiso existente', async () => {
  const operations = await readView('operacionesDashboard.ejs');
  assert.match(operations, /href="\/admin\/operaciones\/asistencia"/);
  assert.match(operations, /canAccessAttendanceFeature/);
  assert.match(operations, /canAccessPayroll/);
});
