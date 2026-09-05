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

function standaloneLink(html, key) {
  return html.match(new RegExp(`<a[^>]*data-standalone-link="${key}"[^>]*>[\\s\\S]*?<\\/a>`))?.[0] || '';
}

function primaryNavigationGroup(html) {
  return html.match(/<div class="admin-module-nav-links" data-primary-nav-group="true">([\s\S]*?)<\/div>\s*<span class="spacer">/)?.[1] || '';
}

test('los modulos comparten un grupo exclusivo y Sucursales/Usuarios quedan independientes', () => {
  const html = injectAdminModuleNavigation(baseHtml, req('/admin', {}, 'dev'));
  const navbar = nav(html);

  assert.equal((navbar.match(/name="admin-primary-navigation"/g) || []).length, 3);
  assert.match(navbar, /data-module-menu="recruitment"/);
  assert.match(navbar, /data-module-menu="operations"/);
  assert.match(navbar, /data-module-menu="payroll"/);
  assert.match(standaloneLink(navbar, 'branches'), /class="admin-module-standalone-link"[^>]*href="\/admin\/locations"[\s\S]*<span>Sucursales<\/span>/);
  assert.match(standaloneLink(navbar, 'users'), /class="admin-module-standalone-link"[^>]*href="\/admin\/users"[\s\S]*<span>Usuarios<\/span>/);
  assert.doesNotMatch(moduleMenu(navbar, 'recruitment'), /href="\/admin\/locations"|href="\/admin\/users"/);
  assert.match(navbar, /href="\/admin\/monitor"/);
  assert.match(navbar, /href="\/admin\/bot-knowledge"/);
  assert.match(navbar, /href="\/admin\/operaciones\/pruebas"/);
  assert.doesNotMatch(html, /data-module-cards=|admin-module-switcher|admin-module-card-grid/);
});

test('Sucursales y Usuarios comparten el flujo visual primario sin entrar en desplegables', () => {
  const navbar = nav(injectAdminModuleNavigation(baseHtml, req('/admin/operaciones/asistencia', {
    canAccessDispatch: true,
    canAccessAttendance: true,
    canAccessPayroll: true
  }, 'dev')));
  const group = primaryNavigationGroup(navbar);

  assert.match(group, /data-module-menu="recruitment"/);
  assert.match(group, /data-module-menu="operations"/);
  assert.match(group, /data-module-menu="payroll"/);
  assert.match(group, /data-standalone-link="branches"/);
  assert.match(group, /data-standalone-link="users"/);
  assert.ok(group.indexOf('data-module-menu="payroll"') < group.indexOf('data-standalone-link="branches"'));
  assert.ok(group.indexOf('data-standalone-link="branches"') < group.indexOf('data-standalone-link="users"'));
  assert.doesNotMatch(moduleMenu(navbar, 'recruitment'), /data-standalone-link|Sucursales|Usuarios/);
  assert.match(navbar, /data-primary-nav-group="true"[\s\S]*data-standalone-link="branches"[\s\S]*data-standalone-link="users"[\s\S]*<\/div>\s*<span class="spacer">/);
});

test('Sucursales queda fuera de Reclutamiento y se marca activo como enlace independiente', () => {
  const recruitment = nav(injectAdminModuleNavigation(baseHtml, req('/admin', {
    canAccessStatistics: true,
    userSource: 'db',
    username: 'reclutador-general',
    userAccessScope: 'ALL'
  })));
  const recruitmentMenu = moduleMenu(recruitment, 'recruitment');
  assert.match(recruitmentMenu, /href="\/admin">Panel de candidatos<\/a>/);
  assert.doesNotMatch(recruitmentMenu, /href="\/admin\/locations"|>Sucursales<\/a>|href="\/admin\/vacancies"|>Vacantes<\/a>|>Ciudades<\/a>/);
  assert.match(recruitmentMenu, /href="\/admin\/estadisticas">Estadísticas<\/a>/);
  assert.match(standaloneLink(recruitment, 'branches'), /href="\/admin\/locations"[\s\S]*<span>Sucursales<\/span>/);
  assert.match(standaloneLink(recruitment, 'users'), /href="\/admin\/users"/);
  assert.doesNotMatch(recruitment, /data-module-menu="operations"|data-module-menu="payroll"/);

  const branches = nav(injectAdminModuleNavigation(baseHtml, req('/admin/locations')));
  assert.match(standaloneLink(branches, 'branches'), /class="admin-module-standalone-link is-active"/);
  assert.doesNotMatch(moduleMenu(branches, 'recruitment'), /admin-module-menu is-active/);
});

