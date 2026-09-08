import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { injectAdminModuleNavigation } from '../src/services/adminNavigation.js';

const baseHtml = `<!doctype html>
<html>
<head><title>Admin</title></head>
<body>
  <nav class="navbar"><a href="/admin">Panel</a></nav>
  <main></main>
</body>
</html>`;

function req(role = 'admin', originalUrl = '/admin') {
  return {
    originalUrl,
    userRole: role,
    session: { userRole: role }
  };
}

test('las pestañas de vacante se cargan solo en la pantalla principal de reclutamiento', () => {
  const adminHtml = injectAdminModuleNavigation(baseHtml, req('admin', '/admin'));
  assert.match(adminHtml, /\/public\/candidate-vacancy-section-tabs\.js/);
  assert.equal((adminHtml.match(/candidate-vacancy-section-tabs\.js/g) || []).length, 1);

  const devHtml = injectAdminModuleNavigation(baseHtml, req('dev', '/admin'));
  assert.match(devHtml, /\/public\/candidate-vacancy-section-tabs\.js/);

  const usersHtml = injectAdminModuleNavigation(baseHtml, req('admin', '/admin/users'));
  assert.doesNotMatch(usersHtml, /candidate-vacancy-section-tabs\.js/);
});

test('el controlador integra Gestión, secciones operativas y Contratados en la barra principal', () => {
  const runtime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(runtime, /label: 'Gestión de entrevistas'/);
  assert.match(runtime, /panel\.querySelector\('\[data-interview-coordination-board\]'\)/);
  assert.match(runtime, /managementDescriptor\(panel\)/);
  assert.match(runtime, /label: 'Entrevistas'/);
  assert.match(runtime, /title\.includes\('entrevistas'\)/);
  assert.match(runtime, /label: 'Registrados'/);
  assert.match(runtime, /title\.includes\('registrados completos'\)/);
  assert.match(runtime, /title\.includes\('pendientes de agendar'\)/);
  assert.match(runtime, /label: 'Completos sin HV'/);
  assert.match(runtime, /title\.includes\('completos pendientes de hv'\)/);
  assert.match(runtime, /label: 'Aprobados'/);
  assert.match(runtime, /label: 'Contratados'/);
  assert.match(runtime, /title === 'contratados'/);
});

test('la fila secundaria de estados se oculta y sus estados faltantes pasan a la barra de pestañas', () => {
  const runtime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(runtime, /STATUS_TAB_KEYS = new Set\(\['registered', 'approved', 'contacted', 'contracted', 'rejected'\]\)/);
  assert.match(runtime, /panel\.querySelector\('\[data-vacancy-status-filters\]'\)/);
  assert.match(runtime, /filterBar\.querySelectorAll\('a\[data-vacancy-status-scope\]'\)/);
  assert.match(runtime, /localKeys\.has\(key\)/);
  assert.match(runtime, /filterBar\.hidden = true/);
  assert.match(runtime, /tab\.removeAttribute\('style'\)/);
  assert.match(runtime, /tab\.dataset\.sectionTab = descriptor\.key/);
  assert.match(runtime, /tabList\.appendChild\(tab\)/);
  assert.match(runtime, /'contacted'/);
  assert.match(runtime, /'rejected'/);
  assert.doesNotMatch(runtime, /cloneNode/);
});

test('Gestión de entrevistas usa el board existente y la barra queda antes del contenido', () => {
  const runtime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(runtime, /const section = panel\.querySelector\('\[data-interview-coordination-board\]'\)/);
  assert.match(runtime, /section,/);
  assert.match(runtime, /vacancyHeader\.insertAdjacentElement\('afterend', tabList\)/);
  assert.doesNotMatch(runtime, /createElement\(['"]section['"]\)/);
});

test('Gestión de entrevistas oculta los controles ajenos y los restaura al salir de la pestaña', () => {
  const runtime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(runtime, /function updateManagementLayout\(panel, tabList, managementSection, activeKey\)/);
  assert.match(runtime, /activeKey === 'interview-management'/);
  assert.match(runtime, /child === tabList/);
  assert.match(runtime, /child === managementSection/);
  assert.match(runtime, /child\.classList\?\.contains\('vacancy-header'\)/);
  assert.match(runtime, /child\.setAttribute\(MANAGEMENT_HIDDEN_ATTR, 'true'\)/);
  assert.match(runtime, /child\.removeAttribute\(MANAGEMENT_HIDDEN_ATTR\)/);
  assert.match(runtime, /updateManagementLayout\(panel, tabList, management\?\.section \|\| null, activeKey\)/);
});

test('cada pestaña local reutiliza el histórico de la vacante y conserva la pestaña tras recargar', () => {
  const runtime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(runtime, /TAB_CONTEXT_PREFIX = 'vacancyTab_'/);
  assert.match(runtime, /panel\.querySelector\('\[data-vacancy-cycle-toggle\]'\)/);
  assert.match(runtime, /Ver todos los registros de esta pestaña/);
  assert.match(runtime, /url\.searchParams\.set\(tabContextParam\(vacancyId\), key\)/);
  assert.match(runtime, /link\.dataset\.sectionHistoryAction = descriptor\.key/);
  assert.match(runtime, /descriptor\.key === 'interview-management'/);
  assert.match(runtime, /sourceToggle\.hidden = true/);
  assert.match(runtime, /sourceToggle\.dataset\.sectionTabsRehomed = 'true'/);
  assert.match(runtime, /searchParams\.get\(tabContextParam\(rawVacancyId\)\)/);
});

test('las descargas se contextualizan por pestaña sin cambiar los href existentes', () => {
  const runtime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(runtime, /registered: 'registered'/);
  assert.match(runtime, /'missing-cv': 'missing_cv_complete'/);
  assert.match(runtime, /approved: 'approved'/);
  assert.match(runtime, /contracted: 'contracted'/);
  assert.match(runtime, /scope === 'all'/);
  assert.match(runtime, /expectedScope && scope === expectedScope/);
  assert.match(runtime, /\.export-bar a\[href\*="\/admin\/export\?"\]/);
  assert.match(runtime, /a\[href\^="\/admin\/outreach\/approved"\]/);
  assert.match(runtime, /anchor\.hidden = activeKey !== 'approved'/);
  assert.doesNotMatch(runtime, /setAttribute\(['"]href['"]/);
});

test('solo una sección local queda visible y las demás se ocultan sin borrar contenido', () => {
  const runtime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(runtime, /descriptor\.section\.hidden = true/);
  assert.match(runtime, /descriptor\.section\.hidden = !selected/);
  assert.match(runtime, /role', 'tabpanel'/);
  assert.doesNotMatch(runtime, /\.remove\(\)/);
  assert.doesNotMatch(runtime, /innerHTML\s*=/);
});

test('la barra de pestañas es accesible y usable en móvil sin diálogos nativos', () => {
  const runtime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(runtime, /role', 'tablist'/);
  assert.match(runtime, /role', 'tab'/);
  assert.match(runtime, /aria-selected/);
  assert.match(runtime, /ArrowLeft/);
  assert.match(runtime, /ArrowRight/);
  assert.match(runtime, /Home/);
  assert.match(runtime, /End/);
  assert.match(runtime, /overflow-x:auto/);
  assert.match(runtime, /@media\(max-width:768px\)/);
  assert.doesNotMatch(runtime, /window\.location\.(?:assign|replace)/);
  assert.doesNotMatch(runtime, /\b(?:alert|confirm|prompt)\s*\(/);
});
