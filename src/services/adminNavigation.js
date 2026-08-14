const RECRUITMENT_PATH = '/admin';
const USERS_PATH = '/admin/users';
const OPERATIONS_PATH = '/admin/operaciones';
const ATTENDANCE_PATH = '/admin/operaciones/asistencia';
const PAYROLL_PATH = '/admin/operaciones/asistencia/nomina';
const WORKER_PORTAL_ACTIVATION_PATH = '/admin/operaciones/portal-activaciones';
const TEST_WORKSPACE_PATH = '/admin/operaciones/pruebas';
const NAVIGATION_STYLESHEET = '/public/admin-module-navigation.css';
const DESKTOP_NAVIGATION_STYLESHEET = '/public/admin-module-navigation-desktop.css';
const MODULE_MENU_GROUP = 'admin-primary-navigation';
const RECRUITMENT_ICON = '<svg class="admin-module-nav-icon-svg" viewBox="0 0 32 32" width="16" height="16" fill="none" focusable="false" aria-hidden="true"><path d="M15.8402 23.93C15.8999 23.9749 15.9577 24.022 16.0135 24.0712C16.0705 24.022 16.1294 23.9749 16.1902 23.93C18.0463 22.6378 20.2536 21.9451 22.5152 21.9451C24.7768 21.9451 26.9841 22.6378 28.8402 23.93C29.2052 24.2047 29.5004 24.5615 29.702 24.9715C29.9035 25.3815 30.0057 25.8332 30.0002 26.29V30H2.00018V26.32C1.99504 25.8558 2.10024 25.3971 2.30714 24.9816C2.51403 24.5661 2.81669 24.2056 3.19018 23.93C5.04626 22.6378 7.25359 21.9451 9.51518 21.9451C11.7768 21.9451 13.9841 22.6378 15.8402 23.93Z" fill="#2563EB"/><path d="M10.6699 7.93003H8.3699C7.76062 7.92554 7.15752 8.05241 6.60169 8.30202C6.04587 8.55162 5.55036 8.91809 5.14894 9.37645C4.74751 9.83482 4.44958 10.3743 4.27546 10.9582C4.10133 11.5421 4.0551 12.1567 4.1399 12.76L4.2072 13.7816C3.39247 13.9123 2.77002 14.6184 2.77002 15.47C2.77002 16.398 3.50928 17.1534 4.43103 17.1793L4.5299 18.68C4.6581 19.6513 5.13404 20.5432 5.86953 21.1904C6.38904 21.6476 7.01316 21.9608 7.68018 22.1066V23.04C7.68018 23.5201 7.87087 23.9805 8.21031 24.3199C8.54975 24.6593 9.01013 24.85 9.49018 24.85C9.97022 24.85 10.4306 24.6593 10.77 24.3199C11.1095 23.9805 11.3002 23.5201 11.3002 23.04V22.1171C11.9858 21.9762 12.6279 21.6589 13.1603 21.1904C13.8958 20.5432 14.3717 19.6513 14.4999 18.68L14.5938 17.1775C15.1935 17.1451 15.711 16.8037 15.99 16.3097C16.2759 16.8159 16.8124 17.1619 17.431 17.1793L17.5299 18.68C17.6581 19.6513 18.134 20.5432 18.8695 21.1904C19.389 21.6476 20.0132 21.9608 20.6802 22.1066V23.04C20.6802 23.5201 20.8709 23.9805 21.2103 24.3199C21.5498 24.6593 22.0101 24.85 22.4902 24.85C22.9702 24.85 23.4306 24.6593 23.77 24.3199C24.1095 23.9805 24.3002 23.5201 24.3002 23.04V22.1171C24.9858 21.9762 25.6279 21.6589 26.1603 21.1904C26.8958 20.5432 27.3717 19.6513 27.4999 18.68L27.5938 17.1775C28.4946 17.1288 29.21 16.3829 29.21 15.47C29.21 14.6299 28.6043 13.9313 27.8057 13.7872L27.8699 12.76C27.951 12.1597 27.9031 11.549 27.7294 10.9687C27.5557 10.3884 27.2603 9.85176 26.8628 9.39466C26.4653 8.93755 25.975 8.57047 25.4244 8.31791C24.8738 8.06535 24.2756 7.93312 23.6699 7.93003H21.3699C20.7606 7.92554 20.1575 8.05241 19.6017 8.30202C19.0459 8.55162 18.5504 8.91809 18.1489 9.37645C17.7475 9.83482 17.4496 10.3743 17.2755 10.9582C17.1013 11.5421 17.0551 12.1567 17.1399 12.76L17.2072 13.7816C16.6844 13.8655 16.2408 14.1862 15.99 14.6303C15.7445 14.1956 15.3142 13.879 14.8057 13.7872L14.8699 12.76C14.951 12.1597 14.9031 11.549 14.7294 10.9687C14.5557 10.3884 14.2603 9.85176 13.8628 9.39466C13.4653 8.93755 12.975 8.57047 12.4244 8.31791C11.8738 8.06535 11.2756 7.93312 10.6699 7.93003Z" fill="#60A5FA"/></svg>';
const OPERATIONS_ICON = '<svg class="admin-module-nav-icon-svg" viewBox="0 0 32 32" width="16" height="16" fill="none" focusable="false" aria-hidden="true"><path d="M2.16 19.3L5.53 12.89C5.82 12.34 6.39 12 7.01 12H14L15 21L2 20C2 19.73 2.05 19.55 2.16 19.3Z" fill="#DBEAFE"/><path d="M2.31 19H8.9C9.51 19 10 18.51 10 17.9V14.11C10 13.5 9.51 13.01 8.9 13.01H5.48L2.31 19Z" fill="#93C5FD"/><path d="M2 20V25.23C2 26.21 2.8 27.01 3.78 27.01H28.2C29.19 27.01 30 26.2 30 25.21V20L22.5 17L14 20H2Z" fill="#2563EB"/><path d="M12 26.5C12 28.433 10.433 30 8.5 30C6.567 30 5 28.433 5 26.5C5 24.567 6.567 23 8.5 23C10.433 23 12 24.567 12 26.5ZM27 26.5C27 28.433 25.433 30 23.5 30C21.567 30 20 28.433 20 26.5C20 24.567 21.567 23 23.5 23C25.433 23 27 24.567 27 26.5Z" fill="#1E3A8A"/><path d="M10 26.5C10 27.3284 9.32843 28 8.5 28C7.67157 28 7 27.3284 7 26.5C7 25.6716 7.67157 25 8.5 25C9.32843 25 10 25.6716 10 26.5ZM25 26.5C25 27.3284 24.3284 28 23.5 28C22.6716 28 22 27.3284 22 26.5C22 25.6716 22.6716 25 23.5 25C24.3284 25 25 25.6716 25 26.5Z" fill="#BFDBFE"/><path d="M30 22H29.5C28.65 22 27.96 22.71 28 23.57C28.04 24.38 28.74 25 29.55 25H30V22Z" fill="#1D4ED8"/><path d="M17 7H27C28.66 7 30 8.34 30 10V20H14V10C14 8.34 15.34 7 17 7ZM2 25H2.91C3.51 25 4 24.51 4 23.91V22.09C4 21.49 3.51 21 2.91 21H2V25Z" fill="#60A5FA"/></svg>';
const PAYROLL_ICON = '<svg class="admin-module-nav-icon-svg" viewBox="0 0 32 32" width="16" height="16" fill="none" focusable="false" aria-hidden="true"><path d="M25.05 3.105L24.03 2.165C23.79 1.945 23.42 1.945 23.18 2.165L22.16 3.105C22.02 3.235 21.79 3.235 21.65 3.105L20.63 2.165C20.39 1.945 20.02 1.945 19.78 2.165L18.76 3.105C18.62 3.235 18.39 3.235 18.25 3.105L17.23 2.165C16.99 1.945 16.62 1.945 16.38 2.165L15.35 3.105C15.21 3.235 14.98 3.235 14.84 3.105L13.82 2.165C13.58 1.945 13.21 1.945 12.97 2.165L11.95 3.105C11.81 3.235 11.58 3.235 11.44 3.105L10.42 2.155C10.26 2.005 10 2.125 10 2.345V3.775V29.995H24.61C25.93 29.995 27 28.925 27 27.605V3.765V2.345C27 2.125 26.74 2.015 26.58 2.165L25.55 3.115C25.41 3.235 25.19 3.235 25.05 3.105Z" fill="#60A5FA"/><path d="M12.25 8H24.75C24.89 8 25 7.89 25 7.75V6.25C25 6.11 24.89 6 24.75 6H12.25C12.11 6 12 6.11 12 6.25V7.75C12 7.89 12.11 8 12.25 8ZM12.5 10C12.2239 10 12 10.2239 12 10.5C12 10.7761 12.2239 11 12.5 11H20.5C20.7761 11 21 10.7761 21 10.5C21 10.2239 20.7761 10 20.5 10H12.5ZM12.5 13C12.2239 13 12 13.2239 12 13.5C12 13.7761 12.2239 14 12.5 14H20.5C20.7761 14 21 13.7761 21 13.5C21 13.2239 20.7761 13 20.5 13H12.5ZM12 16.5C12 16.2239 12.2239 16 12.5 16H20.5C20.7761 16 21 16.2239 21 16.5C21 16.7761 20.7761 17 20.5 17H12.5C12.2239 17 12 16.7761 12 16.5ZM12.5 19C12.2239 19 12 19.2239 12 19.5C12 19.7761 12.2239 20 12.5 20H20.5C20.7761 20 21 19.7761 21 19.5C21 19.2239 20.7761 19 20.5 19H12.5ZM12 22.5C12 22.2239 12.2239 22 12.5 22H20.5C20.7761 22 21 22.2239 21 22.5C21 22.7761 20.7761 23 20.5 23H12.5C12.2239 23 12 22.7761 12 22.5ZM22.5 10C22.2239 10 22 10.2239 22 10.5C22 10.7761 22.2239 11 22.5 11H24.5C24.7761 11 25 10.7761 25 10.5C25 10.2239 24.7761 10 24.5 10H22.5ZM22 13.5C22 13.2239 22.2239 13 22.5 13H24.5C24.7761 13 25 13.2239 25 13.5C25 13.7761 24.7761 14 24.5 14H22.5C22.2239 14 22 13.7761 22 13.5ZM22.5 16C22.2239 16 22 16.2239 22 16.5C22 16.7761 22.2239 17 22.5 17H24.5C24.7761 17 25 16.7761 25 16.5C25 16.2239 24.7761 16 24.5 16H22.5ZM22 19.5C22 19.2239 22.2239 19 22.5 19H24.5C24.7761 19 25 19.2239 25 19.5C25 19.7761 24.7761 20 24.5 20H22.5C22.2239 20 22 19.7761 22 19.5ZM22.5 22C22.2239 22 22 22.2239 22 22.5C22 22.7761 22.2239 23 22.5 23H24.5C24.7761 23 25 22.7761 25 22.5C25 22.2239 24.7761 22 24.5 22H22.5ZM22 27.495V25.935C22 25.415 21.58 24.995 21.06 24.995H6.94C6.42 24.995 6 25.415 6 25.935V27.495C6 28.875 7.12 29.995 8.5 29.995H24.5C23.12 29.995 22 28.875 22 27.495Z" fill="#2563EB"/></svg>';

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
  const usersLink = standaloneUsersLink(access, path);

  return `<nav class="navbar admin-module-navbar" data-module-navigation="true" aria-label="Módulos principales">
    <a class="brand admin-module-brand" href="${RECRUITMENT_PATH}" aria-label="LoginPro"><img src="/public/logo-loginpro.svg" alt="LoginPro" /></a>
    <div class="admin-module-nav-links">${modules}</div>
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
  return stripDuplicateModuleButtons(output, moduleNavbar);
}

export const ADMIN_MODULE_PATHS = Object.freeze({
  recruitment: RECRUITMENT_PATH,
  operations: OPERATIONS_PATH,
  attendance: ATTENDANCE_PATH,
  payroll: PAYROLL_PATH,
  workerPortalActivation: WORKER_PORTAL_ACTIVATION_PATH,
  testWorkspace: TEST_WORKSPACE_PATH
});
