const RECRUITMENT_PATH = '/admin';
const USERS_PATH = '/admin/users';
const OPERATIONS_PATH = '/admin/operaciones';
const ATTENDANCE_PATH = '/admin/operaciones/asistencia';
const PAYROLL_PATH = '/admin/operaciones/asistencia/nomina';
const TEST_WORKSPACE_PATH = '/admin/operaciones/pruebas';
const NAVIGATION_STYLESHEET = '/public/admin-module-navigation.css';
const DESKTOP_NAVIGATION_STYLESHEET = '/public/admin-module-navigation-desktop.css';
const MODULE_MENU_GROUP = 'admin-primary-navigation';

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
  if (path.startsWith(USERS_PATH)) return null;
  if (path.startsWith(PAYROLL_PATH)) return 'payroll';
  if (path.startsWith(OPERATIONS_PATH)) return 'operations';
  return 'recruitment';
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
    users: isDev || originalNavHasLink(originalNav, USERS_PATH)
  };
}

function menuLink(href, label) {
  return `<a class="admin-module-menu-link" href="${href}">${label}</a>`;
}

function recruitmentMenuItems(access) {
  const items = [
    menuLink(RECRUITMENT_PATH, 'Panel de candidatos'),
    menuLink('/admin/vacancies', 'Vacantes')
  ];
  if (access.statistics) items.push(menuLink('/admin/estadisticas', 'Estadísticas'));
  if (access.isDev) {
    items.push(menuLink('/admin/monitor', 'Monitor bot'));
    items.push(menuLink('/admin/bot-knowledge', 'Aprendizajes Lórren'));
  }
  return items;
}

function operationsMenuItems(access) {
  const items = [];
  if (access.dispatch) {
    items.push(
      menuLink(OPERATIONS_PATH, 'Panel operativo'),
      menuLink('/admin/operaciones/clientes', 'Clientes'),
      menuLink('/admin/operaciones/solicitudes', 'Crear solicitud'),
      menuLink('/admin/operaciones/asignaciones', 'Asignación de auxiliares'),
      menuLink('/admin/operaciones/personal', 'Personal operativo')
    );
    if (access.attendance) items.push(menuLink(ATTENDANCE_PATH, 'Asistencia'));
    items.push(menuLink('/admin/operaciones/whatsapp', 'WhatsApp despacho'));
  }
  if (access.testWorkspace) items.push(menuLink(TEST_WORKSPACE_PATH, 'Entorno de pruebas'));
  return items;
}

function payrollMenuItems(access) {
  if (!access.payroll) return [];
  return [menuLink(PAYROLL_PATH, 'Nómina y tiempo trabajado')];
}

function moduleMenu({ key, label, icon, active, items = [], allowed = true }) {
  if (!allowed || !items.length) return '';
  const classes = ['admin-module-menu'];
  if (active === key) classes.push('is-active');
  return `<details class="${classes.join(' ')}" name="${MODULE_MENU_GROUP}" data-module-menu="${key}">
      <summary class="admin-module-menu-trigger"><span class="admin-module-nav-icon" aria-hidden="true">${icon}</span><span>${label}</span><span class="admin-module-menu-chevron" aria-hidden="true">▾</span></summary>
      <div class="admin-module-menu-panel" aria-label="Opciones de ${label}">${items.join('')}</div>
    </details>`;
}

function standaloneUsersLink(access, path) {
  if (!access.users) return '';
  const classes = ['admin-module-standalone-link'];
  if (path.startsWith(USERS_PATH)) classes.push('is-active');
  return `<a class="${classes.join(' ')}" href="${USERS_PATH}">Usuarios</a>`;
}

export function buildAdminModuleNavbar(req = {}, originalNav = '') {
  const path = requestPath(req);
  const active = activeModule(path);
  const access = moduleAccess(req, originalNav);
  const modules = [
    moduleMenu({ key: 'recruitment', label: 'Reclutamiento', icon: '👥', active, items: recruitmentMenuItems(access) }),
    moduleMenu({
      key: 'operations',
      label: 'Operaciones / Despacho',
      icon: '🚚',
      active,
      items: operationsMenuItems(access),
      allowed: access.dispatch || access.testWorkspace
    }),
    moduleMenu({ key: 'payroll', label: 'Nómina', icon: '🧾', active, items: payrollMenuItems(access), allowed: access.payroll })
  ].filter(Boolean).join('\n    ');
  const usersLink = standaloneUsersLink(access, path);

  return `<nav class="navbar admin-module-navbar" data-module-navigation="true" aria-label="Módulos principales">
    <a class="brand admin-module-brand" href="${RECRUITMENT_PATH}" aria-label="LoginPro"><img src="/public/logo-loginpro.svg" alt="LoginPro" /></a>
    <div class="admin-module-nav-links">${modules}</div>
    ${usersLink}
    <span class="spacer"></span>
    <form method="post" action="/logout"><button type="submit" class="btn-logout">Cerrar sesión</button></form>
  </nav>`;
}

function ensureNavigationStylesheet(html) {
  if (!/<\/head>/i.test(html)) return html;
  const stylesheets = [];
  if (!html.includes(NAVIGATION_STYLESHEET)) {
    stylesheets.push(`<link rel="stylesheet" href="${NAVIGATION_STYLESHEET}" />`);
  }
  if (!html.includes(DESKTOP_NAVIGATION_STYLESHEET)) {
    stylesheets.push(`<link rel="stylesheet" href="${DESKTOP_NAVIGATION_STYLESHEET}" media="(min-width: 901px)" />`);
  }
  if (!stylesheets.length) return html;
  return html.replace(/<\/head>/i, `  ${stylesheets.join('\n  ')}\n</head>`);
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
  return output;
}

export const ADMIN_MODULE_PATHS = Object.freeze({
  recruitment: RECRUITMENT_PATH,
  operations: OPERATIONS_PATH,
  attendance: ATTENDANCE_PATH,
  payroll: PAYROLL_PATH,
  testWorkspace: TEST_WORKSPACE_PATH
});