import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_MODULE_PATHS,
  buildAdminModuleCards,
  injectAdminModuleNavigation
} from '../src/services/adminNavigation.js';

const baseHtml = `<!DOCTYPE html>
<html>
<head><title>Panel</title></head>
<body>
<nav class="navbar">
  <a class="brand" href="/admin">LoginPro</a>
  <a href="/admin">Panel</a>
  <a href="/admin/vacancies">Vacantes</a>
  <a href="/admin/users">Usuarios</a>
  <a href="/admin/operaciones">Operaciones / Despacho</a>
  <a href="/admin/monitor">Monitor</a>
  <a href="/admin/bot-knowledge">Aprendizajes Lórren</a>
  <span class="spacer"></span>
  <form method="post" action="/logout"><button type="submit">Cerrar sesión</button></form>
</nav>
<main>Contenido</main>
</body>
</html>`;

function request(path, capabilities = {}, role = 'admin') {
  return {
    originalUrl: path,
    userRole: role,
    session: { userRole: role, ...capabilities },
    ...capabilities
  };
}

function renderedNav(html) {
  return html.match(/<nav\b[\s\S]*?<\/nav>/i)?.[0] || '';
}

test('DEV ve los tres módulos y conserva sus herramientas especiales', () => {
  const html = injectAdminModuleNavigation(baseHtml, request('/admin', {}, 'dev'));
  const nav = renderedNav(html);

  assert.match(nav, /data-module-navigation="true"/);
  assert.match(nav, /href="\/admin"[^>]*data-module="recruitment"/);
  assert.match(nav, /href="\/admin\/operaciones"[^>]*data-module="operations"/);
  assert.match(nav, /href="\/admin\/operaciones\/asistencia\/nomina"[^>]*data-module="payroll"/);
  assert.match(nav, /href="\/admin\/monitor"/);
  assert.match(nav, /href="\/admin\/bot-knowledge"/);
  assert.match(nav, /href="\/admin\/operaciones\/pruebas"/);
  assert.match(html, /data-module-cards="true"/);
  assert.match(html, /href="\/public\/admin-module-navigation\.css"/);
});

test('un reclutador sin permisos operativos ve solo Reclutamiento y conserva Usuarios si la vista ya lo autorizó', () => {
  const html = injectAdminModuleNavigation(baseHtml, request('/admin'));
  const nav = renderedNav(html);

  assert.match(nav, /data-module="recruitment"/);
  assert.doesNotMatch(nav, /data-module="operations"/);
  assert.doesNotMatch(nav, /data-module="payroll"/);
  assert.match(nav, /href="\/admin\/users"/);
  assert.doesNotMatch(nav, /href="\/admin\/monitor"/);
  assert.doesNotMatch(nav, /href="\/admin\/bot-knowledge"/);
});

test('Operaciones agrupa Asistencia y no expone Nómina sin su permiso independiente', () => {
  const html = injectAdminModuleNavigation(
    baseHtml,
    request('/admin/operaciones', { canAccessDispatch: true, canAccessAttendance: true })
  );

  assert.match(html, /data-module-card="operations"/);
  assert.match(html, /href="\/admin\/operaciones\/asistencia"[^>]*>Asistencia<\/a>/);
  assert.doesNotMatch(renderedNav(html), /data-module="payroll"/);
  assert.doesNotMatch(html, /data-module-card="payroll"/);
});

test('Nómina aparece solo con permiso y permite regresar a otros módulos disponibles', () => {
  const html = injectAdminModuleNavigation(
    baseHtml,
    request('/admin/operaciones/asistencia/nomina', {
      canAccessDispatch: true,
      canAccessAttendance: true,
      canAccessPayroll: true
    })
  );
  const nav = renderedNav(html);

  assert.match(nav, /data-module="recruitment"/);
  assert.match(nav, /data-module="operations"/);
  assert.match(nav, /data-module="payroll"/);
  assert.match(nav, /admin-module-nav-link is-active[^>]*href="\/admin\/operaciones\/asistencia\/nomina"/);
  assert.match(html, /data-module-card="payroll"/);
});

test('los recuadros grandes se muestran solo en las entradas principales de cada módulo', () => {
  const access = { canAccessDispatch: true, canAccessAttendance: true, canAccessPayroll: true };
  assert.match(buildAdminModuleCards(request('/admin', access), baseHtml), /data-module-card="recruitment"/);
  assert.match(buildAdminModuleCards(request('/admin/operaciones', access), baseHtml), /data-module-card="operations"/);
  assert.match(buildAdminModuleCards(request(ADMIN_MODULE_PATHS.payroll, access), baseHtml), /data-module-card="payroll"/);
  assert.equal(buildAdminModuleCards(request('/admin/operaciones/clientes', access), baseHtml), '');
});

test('la inyección es idempotente y no altera endpoints API ni HTML sin navbar', () => {
  const req = request('/admin', { canAccessDispatch: true, canAccessPayroll: true });
  const once = injectAdminModuleNavigation(baseHtml, req);
  assert.equal(injectAdminModuleNavigation(once, req), once);
  assert.equal(
    injectAdminModuleNavigation(baseHtml, request('/admin/operaciones/asistencia/nomina/api/users/TEST-ID', { canAccessPayroll: true })),
    baseHtml
  );
  assert.equal(injectAdminModuleNavigation('<html><body>Sin navegación</body></html>', req), '<html><body>Sin navegación</body></html>');
});
