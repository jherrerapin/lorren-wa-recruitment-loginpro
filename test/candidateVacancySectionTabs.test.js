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

test('el controlador integra Gestión de entrevistas con las cuatro secciones operativas existentes', () => {
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
});

test('Gestión de entrevistas usa el board existente y la barra queda antes del contenido', () => {
  const runtime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(runtime, /const section = panel\.querySelector\('\[data-interview-coordination-board\]'\)/);
  assert.match(runtime, /section,/);
  assert.match(runtime, /vacancyHeader\.insertAdjacentElement\('afterend', tabList\)/);
  assert.doesNotMatch(runtime, /cloneNode/);
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

test('las descargas se contextualizan por pestaña sin cambiar los href existentes', () => {
  const runtime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(runtime, /registered: 'registered'/);
  assert.match(runtime, /'missing-cv': 'missing_cv_complete'/);
  assert.match(runtime, /approved: 'approved'/);
  assert.match(runtime, /scope === 'all'/);
  assert.match(runtime, /expectedScope && scope === expectedScope/);
  assert.match(runtime, /\.export-bar a\[href\*="\/admin\/export\?"\]/);
  assert.match(runtime, /a\[href\^="\/admin\/outreach\/approved"\]/);
  assert.match(runtime, /anchor\.hidden = activeKey !== 'approved'/);
  assert.doesNotMatch(runtime, /setAttribute\(['"]href['"]/);
});

test('solo una sección tabulada queda visible y las demás se ocultan sin borrar contenido', () => {
  const runtime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(runtime, /descriptor\.section\.hidden = index !== 0/);
  assert.match(runtime, /descriptor\.section\.hidden = !selected/);
  assert.match(runtime, /role', 'tabpanel'/);
  assert.doesNotMatch(runtime, /\.remove\(\)/);
  assert.doesNotMatch(runtime, /innerHTML\s*=/);
});

test('la barra de pestañas es accesible y usable en móvil sin recargar la página', () => {
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
