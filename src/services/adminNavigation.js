const RECRUITMENT_PATH = '/admin';
const OPERATIONS_PATH = '/admin/operaciones';
const ATTENDANCE_PATH = '/admin/operaciones/asistencia';
const PAYROLL_PATH = '/admin/operaciones/asistencia/nomina';
const TEST_WORKSPACE_PATH = '/admin/operaciones/pruebas';
const NAVIGATION_STYLESHEET = '/public/admin-module-navigation.css';

function requestPath(req = {}) {
  return String(req.originalUrl || req.url || '').split('?')[0] || '/';
}

function requestRole(req = {}) {
  return req.session?.userRole || req.userRole || null;
}

function requestCapability(req = {}, key) {
  return req[key] === true || req.session?.[key] === true;
}

function activeModule(path) {
  if (path.startsWith(PAYROLL_PATH)) return 'payroll';
  if (path.startsWith(OPERATIONS_PATH)) return 'operations';
  return 'recruitment';
}

function isModuleLanding(path) {
  const normalized = path.length > 1 ? path.replace(/\/$/, '') : path;
  return [RECRUITMENT_PATH, OPERATIONS_PATH, PAYROLL_PATH].includes(normalized);
}

function originalNavHasLink(navHtml, href) {
  return navHtml.includes(`href="${href}"`) || navHtml.includes(`href='${href}'`);
}

function moduleAccess(req = {}, originalNav = '') {
  const role = requestRole(req);
  const isDev = role === 'dev';
  return {
    isDev,
    dispatch: isDev || requestCapability(req, 'canAccessDispatch'),
    attendance: isDev || requestCapability(req, 'canAccessAttendance'),
    payroll: isDev || requestCapability(req, 'canAccessPayroll'),
    testWorkspace: isDev || requestCapability(req, 'canAccessTestWorkspace'),
    statistics: isDev || requestCapability(req, 'canAccessStatistics'),
    users: isDev || originalNavHasLink(originalNav, '/admin/users')
  };
}

function link(href, label) {
  return `<a href="${href}">${label}</a>`;
}

function moduleLink({ key, href, label, icon, active, allowed = true }) {
  if (!allowed) return '';
  const classes = ['admin-module-nav-link'];
  if (active === key) classes.push('is-active');
  return `<a class="${classes.join(' ')}" href="${href}" data-module="${key}"><span class="admin-module-nav-icon" aria-hidden="true">${icon}</span><span>${label}</span></a>`;
}

function utilityLinks(access) {
  const links = [];
  if (access.users) links.push(link('/admin/users', 'Usuarios'));
  if (access.statistics) links.push(link('/admin/estadisticas', 'Estadísticas'));
  if (access.isDev) {
    links.push(link('/admin/monitor', 'Monitor'));
    links.push(link('/admin/bot-knowledge', 'Aprendizajes Lórren'));
  }
  if (access.testWorkspace) links.push(link(TEST_WORKSPACE_PATH, 'Entorno de pruebas'));
  return links;
}

export function buildAdminModuleNavbar(req = {}, originalNav = '') {
  const path = requestPath(req);
  const active = activeModule(path);
  const access = moduleAccess(req, originalNav);
  const modules = [
    moduleLink({ key: 'recruitment', href: RECRUITMENT_PATH, label: 'Reclutamiento', icon: 'R', active }),
    moduleLink({ key: 'operations', href: OPERATIONS_PATH, label: 'Operaciones / Despacho', icon: 'O', active, allowed: access.dispatch }),
    moduleLink({ key: 'payroll', href: PAYROLL_PATH, label: 'Nómina', icon: 'N', active, allowed: access.payroll })
  ].filter(Boolean).join('\n    ');
  const utilities = utilityLinks(access);
  const tools = utilities.length
    ? `<details class="admin-module-tools"><summary>Herramientas</summary><div class="admin-module-tools-menu">${utilities.join('')}</div></details>`
    : '';

  return `<nav class="navbar admin-module-navbar" data-module-navigation="true" aria-label="Módulos principales">
    <a class="brand admin-module-brand" href="${RECRUITMENT_PATH}" aria-label="LoginPro"><img src="/public/logo-loginpro.svg" alt="LoginPro" /></a>
    <div class="admin-module-nav-links">${modules}</div>
    <span class="spacer"></span>
    ${tools}
    <form method="post" action="/logout"><button type="submit" class="btn-logout">Cerrar sesión</button></form>
  </nav>`;
}

