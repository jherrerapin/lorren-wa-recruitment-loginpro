import { canCreateRecruiterUsers } from './appUsers.js';

const RECRUITMENT_PATH = '/admin';
const PROFILE_PATH = '/account/profile';
const BRANCHES_PATH = '/admin/locations';
const USERS_PATH = '/admin/users';
const OPERATIONS_PATH = '/admin/operaciones';
const ATTENDANCE_PATH = '/admin/operaciones/asistencia';
const PAYROLL_PATH = '/admin/operaciones/asistencia/gestion-tiempo';
const LEGACY_PAYROLL_PATH = '/admin/operaciones/asistencia/nomina';
const WORKER_PORTAL_ACTIVATION_PATH = '/admin/operaciones/portal-activaciones';
const TEST_WORKSPACE_PATH = '/admin/operaciones/pruebas';
const NAVIGATION_STYLESHEET = '/public/admin-module-navigation.css';
const SHELL_STYLESHEET = '/public/admin-module-shell.css';
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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function activeModule(path) {
  if (path.startsWith(USERS_PATH) || path.startsWith(BRANCHES_PATH)) return null;
  if (path.startsWith(PAYROLL_PATH) || path.startsWith(LEGACY_PAYROLL_PATH)) return 'payroll';
  if (path.startsWith(OPERATIONS_PATH)) return 'operations';
  return 'recruitment';
}