test('Sucursales y Usuarios muestran iconos PNG sin depender de emoji o SVG', () => {
  const navbar = nav(injectAdminModuleNavigation(baseHtml, req('/admin', {}, 'dev')));
  const branches = standaloneLink(navbar, 'branches');
  const users = standaloneLink(navbar, 'users');

  for (const link of [branches, users]) {
    assert.match(link, /class="admin-module-nav-icon"/);
    assert.match(link, /background-image:url\(data:image\/png;base64,[A-Za-z0-9+/=]+\)/);
    assert.doesNotMatch(link, /<svg\b|[🏢👥🏬🧑]/u);
  }
  assert.notEqual(branches, users);
});

test('cada desplegable conserva opciones y permisos de Operaciones y Gestión de Tiempo', () => {
  const operations = nav(injectAdminModuleNavigation(baseHtml, req('/admin/operaciones', { canAccessDispatch: true, canAccessAttendance: true })));
  for (const href of ['/admin/operaciones/clientes', '/admin/operaciones/solicitudes', '/admin/operaciones/asignaciones', '/admin/operaciones/personal', '/admin/operaciones/portal-activaciones', '/admin/operaciones/asistencia', '/admin/operaciones/whatsapp']) {
    assert.ok(operations.includes(`href="${href}"`), `Falta ${href} en Operaciones`);
  }

  const operationsWithoutAttendance = nav(injectAdminModuleNavigation(baseHtml, req('/admin/operaciones', { canAccessDispatch: true, canAccessAttendance: false })));
  assert.doesNotMatch(operationsWithoutAttendance, /href="\/admin\/operaciones\/portal-activaciones"/);
  assert.doesNotMatch(operationsWithoutAttendance, /href="\/admin\/operaciones\/asistencia"/);
  assert.doesNotMatch(operations, /data-module-menu="payroll"/);

  const payroll = nav(injectAdminModuleNavigation(baseHtml, req('/admin/operaciones/asistencia/gestion-tiempo', { canAccessDispatch: true, canAccessPayroll: true, canAccessTestWorkspace: true })));
  assert.match(payroll, /data-module-menu="payroll"/);
  assert.match(payroll, /data-module-menu="payroll"[\s\S]*<span>Gestión de Tiempo<\/span>/);
  assert.match(payroll, /href="\/admin\/operaciones\/asistencia\/gestion-tiempo">Gestión de Tiempo<\/a>/);
  assert.match(payroll, /href="\/admin\/operaciones\/pruebas">Entorno de pruebas<\/a>/);

  const legacyRequest = nav(injectAdminModuleNavigation(baseHtml, req('/admin/operaciones/asistencia/gestion-tiempo', { canAccessPayroll: true })));
  assert.match(legacyRequest, /admin-module-menu is-active/);
  assert.match(legacyRequest, /href="\/admin\/operaciones\/asistencia\/gestion-tiempo">Gestión de Tiempo<\/a>/);
});

