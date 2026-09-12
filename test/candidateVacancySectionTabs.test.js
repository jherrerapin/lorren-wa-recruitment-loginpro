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

test('el controlador integra Gestión y todas las secciones operativas en la barra principal', () => {
  const runtime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(runtime, /label: 'Gestión de entrevistas'/);
  assert.match(runtime, /panel\.querySelector\('\[data-interview-coordination-board\]'\)/);
  assert.match(runtime, /managementDescriptor\(panel\)/);
  assert.match(runtime, /label: 'Entrevistas'/);
  assert.match(runtime, /label: 'Registrados'/);
  assert.match(runtime, /label: 'Completos sin HV'/);
  assert.match(runtime, /label: 'Aprobados'/);
  assert.match(runtime, /label: 'Contratados'/);
  assert.match(runtime, /'contacted'/);
  assert.match(runtime, /'rejected'/);
});

test('la fila secundaria de estados queda forzosamente oculta aunque tenga display inline', () => {
  const runtime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(runtime, /STATUS_TAB_KEYS = new Set\(\['registered', 'approved', 'contacted', 'contracted', 'rejected'\]\)/);
  assert.match(runtime, /panel\.querySelector\('\[data-vacancy-status-filters\]'\)/);
  assert.match(runtime, /filterBar\.querySelectorAll\('a\[data-vacancy-status-scope\]'\)/);
  assert.match(runtime, /filterBar\.hidden = true/);
  assert.match(runtime, /filterBar\.style\.setProperty\('display', 'none', 'important'\)/);
  assert.match(runtime, /filterBar\.setAttribute\('aria-hidden', 'true'\)/);
});

