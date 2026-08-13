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

function moduleMenu(html, key) {
  return html.match(new RegExp(`<details[^>]*data-module-menu="${key}"[\\s\\S]*?<\\/details>`))?.[0] || '';
}

test('los modulos comparten un grupo exclusivo y Usuarios queda independiente', () => {
  const html = injectAdminModuleNavigation(baseHtml, req('/admin', {}, 'dev'));
  const navbar = nav(html);

  assert.equal((navbar.match(/name="admin-primary-navigation"/g) || []).length, 3);
  assert.match(navbar, /data-module-menu="recruitment"/);
  assert.match(navbar, /data-module-menu="operations"/);
  assert.match(navbar, /data-module-menu="payroll"/);
  assert.match(navbar, /class="admin-module-standalone-link" href="\/admin\/users">Usuarios<\/a>/);
  assert.doesNotMatch(moduleMenu(navbar, 'recruitment'), /href="\/admin\/users"/);
  assert.match(navbar, /href="\/admin\/monitor"/);
  assert.match(navbar, /href="\/admin\/bot-knowledge"/);
  assert.match(navbar, /href="\/admin\/operaciones\/pruebas"/);
  assert.doesNotMatch(html, /data-module-cards=|admin-module-switcher|admin-module-card-grid/);
});

test('cada desplegable conserva sus opciones y permisos existentes', () => {
  const recruitment = nav(injectAdminModuleNavigation(baseHtml, req('/admin', { canAccessStatistics: true })));
  const recruitmentMenu = moduleMenu(recruitment, 'recruitment');
  assert.match(recruitmentMenu, /href="\/admin">Panel de candidatos<\/a>/);
  assert.match(recruitmentMenu, /href="\/admin\/vacancies">Vacantes<\/a>/);
  assert.match(recruitmentMenu, /href="\/admin\/estadisticas">Estadísticas<\/a>/);
  assert.doesNotMatch(recruitmentMenu, /Usuarios/);
  assert.match(recruitment, /admin-module-standalone-link[^>]*href="\/admin\/users"/);
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

test('Usuarios se marca activo sin marcar Reclutamiento como modulo activo', () => {
  const navbar = nav(injectAdminModuleNavigation(baseHtml, req('/admin/users')));
  assert.match(navbar, /class="admin-module-standalone-link is-active" href="\/admin\/users">Usuarios<\/a>/);
  assert.doesNotMatch(moduleMenu(navbar, 'recruitment'), /admin-module-menu is-active/);
});

test('entorno de pruebas no depende de permiso de Despacho para seguir visible', () => {
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
  assert.match(css, /admin-module-standalone-link/);
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