test('el header elimina bloques duplicados y conserva acciones propias', () => {
  const source = `<!DOCTYPE html><html><head><title>Personal</title></head><body>
    <nav class="navbar"><a href="/admin">Panel</a><a href="/admin/operaciones">Operaciones</a></nav>
    <main>
      <div class="actions">
        <div class="action-item">
          <a class="btn btn-secondary" href="/admin/operaciones/personal">Personal operativo</a>
          <small>Consulta, sincroniza o crea auxiliares manualmente.</small>
        </div>
        <div class="action-item">
          <a class="btn btn-primary" href="/admin/operaciones/personal/nuevo">Crear auxiliar manual</a>
          <small>Acción propia que no está en el header.</small>
        </div>
      </div>
      <a class="btn btn-secondary" href="/admin/operaciones">Volver a Operaciones</a>
      <a class="btn btn-success" href="/admin/operaciones/portal-activaciones">Activar Portal del Auxiliar</a>
      <a class="btn btn-secondary" href="/admin/operaciones/personal/importar-excel">Importar Excel</a>
      <a class="text-link" href="/admin/operaciones">Enlace contextual sin apariencia de botón</a>
    </main>
  </body></html>`;
  const html = injectAdminModuleNavigation(source, req('/admin/operaciones/personal', { canAccessDispatch: true, canAccessAttendance: true }));

  assert.doesNotMatch(html, /Personal operativo<\/a>[\s\S]*Consulta, sincroniza o crea auxiliares manualmente/);
  assert.doesNotMatch(html, /class="btn btn-secondary" href="\/admin\/operaciones">Volver a Operaciones/);
  assert.doesNotMatch(html, /class="btn btn-success" href="\/admin\/operaciones\/portal-activaciones">Activar Portal del Auxiliar/);
  assert.match(html, /class="action-item">[\s\S]*href="\/admin\/operaciones\/personal\/nuevo">Crear auxiliar manual/);
  assert.match(html, /Acción propia que no está en el header/);
  assert.match(html, /class="actions"/);
  assert.match(html, /class="btn btn-secondary" href="\/admin\/operaciones\/personal\/importar-excel">Importar Excel/);
  assert.match(html, /class="text-link" href="\/admin\/operaciones">Enlace contextual sin apariencia de botón/);
  assert.match(moduleMenu(nav(html), 'operations'), /href="\/admin\/operaciones\/portal-activaciones">Activar portal del auxiliar<\/a>/);
});

test('dashboard de despacho queda compacto cuando todos sus accesos ya estan en el header', () => {
  const source = `<!DOCTYPE html><html><head><title>Operaciones</title></head><body>
    <nav class="navbar"><a href="/admin">Panel</a><a href="/admin/operaciones">Operaciones</a></nav>
    <main class="page">
      <section class="hero">
        <div><h1>Operaciones / Despacho</h1><p>Gestión operativa.</p></div>
        <div class="actions" aria-label="Acciones principales de operaciones">
          <div class="action-item"><a class="btn btn-primary" href="/admin/operaciones/clientes">Clientes</a><small>Crea clientes, puntos operativos y links públicos de solicitud.</small></div>
          <div class="action-item"><a class="btn" href="/admin/operaciones/solicitudes">Crear solicitud</a><small>Abre el formulario para registrar una nueva solicitud operativa.</small></div>
          <div class="action-item"><a class="btn" href="/admin/operaciones/asignaciones">Asignación de auxiliares</a><small>Arrastra auxiliares disponibles y guarda asignaciones.</small></div>
          <div class="action-item"><a class="btn" href="/admin/operaciones/personal">Personal operativo</a><small>Consulta, sincroniza o crea auxiliares manualmente.</small></div>
          <div class="action-item attendance"><a class="btn" href="/admin/operaciones/asistencia">Asistencia</a><small>Valida llegadas, revisa geocerca, evidencia y ausencias.</small></div>
          <div class="action-item session-checking"><a class="btn" href="/admin/operaciones/whatsapp">WhatsApp despacho</a><small>Revisando estado de la sesión...</small></div>
        </div>
      </section>
    </main>
  </body></html>`;
  const html = injectAdminModuleNavigation(source, req('/admin/operaciones', { canAccessDispatch: true, canAccessAttendance: true }));

  assert.doesNotMatch(html, /Crea clientes, puntos operativos/);
  assert.doesNotMatch(html, /Revisando estado de la sesión/);
  assert.doesNotMatch(html, /\baction-item\b/);
  assert.doesNotMatch(html, /class="actions"/);
  assert.match(html, /<h1>Operaciones \/ Despacho<\/h1><p>Gestión operativa\.<\/p>/);
  assert.match(moduleMenu(nav(html), 'operations'), /href="\/admin\/operaciones\/clientes">Clientes<\/a>/);
  assert.match(moduleMenu(nav(html), 'operations'), /href="\/admin\/operaciones\/whatsapp">WhatsApp despacho<\/a>/);
});

test('Usuarios se marca activo sin marcar Reclutamiento como modulo activo', () => {
  const navbar = nav(injectAdminModuleNavigation(baseHtml, req('/admin/users', {
    userSource: 'db',
    username: 'reclutador-general',
    userAccessScope: 'ALL'
  })));
  assert.match(standaloneLink(navbar, 'users'), /class="admin-module-standalone-link is-active"/);
  assert.doesNotMatch(moduleMenu(navbar, 'recruitment'), /admin-module-menu is-active/);
});

