import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { injectAdminModuleNavigation } from '../src/services/adminNavigation.js';

const baseHtml = `<!DOCTYPE html><html><head><title>Panel</title></head><body><nav class="navbar"><a href="/admin">Panel</a><a href="/admin/vacancies">Vacantes</a><a href="/admin/users">Usuarios</a><a href="/admin/operaciones">Operaciones</a><form method="post" action="/logout"><button>Cerrar sesión</button></form></nav><main>Contenido</main></body></html>`;

function req(path, permissions = {}, role = 'admin') {
  return { originalUrl: path, userRole: role, session: { userRole: role, ...permissions }, ...permissions };
}

function nav(html) {
  return html.match(/<nav\b[\s\S]*?<\/nav>/i)?.[0] || '';
}

test('DEV recibe menus desplegables por modulo sin recuadros fijos', () => {
  const html = injectAdminModuleNavigation(baseHtml, req('/admin', {}, 'dev'));
  const navbar = nav(html);
  assert.match(navbar, /data-module-menu="recruitment"/);
  assert.match(navbar, /data-module-menu="operations"/);
  assert.match(navbar, /data-module-menu="payroll"/);
  assert.match(navbar, /href="\/admin\/monitor"/);
  assert.match(navbar, /href="\/admin\/bot-knowledge"/);
  assert.match(navbar, /href="\/admin\/operaciones\/pruebas"/);
  assert.doesNotMatch(navbar, />Herramientas</);
  assert.doesNotMatch(html, /data-module-cards=|admin-module-switcher|admin-module-card-grid/);
});

test('cada desplegable conserva sus opciones y permisos existentes', () => {
  const recruitment = nav(injectAdminModuleNavigation(baseHtml, req('/admin', { canAccessStatistics: true })));
  assert.match(recruitment, /href="\/admin">Panel de candidatos<\/a>/);
  assert.match(recruitment, /href="\/admin\/vacancies">Vacantes<\/a>/);
  assert.match(recruitment, /href="\/admin\/users">Usuarios<\/a>/);
  assert.match(recruitment, /href="\/admin\/estadisticas">Estadísticas<\/a>/);
  assert.doesNotMatch(recruitment, /data-module-menu="operations"|data-module-menu="payroll"/);

  const operations = nav(injectAdminModuleNavigation(baseHtml, req('/admin/operaciones', { canAccessDispatch: true, canAccessAttendance: true })));
  for (const href of ['/admin/operaciones/clientes', '/admin/operaciones/solicitudes', '/admin/operaciones/asignaciones', '/admin/operaciones/personal', '/admin/operaciones/asistencia', '/admin/operaciones/whatsapp']) {
    assert.ok(operations.includes(`href="${href}"`), `Falta ${href} en Operaciones`);
  }
  assert.doesNotMatch(operations, /data-module-menu="payroll"/);

  const payroll = nav(injectAdminModuleNavigation(baseHtml, req('/admin/operaciones/asistencia/nomina', { canAccessDispatch: true, canAccessPayroll: true, canAccessTestWorkspace: true })));
  assert.match(payroll, /data-module-menu="payroll"/);
  assert.match(payroll, /href="\/admin\/operaciones\/asistencia\/nomina">Nómina y tiempo trabajado<\/a>/);
  assert.match(payroll, /href="\/admin\/operaciones\/pruebas">Entorno de pruebas<\/a>/);
});

test('entorno de pruebas DEV no depende de permiso de Despacho para seguir visible', () => {
  const navbar = nav(injectAdminModuleNavigation(baseHtml, req('/admin/operaciones/pruebas', { canAccessTestWorkspace: true })));
  assert.match(navbar, /data-module-menu="operations"/);
  assert.match(navbar, /href="\/admin\/operaciones\/pruebas">Entorno de pruebas<\/a>/);
  assert.doesNotMatch(navbar, /href="\/admin\/operaciones">Panel operativo<\/a>/);
});

test('dropdown responsive y header sticky de escritorio quedan declarados', async () => {
  const html = injectAdminModuleNavigation(baseHtml, req('/admin'));
  const [css, desktop] = await Promise.all([
    readFile(new URL('../src/public/admin-module-navigation.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/public/admin-module-navigation-desktop.css', import.meta.url), 'utf8')
  ]);
  assert.match(html, /admin-module-navigation-desktop\.css" media="\(min-width: 901px\)"/);
  assert.match(css, /\.admin-module-menu-panel[\s\S]*position:\s*absolute/);
  assert.match(css, /@media \(max-width:\s*900px\)[\s\S]*\.admin-module-menu-panel[\s\S]*position:\s*static/);
  assert.match(desktop, /position:\s*sticky/);
  assert.match(desktop, /top:\s*0/);
});

test('inyeccion sigue siendo idempotente y evita APIs de Nomina', () => {
  const request = req('/admin', { canAccessDispatch: true, canAccessPayroll: true });
  const once = injectAdminModuleNavigation(baseHtml, request);
  assert.equal(injectAdminModuleNavigation(once, request), once);
  assert.equal(injectAdminModuleNavigation(baseHtml, req('/admin/operaciones/asistencia/nomina/api/users/sample', { canAccessPayroll: true })), baseHtml);
});