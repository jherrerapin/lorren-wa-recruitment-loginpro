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

test('el rango sigue cargándose directamente para no DEV y DEV tiene fallback dinámico desde pestañas', () => {
  const adminHtml = injectAdminModuleNavigation(baseHtml, req('admin'));
  assert.match(adminHtml, /\/public\/candidate-export-date-range\.js/);
  assert.equal((adminHtml.match(/candidate-export-date-range\.js/g) || []).length, 1);

  const devHtml = injectAdminModuleNavigation(baseHtml, req('dev'));
  assert.match(devHtml, /\/public\/candidate-vacancy-section-tabs\.js/);

  const tabsRuntime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');
  assert.match(tabsRuntime, /DATE_RANGE_SCRIPT = '\/public\/candidate-export-date-range\.js'/);
  assert.match(tabsRuntime, /ensureDateRangeScript\(\)/);

  const usersHtml = injectAdminModuleNavigation(baseHtml, req('admin', '/admin/users'));
  assert.doesNotMatch(usersHtml, /candidate-export-date-range\.js/);
});

test('la UI usa un solo selector visual y un calendario propio para elegir inicio y fin', () => {
  const runtime = fs.readFileSync('src/public/candidate-export-date-range.js', 'utf8');

  assert.match(runtime, /candidate-export-range-trigger/);
  assert.match(runtime, /candidate-export-range-popover/);
  assert.match(runtime, /candidate-export-range-grid/);
  assert.match(runtime, /Selecciona la fecha inicial y luego la fecha final/);
  assert.match(runtime, /let selectedStart = '';/);
  assert.match(runtime, /let selectedEnd = '';/);
  assert.doesNotMatch(runtime, /input\.type\s*=\s*['"]date['"]/);
});

test('el calendario se reposiciona arriba cuando no cabe debajo y limita su alto al viewport', () => {
  const runtime = fs.readFileSync('src/public/candidate-export-date-range.js', 'utf8');

  assert.match(runtime, /candidate-export-range-popover\.is-above/);
  assert.match(runtime, /max-height:calc\(100vh - 24px\)/);
  assert.match(runtime, /const positionPopover = \(\) =>/);
  assert.match(runtime, /initialRect\.bottom > window\.innerHeight - 12/);
  assert.match(runtime, /spaceAbove > spaceBelow/);
  assert.match(runtime, /popover\.classList\.add\('is-above'\)/);
});

test('el histórico reutiliza el mismo selector, filtra por fecha visible y acota la selección masiva', () => {
  const runtime = fs.readFileSync('src/public/candidate-export-date-range.js', 'utf8');

  assert.match(runtime, /function historyIsActive\(vacancyId\)/);
  assert.match(runtime, /params\.get\(`vh_\$\{vacancyId\}`\)/);
  assert.match(runtime, /data-vacancy-bulk-status/);
  assert.match(runtime, /bulkToolbar\.prepend\(controls\)/);
  assert.match(runtime, /candidate-date-range-change/);
  assert.match(runtime, /function candidateRegisteredDate\(row\)/);
  assert.match(runtime, /Fecha de registro:/);
  assert.match(runtime, /row\.hidden = !inRange/);
  assert.match(runtime, /data-history-candidate-id/);
  assert.match(runtime, /data-history-select-all/);
  assert.match(runtime, /rowIsActuallyVisible\(row\)/);
  assert.match(runtime, /pruneHiddenHistorySelections\(panel\)/);
});

test('quitar el rango restaura el histórico visible y notifica el cambio', () => {
  const runtime = fs.readFileSync('src/public/candidate-export-date-range.js', 'utf8');

  assert.match(runtime, /selectedStart = '';/);
  assert.match(runtime, /selectedEnd = '';/);
  assert.match(runtime, /emitRangeChange\(\);/);
  assert.match(runtime, /detail: \{ dateFrom: selectedStart, dateTo: selectedEnd \}/);
  assert.match(runtime, /const inRange = \(!dateFrom \|\| registeredDate >= dateFrom\)/);
  assert.match(runtime, /restoreRangeDecoratedLinks\(bar\)/);
});

test('el rango usa el scope de la pestaña activa y nunca scope all para la descarga contextual', () => {
  const runtime = fs.readFileSync('src/public/candidate-export-date-range.js', 'utf8');

  assert.match(runtime, /TAB_EXPORT_SCOPE/);
  assert.match(runtime, /contacted: 'contacted'/);
  assert.match(runtime, /contracted: 'contracted'/);
  assert.match(runtime, /rejected: 'rejected'/);
  assert.match(runtime, /activeVacancyExportScope/);
  assert.match(runtime, /url\.searchParams\.set\('scope', context\.scope\)/);
  assert.match(runtime, /url\.searchParams\.set\('dateFrom', dateFrom\)/);
  assert.match(runtime, /url\.searchParams\.set\('dateTo', dateTo\)/);
  assert.match(runtime, /const allLink = links\.find\(\(link\) => exportScope\(link\) === 'all'\)/);
  assert.match(runtime, /allLink\.hidden = true/);
});

test('el botón contextual muestra pestaña y rango seleccionado', () => {
  const runtime = fs.readFileSync('src/public/candidate-export-date-range.js', 'utf8');

  assert.match(runtime, /TAB_EXPORT_LABEL/);
  assert.match(runtime, /contacted: 'contactados'/);
  assert.match(runtime, /rejected: 'rechazados'/);
  assert.match(runtime, /scopedLink\.textContent = `↓ Descargar \$\{context\.label\} · \$\{rangeLabel\(dateFrom, dateTo\)\}`/);
  assert.match(runtime, /RANGE_DATE_FORMATTER/);
});

test('al cambiar de pestaña el mismo selector se mueve arriba y recalcula la descarga', () => {
  const runtime = fs.readFileSync('src/public/candidate-export-date-range.js', 'utf8');

  assert.match(runtime, /function placeVacancyRangeControl\(controls, panel, bar\)/);
  assert.match(runtime, /candidate-vacancy-section-tabs/);
  assert.match(runtime, /tabList\.insertAdjacentElement\('afterend', controls\)/);
  assert.match(runtime, /candidate-vacancy-tab-change/);
  assert.match(runtime, /refreshDownloadContext\(\)/);
  assert.match(runtime, /placeVacancyRangeControl\(controls, panel, bar\)/);
});

test('completar o quitar el rango aplica automáticamente y conserva la pestaña activa', () => {
  const runtime = fs.readFileSync('src/public/candidate-export-date-range.js', 'utf8');

  assert.match(runtime, /function vacancyRangeTarget\(panel, dateFrom, dateTo\)/);
  assert.match(runtime, /vacancyTab_\$\{vacancyId\}/);
  assert.match(runtime, /const rangeComplete = \(!selectedStart && !selectedEnd\) \|\| \(selectedStart && selectedEnd\)/);
  assert.match(runtime, /window\.location\.assign\(vacancyRangeTarget\(panel, selectedStart, selectedEnd\)\)/);
  assert.doesNotMatch(runtime, /Aplicar rango|Aplicar fecha|Filtrar fechas/);
});

test('un rango completo carga todos los registros del estado dentro de la pestaña y oculta ver todos', () => {
  const tabsRuntime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(tabsRuntime, /RANGE_STATUS_ROUTE_BY_TAB/);
  assert.match(tabsRuntime, /'missing-cv': Object\.freeze\(\{ status: 'missing_cv_complete' \}\)/);
  assert.match(tabsRuntime, /approved: Object\.freeze\(\{ status: 'all', approvedOnly: '1' \}\)/);
  assert.match(tabsRuntime, /function hasCompleteRegistrationRange\(\)/);
  assert.match(tabsRuntime, /hasCompleteRegistrationRange\(\) && RANGE_STATUS_ROUTE_BY_TAB\[activeKey\]/);
  assert.match(tabsRuntime, /!localKeys\.has\('missing-cv'\)/);
  assert.match(tabsRuntime, /buildRemoteStatusSection\('Completos sin HV', 'missing-cv'\)/);
  assert.match(tabsRuntime, /data-range-status-content/);
  assert.match(tabsRuntime, /filterApprovedRows\(sourceTable, descriptor\)/);
  assert.match(tabsRuntime, /sourceToggle\.hidden = true/);
  assert.match(tabsRuntime, /return true;/);
});

test('la vista plana completa el rango en base de datos para estados que antes podían quedar truncados', () => {
  const service = fs.readFileSync('src/services/vacancyDashboardSearchExpansion.js', 'utf8');
  const loader = service.match(/async function loadCompleteLegacyDateRangeCandidates[\s\S]*?\n}\n\nexport function applyApplicantDateRangeToVacancyLists/)?.[0] || '';

  assert.match(service, /COMPLETE_RANGE_LEGACY_SCOPES/);
  assert.match(service, /'contacted'/);
  assert.match(service, /'contracted'/);
  assert.match(service, /'rejected'/);
  assert.match(service, /function hasCompleteApplicantDateRange\(dateRange = \{\}\)/);
  assert.match(loader, /applicantCreatedAtWhere\(dateRange\)/);
  assert.match(loader, /buildCandidateAccessWhere\(accessContext\)/);
  assert.match(loader, /\{ vacancyId \}/);
  assert.match(loader, /approvedOnly/);
  assert.doesNotMatch(loader, /\btake\s*:/);
  assert.match(service, /if \(completeRangeCandidates\) candidates = completeRangeCandidates;/);
});

test('los enlaces generados después de instalar el calendario también reciben las fechas', () => {
  const runtime = fs.readFileSync('src/public/candidate-export-date-range.js', 'utf8');

  assert.match(runtime, /bar\.addEventListener\('click'/);
  assert.match(runtime, /event\.target\.closest\(EXPORT_LINK_SELECTOR\)/);
  assert.match(runtime, /url\.searchParams\.set\('dateFrom', selectedStart\)/);
  assert.match(runtime, /url\.searchParams\.set\('dateTo', selectedEnd\)/);
});

test('el selector normaliza el orden del rango, permite quitarlo y no usa diálogos nativos', () => {
  const runtime = fs.readFileSync('src/public/candidate-export-date-range.js', 'utf8');

  assert.match(runtime, /else if \(value < selectedStart\)/);
  assert.match(runtime, /selectedEnd = selectedStart;/);
  assert.match(runtime, /selectedStart = value;/);
  assert.match(runtime, /Quitar rango/);
  assert.doesNotMatch(runtime, /\b(?:alert|confirm|prompt)\s*\(/);
  assert.match(runtime, /@media\(max-width:768px\)/);
});

test('la ruta de exportación mantiene la autoridad de fecha en Candidate.createdAt', () => {
  const adminRouteSource = fs.readFileSync('src/routes/admin.js', 'utf8');

  assert.match(adminRouteSource, /const dateFilter = normalizeCandidateDateRangeFilter\(req\.query\);/);
  assert.match(adminRouteSource, /dateFilter\.createdAtWhere/);
  assert.match(adminRouteSource, /createdAt:\s*dateFilter\.createdAtWhere/);
  assert.match(adminRouteSource, /filterCandidatesForExport\([\s\S]*\{ isDev: accessContext\.isDev, vacancy \}/);
});