test('Sucursales recupera pausa/revisión, cuenta vacantes y usa su terminología visible', async () => {
  const [view, fields] = await Promise.all([
    readFile(new URL('../src/views/locations.ejs', import.meta.url), 'utf8'),
    readFile(new URL('../src/views/partials/locationOperationConfigFields.ejs', import.meta.url), 'utf8')
  ]);

  assert.match(view, /action="\/admin\/vacancies\/<%= config\.id %>\/toggle"/);
  assert.match(view, /action="\/admin\/vacancies\/<%= config\.id %>\/toggle-review"/);
  assert.match(view, /data-vacancy-action-form/);
  assert.match(view, /dashboardReviewEnabled/);
  assert.match(view, /Revisión HV en panel/);
  assert.match(view, /syncInterviewFields/);
  assert.match(view, /const vacancyCount = city\.operations\.reduce/);
  assert.match(view, /<%= vacancyCount %> vacante/);
  assert.match(view, /\+ Crear vacante en/);
  assert.match(view, /Nombre de la vacante/);
  assert.match(view, /Crear y activar vacante/);
  assert.doesNotMatch(view, /\+ Crear operación en|Nombre de la operación|Crear operación y activar vacante|Sin operaciones configuradas/);

  assert.doesNotMatch(fields, /Operación activa en Lórren|Recibir postulaciones|Agenda de entrevista habilitada/);
  assert.doesNotMatch(fields, /contexto de la operación|dirección de operación|Requisitos reales de la operación/);
  assert.match(fields, /contexto de la vacante/);
  assert.match(fields, /dirección de la vacante/);
  assert.match(fields, /Requisitos reales de la vacante/);
  assert.match(fields, /type="hidden" name="isActive"/);
  assert.match(fields, /type="hidden" name="acceptingApplications"/);
  assert.match(fields, /data-scheduling-toggle/);
  assert.match(fields, /Habilitar entrevistas/);
  assert.match(fields, /data-interview-field/);
});

test('entorno de pruebas no depende de permiso de Despacho para seguir visible', () => {
  const navbar = nav(injectAdminModuleNavigation(baseHtml, req('/admin/operaciones/pruebas', { canAccessTestWorkspace: true })));
  assert.match(navbar, /data-module-menu="operations"/);
  assert.match(navbar, /href="\/admin\/operaciones\/pruebas">Entorno de pruebas<\/a>/);
  assert.doesNotMatch(navbar, /href="\/admin\/operaciones">Panel operativo<\/a>/);
});

test('un menu abierto crea una capa de clic externo sin tapar panel ni controles del header', async () => {
  const css = await readFile(new URL('../src/public/admin-module-navigation.css', import.meta.url), 'utf8');

  assert.match(css, /\.admin-module-menu\[open\] > \.admin-module-menu-trigger::before[\s\S]*position:\s*fixed[\s\S]*inset:\s*0[\s\S]*z-index:\s*0/);
  assert.match(css, /\.admin-module-menu \{[\s\S]*z-index:\s*1300/);
  assert.match(css, /\.admin-module-menu\[open\] \{[\s\S]*z-index:\s*1200/);
  assert.match(css, /\.admin-module-menu-panel \{[\s\S]*z-index:\s*1200/);
  assert.match(css, /admin-module-standalone-link[\s\S]*z-index:\s*1300/);
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
  assert.match(css, /@media \(max-width:\s*900px\)[\s\S]*\.admin-module-menu-panel[\s\S]*position:\s*relative/);
  assert.match(desktop, /position:\s*sticky/);
  assert.match(desktop, /top:\s*0/);
});

test('inyeccion sigue siendo idempotente y evita APIs de Gestión de Tiempo', () => {
  const request = req('/admin', { canAccessDispatch: true, canAccessPayroll: true });
  const once = injectAdminModuleNavigation(baseHtml, request);
  assert.equal(injectAdminModuleNavigation(once, request), once);
  assert.equal(injectAdminModuleNavigation(baseHtml, req('/admin/operaciones/asistencia/gestion-tiempo/api/users/sample', { canAccessPayroll: true })), baseHtml);
  assert.equal(injectAdminModuleNavigation(baseHtml, req('/admin/operaciones/asistencia/gestion-tiempo/api/users/sample', { canAccessPayroll: true })), baseHtml);
});