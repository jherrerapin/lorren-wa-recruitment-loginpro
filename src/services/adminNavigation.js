const RECRUITMENT_PATH = '/admin';
const BRANCHES_PATH = '/admin/locations';
const USERS_PATH = '/admin/users';
const OPERATIONS_PATH = '/admin/operaciones';
const ATTENDANCE_PATH = '/admin/operaciones/asistencia';
const PAYROLL_PATH = '/admin/operaciones/asistencia/nomina';
const WORKER_PORTAL_ACTIVATION_PATH = '/admin/operaciones/portal-activaciones';
const TEST_WORKSPACE_PATH = '/admin/operaciones/pruebas';
const NAVIGATION_STYLESHEET = '/public/admin-module-navigation.css';
const DESKTOP_NAVIGATION_STYLESHEET = '/public/admin-module-navigation-desktop.css';
const USERS_PROGRAMMING_ACCESS_SCRIPT = '/public/users-programming-access.js';
const MODULE_MENU_GROUP = 'admin-primary-navigation';
const RECRUITMENT_ICON = '';
const OPERATIONS_ICON = '';
const PAYROLL_ICON = '';
const BRANCHES_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAX0lEQVR42u2WWwoAIAgEU7r/le0CJSSWBbO/gov7iFoDABRDvKGZWRqRyJRLb5B7+7Tagp4lZVS9cgX+syA7nFhAC2gBFmikBasmeDMs2P4RZad99Yi9p8CJyz0lCCEYKGkkNOBBvQ4AAAAASUVORK5CYII=';
const USERS_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAlklEQVR42u1VwRaAIAhzPv//l+mSvZ5pgKB1YMfUsU2wlAKBjwHNZiKi6yCAbQLuhR8ERiHFO9JWLCcQs7H3vo+SehORVzmXruUlnX3CpQcAoDroOfldE3KRq6+AI6vrb0lMN6HUicaxeAwl86wpPEoB1sdE677lKrPKpfs5gbD8cDQv34g37xg1z7MmMtfCgUAgEPDCAQi2bAnBhNiuAAAAAElFTkSuQmCC';

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
  if (path.startsWith(USERS_PATH) || path.startsWith(BRANCHES_PATH)) return null;
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
  const items = [menuLink(RECRUITMENT_PATH, 'Panel de candidatos')];
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
    if (access.attendance) {
      items.push(menuLink(WORKER_PORTAL_ACTIVATION_PATH, 'Activar portal del auxiliar'));
      items.push(menuLink(ATTENDANCE_PATH, 'Asistencia'));
    }
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

function standaloneIcon(icon) {
  return `<span class="admin-module-nav-icon" aria-hidden="true" style="background-image:url(${icon});background-repeat:no-repeat;background-position:center;background-size:16px 16px;"></span>`;
}

function standaloneBranchesLink(path) {
  const classes = ['admin-module-standalone-link'];
  if (path.startsWith(BRANCHES_PATH)) classes.push('is-active');
  return `<a class="${classes.join(' ')}" href="${BRANCHES_PATH}" data-standalone-link="branches" style="gap:7px;">${standaloneIcon(BRANCHES_ICON)}<span>Sucursales</span></a>`;
}

function standaloneUsersLink(access, path) {
  if (!access.users) return '';
  const classes = ['admin-module-standalone-link'];
  if (path.startsWith(USERS_PATH)) classes.push('is-active');
  return `<a class="${classes.join(' ')}" href="${USERS_PATH}" data-standalone-link="users" style="gap:7px;">${standaloneIcon(USERS_ICON)}<span>Usuarios</span></a>`;
}

export function buildAdminModuleNavbar(req = {}, originalNav = '') {
  const path = requestPath(req);
  const active = activeModule(path);
  const access = moduleAccess(req, originalNav);
  const modules = [
    moduleMenu({ key: 'recruitment', label: 'Reclutamiento', icon: RECRUITMENT_ICON, active, items: recruitmentMenuItems(access) }),
    moduleMenu({
      key: 'operations',
      label: 'Operaciones / Despacho',
      icon: OPERATIONS_ICON,
      active,
      items: operationsMenuItems(access),
      allowed: access.dispatch || access.testWorkspace
    }),
    moduleMenu({ key: 'payroll', label: 'Nómina', icon: PAYROLL_ICON, active, items: payrollMenuItems(access), allowed: access.payroll })
  ].filter(Boolean).join('\n    ');
  const branchesLink = standaloneBranchesLink(path);
  const usersLink = standaloneUsersLink(access, path);

  return `<nav class="navbar admin-module-navbar" data-module-navigation="true" aria-label="Módulos principales">
    <a class="brand admin-module-brand" href="${RECRUITMENT_PATH}" aria-label="LoginPro"><img src="/public/logo-loginpro.svg" alt="LoginPro" /></a>
    <div class="admin-module-nav-links">${modules}</div>
    ${branchesLink}
    ${usersLink}
    <span class="spacer"></span>
    <form method="post" action="/logout"><button type="submit" class="btn-logout">Cerrar sesión</button></form>
  </nav>`;
}