function quickLinksForModule(key, access) {
  if (key === 'recruitment') {
    const links = [link(RECRUITMENT_PATH, 'Panel de candidatos'), link('/admin/vacancies', 'Vacantes')];
    if (access.users) links.push(link('/admin/users', 'Usuarios'));
    return links;
  }
  if (key === 'operations') {
    const links = [
      link(OPERATIONS_PATH, 'Panel operativo'),
      link('/admin/operaciones/clientes', 'Clientes'),
      link('/admin/operaciones/asignaciones', 'Asignaciones'),
      link('/admin/operaciones/personal', 'Personal'),
      link('/admin/operaciones/whatsapp', 'WhatsApp despacho')
    ];
    if (access.attendance) links.push(link(ATTENDANCE_PATH, 'Asistencia'));
    return links;
  }
  const links = [link(PAYROLL_PATH, 'Nómina y tiempo trabajado')];
  if (access.testWorkspace) links.push(link(TEST_WORKSPACE_PATH, 'Entorno de pruebas'));
  return links;
}

function moduleCard({ key, href, label, icon, description, active, access, allowed = true }) {
  if (!allowed) return '';
  const classes = ['admin-module-card'];
  if (active === key) classes.push('is-active');
  const quickLinks = quickLinksForModule(key, access)
    .map((item) => item.replace('<a', '<a class="admin-module-card-shortcut"'))
    .join('');
  return `<article class="${classes.join(' ')}" data-module-card="${key}">
      <a class="admin-module-card-primary" href="${href}"><span class="admin-module-card-icon" aria-hidden="true">${icon}</span><span><strong>${label}</strong><small>${description}</small></span></a>
      <div class="admin-module-card-shortcuts">${quickLinks}</div>
    </article>`;
}

export function buildAdminModuleCards(req = {}, originalNav = '') {
  const path = requestPath(req);
  if (!isModuleLanding(path)) return '';
  const active = activeModule(path);
  const access = moduleAccess(req, originalNav);
  const cards = [
    moduleCard({ key: 'recruitment', href: RECRUITMENT_PATH, label: 'Reclutamiento', icon: 'R', description: 'Lórren, candidatos, vacantes y seguimiento de selección.', active, access }),
    moduleCard({ key: 'operations', href: OPERATIONS_PATH, label: 'Operaciones / Despacho', icon: 'O', description: 'Despacho, personal operativo, WhatsApp y asistencia.', active, access, allowed: access.dispatch }),
    moduleCard({ key: 'payroll', href: PAYROLL_PATH, label: 'Nómina', icon: 'N', description: 'Tiempo trabajado, novedades, conceptos y exportaciones.', active, access, allowed: access.payroll })
  ].filter(Boolean).join('\n    ');

  return `<section class="admin-module-switcher" data-module-cards="true" aria-label="Acceso a módulos">
    <div class="admin-module-switcher-heading"><span>Módulos</span><small>Selecciona un módulo o entra directamente a una de sus funciones.</small></div>
    <div class="admin-module-card-grid">${cards}</div>
  </section>`;
}

function ensureNavigationStylesheet(html) {
  if (html.includes(NAVIGATION_STYLESHEET)) return html;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `  <link rel="stylesheet" href="${NAVIGATION_STYLESHEET}" />\n</head>`);
  return html;
}

export function injectAdminModuleNavigation(html, req = {}) {
  if (typeof html !== 'string') return html;
  const path = requestPath(req);
  if (!path.startsWith('/admin') || path.startsWith('/admin/operaciones/asistencia/nomina/api/') || path.startsWith('/admin/operaciones/pruebas/api/')) return html;
  if (html.includes('data-module-navigation="true"')) return html;

  const navPattern = /<nav\b[^>]*class=["'][^"']*\bnavbar\b[^"']*["'][^>]*>[\s\S]*?<\/nav>/i;
  const originalNav = html.match(navPattern)?.[0] || '';
  if (!originalNav) return html;

  let output = ensureNavigationStylesheet(html);
  output = output.replace(navPattern, buildAdminModuleNavbar(req, originalNav));
  const cards = buildAdminModuleCards(req, originalNav);
  if (cards) output = output.replace(/(<\/nav>)/i, `$1\n${cards}`);
  return output;
}

export const ADMIN_MODULE_PATHS = Object.freeze({
  recruitment: RECRUITMENT_PATH,
  operations: OPERATIONS_PATH,
  attendance: ATTENDANCE_PATH,
  payroll: PAYROLL_PATH,
  testWorkspace: TEST_WORKSPACE_PATH
});