function moduleAccess(req = {}) {
  const role = requestRole(req);
  const isDev = role === 'dev';
  return {
    isDev,
    dispatch: isDev || requestCapability(req, 'canAccessDispatch'),
    attendance: isDev || requestCapability(req, 'canAccessAttendance'),
    payroll: isDev || requestCapability(req, 'canAccessPayroll'),
    testWorkspace: isDev || requestCapability(req, 'canAccessTestWorkspace'),
    statistics: isDev || requestCapability(req, 'canAccessStatistics'),
    users: canCreateRecruiterUsers(req)
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
  return [menuLink(PAYROLL_PATH, 'Gestión de Tiempo')];
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

function sessionIdentity(req = {}) {
  const session = req.session || {};
  const isImpersonating = Boolean(session.devImpersonation);
  const name = String(session.displayName || (session.userRole === 'dev' ? 'DEV' : '')).trim();
  if (!name && !isImpersonating) return '';
  const safeName = escapeHtml(name || 'Usuario');

  if (isImpersonating) {
    return `<div class="admin-session-identity is-impersonating" data-session-identity="true"><span class="admin-session-mode">Vista como</span><strong class="admin-session-user-name">${safeName}</strong><form method="post" action="/admin/users/impersonation/stop"><button type="submit" class="admin-session-return">Volver a DEV</button></form></div>`;
  }

  if (session.userRole === 'dev' && session.userSource === 'env') {
    return `<div class="admin-session-identity" data-session-identity="true"><span class="admin-session-user-name">${safeName}</span></div>`;
  }

  return `<a class="admin-session-identity" data-session-identity="true" href="${PROFILE_PATH}" title="Editar mi perfil" aria-label="Editar mi perfil" style="text-decoration:none;"><span class="admin-session-mode">Mi perfil</span><span class="admin-session-user-name">${safeName}</span></a>`;
}

export function buildAdminModuleNavbar(req = {}, originalNav = '') {
  const path = requestPath(req);
  const active = activeModule(path);
  const access = moduleAccess(req);
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
    moduleMenu({ key: 'payroll', label: 'Gestión de Tiempo', icon: PAYROLL_ICON, active, items: payrollMenuItems(access), allowed: access.payroll })
  ].filter(Boolean).join('\n    ');
  const branchesLink = standaloneBranchesLink(path);
  const usersLink = standaloneUsersLink(access, path);
  const identity = sessionIdentity(req);

  return `<nav class="navbar admin-module-navbar" data-module-navigation="true" aria-label="Módulos principales">
    <a class="brand admin-module-brand" href="${RECRUITMENT_PATH}" aria-label="LoginPro"><img src="/public/logo-loginpro.svg" alt="LoginPro" /></a>
    <div class="admin-module-nav-links" data-primary-nav-group="true">${modules}
      ${branchesLink}
      ${usersLink}
    </div>
    <span class="spacer"></span>
    ${identity}
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

function ensureViewportMeta(html) {
  if (!/<\/head>/i.test(html)) return html;
  if (/<meta\b[^>]*\bname\s*=\s*["']viewport["'][^>]*>/i.test(html)) return html;
  return html.replace(/<\/head>/i, '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n</head>');
}

function ensureNavigationStylesheet(html) {
  if (!/<\/head>/i.test(html)) return html;
  const stylesheets = [];
  if (!html.includes(NAVIGATION_STYLESHEET)) {
    stylesheets.push(`<link rel="stylesheet" href="${NAVIGATION_STYLESHEET}" />`);
  }
  if (!html.includes(SHELL_STYLESHEET)) {
    stylesheets.push(`<link rel="stylesheet" href="${SHELL_STYLESHEET}" />`);
  }
  if (!html.includes(DESKTOP_NAVIGATION_STYLESHEET)) {
    stylesheets.push(`<link rel="stylesheet" href="${DESKTOP_NAVIGATION_STYLESHEET}" media="(min-width: 901px)" />`);
  }
  if (!stylesheets.length) return html;
  return html.replace(/<\/head>/i, `  ${stylesheets.join('\n  ')}\n</head>`);
}

function ensureAdminPageShell(html) {
  return html.replace(/<main\b([^>]*)>/i, (tag, attributes) => {
    const classMatch = attributes.match(/\bclass\s*=\s*(["'])([^"']*)\1/i);
    if (classMatch) {
      const classes = classMatch[2].split(/\s+/).filter(Boolean);
      if (classes.includes('admin-module-page-shell')) return tag;
      const nextClass = `class=${classMatch[1]}${[...classes, 'admin-module-page-shell'].join(' ')}${classMatch[1]}`;
      return tag.replace(classMatch[0], nextClass);
    }
    return `<main class="admin-module-page-shell"${attributes}>`;
  });
}

function ensureUsersProgrammingAccessScript(html, path) {
  if (!path.startsWith(USERS_PATH) || html.includes(USERS_PROGRAMMING_ACCESS_SCRIPT) || !/<\/body>/i.test(html)) return html;
  return html.replace(/<\/body>/i, `  <script src="${USERS_PROGRAMMING_ACCESS_SCRIPT}" defer></script>\n</body>`);
}

function normalizePayrollPresentation(html) {
  return html
    .replace(/<title>\s*Nómina y tiempo trabajado\s*—\s*LoginPro<\/title>/gi, '<title>Gestión de Tiempo — LoginPro</title>')
    .replace(/<title>\s*Personalizar Excel de nómina\s*—\s*LoginPro<\/title>/gi, '<title>Personalizar Excel · Gestión de Tiempo — LoginPro</title>')
    .replace(/<h1>\s*Nómina y tiempo trabajado\s*<\/h1>/gi, '<h1>Gestión de Tiempo</h1>');
}

function normalizePayrollPaths(html) {
  return normalizePayrollPresentation(html.split(LEGACY_PAYROLL_PATH).join(PAYROLL_PATH));
}

function isPayrollApiPath(path) {
  return path.startsWith(`${PAYROLL_PATH}/api/`) || path.startsWith(`${LEGACY_PAYROLL_PATH}/api/`);
}

export function injectAdminModuleNavigation(html, req = {}) {
  if (typeof html !== 'string') return html;
  const path = requestPath(req);
  if (!path.startsWith('/admin') || isPayrollApiPath(path) || path.startsWith('/admin/operaciones/pruebas/api/')) return html;

  const normalizedHtml = normalizePayrollPaths(html);
  if (normalizedHtml.includes('data-module-navigation="true"')) return normalizedHtml;

  const navPattern = /<nav\b[^>]*class=["'][^"']*\bnavbar\b[^"']*["'][^>]*>[\s\S]*?<\/nav>/i;
  const originalNav = normalizedHtml.match(navPattern)?.[0] || '';
  if (!originalNav) return normalizedHtml;

  const moduleNavbar = buildAdminModuleNavbar(req, originalNav);
  let output = ensureViewportMeta(normalizedHtml);
  output = ensureNavigationStylesheet(output);
  output = output.replace(navPattern, moduleNavbar);
  output = ensureAdminPageShell(output);
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