function dropdownMenuHrefs(navHtml) {
  const hrefs = new Set();
  const panels = navHtml.matchAll(/<div\s+class=["']admin-module-menu-panel["'][^>]*>([\s\S]*?)<\/div>/gi);
  for (const panel of panels) {
    for (const match of panel[1].matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)) {
      hrefs.add(match[1]);
    }
  }
  return hrefs;
}

function attributeValue(attributes, name) {
  return attributes.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1] || null;
}

function hasClassToken(attributes, token) {
  return (attributeValue(attributes, 'class') || '').split(/\s+/).filter(Boolean).includes(token);
}

function stripDuplicateActionItems(fragment, menuHrefs) {
  return fragment.replace(
    /<div\b([^>]*\bclass\s*=\s*["'][^"']*\baction-item\b[^"']*["'][^>]*)>([\s\S]*?)<\/div>/gi,
    (block, _attributes, content) => {
      const anchors = [...content.matchAll(/<a\b([^>]*)>[\s\S]*?<\/a>/gi)];
      if (anchors.length !== 1) return block;
      const anchorAttributes = anchors[0][1];
      if (!hasClassToken(anchorAttributes, 'btn')) return block;
      const href = attributeValue(anchorAttributes, 'href');
      if (!href || !menuHrefs.has(href)) return block;

      const anchorStart = anchors[0].index || 0;
      const remainder = `${content.slice(0, anchorStart)}${content.slice(anchorStart + anchors[0][0].length)}`.trim();
      if (remainder && !/^(?:<small\b[^>]*>[\s\S]*?<\/small>\s*)+$/i.test(remainder)) return block;
      return '';
    }
  );
}

function stripDuplicateButtons(fragment, menuHrefs) {
  return fragment.replace(
    /<a\b([^>]*)>([\s\S]*?)<\/a>/gi,
    (anchor, attributes) => {
      if (!hasClassToken(attributes, 'btn')) return anchor;
      const href = attributeValue(attributes, 'href');
      return href && menuHrefs.has(href) ? '' : anchor;
    }
  );
}

function stripEmptyActionContainers(fragment) {
  return fragment.replace(
    /<div\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bactions\b[^"']*["'])[^>]*>\s*<\/div>/gi,
    ''
  );
}

function stripDuplicateModuleButtons(html, navHtml) {
  const menuHrefs = dropdownMenuHrefs(navHtml);
  if (!menuHrefs.size) return html;
  const navIndex = html.indexOf(navHtml);
  if (navIndex < 0) return html;

  const stripNavigationDuplicates = (fragment) => {
    let output = stripDuplicateActionItems(fragment, menuHrefs);
    output = stripDuplicateButtons(output, menuHrefs);
    return stripEmptyActionContainers(output);
  };

  const before = html.slice(0, navIndex);
  const afterStart = navIndex + navHtml.length;
  const after = html.slice(afterStart);
  return `${stripNavigationDuplicates(before)}${navHtml}${stripNavigationDuplicates(after)}`;
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

function ensureUsersProgrammingAccessScript(html, path) {
  if (!path.startsWith(USERS_PATH) || html.includes(USERS_PROGRAMMING_ACCESS_SCRIPT) || !/<\/body>/i.test(html)) return html;
  return html.replace(/<\/body>/i, `  <script src="${USERS_PROGRAMMING_ACCESS_SCRIPT}" defer></script>\n</body>`);
}

export function injectAdminModuleNavigation(html, req = {}) {
  if (typeof html !== 'string') return html;
  const path = requestPath(req);
  if (!path.startsWith('/admin') || path.startsWith('/admin/operaciones/asistencia/nomina/api/') || path.startsWith('/admin/operaciones/pruebas/api/')) return html;
  if (html.includes('data-module-navigation="true"')) return html;

  const navPattern = /<nav\b[^>]*class=["'][^"']*\bnavbar\b[^"']*["'][^>]*>[\s\S]*?<\/nav>/i;
  const originalNav = html.match(navPattern)?.[0] || '';
  if (!originalNav) return html;

  const moduleNavbar = buildAdminModuleNavbar(req, originalNav);
  let output = ensureNavigationStylesheet(html);
  output = output.replace(navPattern, moduleNavbar);
  output = stripDuplicateModuleButtons(output, moduleNavbar);
  return ensureUsersProgrammingAccessScript(output, path);
}

export const ADMIN_MODULE_PATHS = Object.freeze({
  recruitment: RECRUITMENT_PATH,
  branches: BRANCHES_PATH,
  operations: OPERATIONS_PATH,
  attendance: ATTENDANCE_PATH,
  payroll: PAYROLL_PATH,
  workerPortalActivation: WORKER_PORTAL_ACTIVATION_PATH,
  testWorkspace: TEST_WORKSPACE_PATH
});