test('Contactados, Contratados y Rechazados usan panel inline cuando no existe sección local', () => {
  const runtime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(runtime, /REMOTE_STATUS_KEYS = new Set\(\['contacted', 'contracted', 'rejected'\]\)/);
  assert.match(runtime, /function buildRemoteStatusSection\(label, key\)/);
  assert.match(runtime, /section\.dataset\.remoteStatusSection = key/);
  assert.match(runtime, /remoteHref: anchor\.getAttribute\('href'\) \|\| ''/);
  assert.match(runtime, /function buildRemoteStatusUrl\(descriptor, vacancyId\)/);
  assert.match(runtime, /url\.searchParams\.set\('vacancyId', vacancyId\)/);
  assert.match(runtime, /async function loadRemoteStatusSection\(descriptor, tab, vacancyId\)/);
  assert.match(runtime, /await fetch\(remoteUrl\.pathname \+ remoteUrl\.search/);
  assert.match(runtime, /parsed\.querySelector\('#legacy-candidates-table'\)/);
  assert.match(runtime, /document\.importNode\(sourceTable, true\)/);
  assert.match(runtime, /loadRemoteStatusSection\(target\.descriptor, target\.tab, rawVacancyId\)/);
});

test('si la carga inline falla conserva un fallback explícito a la ruta autorizada', () => {
  const runtime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(runtime, /descriptor\.remoteState = 'error'/);
  assert.match(runtime, /No fue posible cargar estos registros dentro de la vacante/);
  assert.match(runtime, /fallback\.href = remoteUrl\.pathname \+ remoteUrl\.search/);
  assert.match(runtime, /fallback\.textContent = 'Abrir vista alternativa'/);
});

test('Gestión de entrevistas usa el board existente y la barra queda antes del contenido', () => {
  const runtime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(runtime, /const section = panel\.querySelector\('\[data-interview-coordination-board\]'\)/);
  assert.match(runtime, /section,/);
  assert.match(runtime, /vacancyHeader\.insertAdjacentElement\('afterend', tabList\)/);
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
});

test('cada pestaña con sección reutiliza el histórico de la vacante y conserva la pestaña tras recargar', () => {
  const runtime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(runtime, /TAB_CONTEXT_PREFIX = 'vacancyTab_'/);
  assert.match(runtime, /panel\.querySelector\('\[data-vacancy-cycle-toggle\]'\)/);
  assert.doesNotMatch(runtime, /Ver todos los registros de esta pestaña/);
  assert.match(runtime, /url\.searchParams\.set\(tabContextParam\(vacancyId\), key\)/);
  assert.match(runtime, /link\.dataset\.sectionHistoryAction = descriptor\.key/);
  assert.match(runtime, /sourceToggle\.hidden = true/);
  assert.match(runtime, /searchParams\.get\(tabContextParam\(rawVacancyId\)\)/);
  assert.match(runtime, /installHistoryActions\(panel, descriptors, rawVacancyId\)/);
});

test('con rango de registro activo los estados locales usan la vista completa autorizada', () => {
  const runtime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(runtime, /function hasApplicantDateRange\(\)/);
  assert.match(runtime, /params\.get\('dateFrom'\)/);
  assert.match(runtime, /params\.get\('dateTo'\)/);
  assert.match(runtime, /function replaceLocalStatusDescriptorsForDateRange\(localDescriptors, vacancyBody, rangeActive\)/);
  assert.match(runtime, /const scope = EXPORT_SCOPE_BY_TAB\[descriptor\.key\] \|\| ''/);
  assert.match(runtime, /remoteHref: `\/admin\?status=\$\{encodeURIComponent\(scope\)\}`/);
  assert.match(runtime, /dateRangeBacked: true/);
  assert.match(runtime, /const localDescriptors = replaceLocalStatusDescriptorsForDateRange\(rawLocalDescriptors, vacancyBody, rangeActive\)/);
  assert.match(runtime, /if \(target\.descriptor\.remoteHref\) \{[\s\S]*loadRemoteStatusSection\(target\.descriptor, target\.tab, rawVacancyId\)/);
  assert.match(runtime, /if \(rangeActive\) \{[\s\S]*hideCycleScopeForDateRange\(panel\)/);
});

test('el selector de fecha se monta inmediatamente bajo las pestañas de estado', () => {
  const runtime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(runtime, /function placeDateRangeControl\(panel, tabList\)/);
  assert.match(runtime, /panel\.querySelector\('\.candidate-export-date-range'\)/);
  assert.match(runtime, /tabList\.insertAdjacentElement\('afterend', controls\)/);
  assert.match(runtime, /controls\.dataset\.vacancyTabRange = 'true'/);
  assert.match(runtime, /new MutationObserver/);
  assert.match(runtime, /installDateRangeIntegration\(panel, tabList, rawVacancyId\)/);
  assert.match(runtime, /candidate-export-date-range\[data-vacancy-tab-range="true"\]/);
});

test('completar o quitar el rango recarga automáticamente la misma vacante y pestaña', () => {
  const runtime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(runtime, /panel\.addEventListener\('candidate-date-range-change'/);
  assert.match(runtime, /const completeSelection = \(!dateFrom && !dateTo\) \|\| Boolean\(dateFrom && dateTo\)/);
  assert.match(runtime, /if \(!completeSelection\) return/);
  assert.match(runtime, /url\.searchParams\.set\('dateFrom', dateFrom\)/);
  assert.match(runtime, /url\.searchParams\.set\('dateTo', dateTo\)/);
  assert.match(runtime, /url\.searchParams\.set\(tabContextParam\(vacancyId\), activeKey\)/);
  assert.match(runtime, /window\.location\.assign\(url\.pathname \+ url\.search \+ url\.hash\)/);
});

test('todas las pestañas de estado tienen scope de exportación contextual', () => {
  const runtime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(runtime, /registered: 'registered'/);
  assert.match(runtime, /'missing-cv': 'missing_cv_complete'/);
  assert.match(runtime, /approved: 'approved'/);
  assert.match(runtime, /contacted: 'contacted'/);
  assert.match(runtime, /contracted: 'contracted'/);
  assert.match(runtime, /rejected: 'rejected'/);
  assert.match(runtime, /function ensureContextualExportLink\(panel, activeKey, expectedScope\)/);
  assert.match(runtime, /encodeURIComponent\(expectedScope\)/);
  assert.match(runtime, /generatedContextualExport/);
});

test('la pestaña activa publica su scope para que rango y descarga compartan contexto', () => {
  const runtime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(runtime, /panel\.dataset\.activeVacancyTab = activeKey/);
  assert.match(runtime, /panel\.dataset\.activeVacancyExportScope = expectedScope \|\| ''/);
  assert.match(runtime, /candidate-vacancy-tab-change/);
  assert.match(runtime, /detail: \{ key: activeKey, scope: expectedScope \|\| '' \}/);
});

test('DEV puede cargar el mismo selector de rango mediante el controlador de pestañas', () => {
  const runtime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(runtime, /DATE_RANGE_SCRIPT = '\/public\/candidate-export-date-range\.js'/);
  assert.match(runtime, /function ensureDateRangeScript\(\)/);
  assert.match(runtime, /document\.querySelector\(`script\[src="\$\{DATE_RANGE_SCRIPT\}"\]`\)/);
  assert.match(runtime, /document\.head\.appendChild\(script\)/);
  assert.match(runtime, /ensureDateRangeScript\(\)/);
});

test('solo una sección queda visible y las demás se ocultan sin borrar contenido', () => {
  const runtime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(runtime, /descriptor\.section\.hidden = true/);
  assert.match(runtime, /descriptor\.section\.hidden = !selected/);
  assert.match(runtime, /role', 'tabpanel'/);
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
  assert.doesNotMatch(runtime, /\b(?:alert|confirm|prompt)\s*\(/);
});