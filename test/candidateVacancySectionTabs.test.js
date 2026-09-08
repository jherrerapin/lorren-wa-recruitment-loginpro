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

test('el controlador reconoce las cuatro secciones operativas solicitadas', () => {
  const runtime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(runtime, /label: 'Entrevistas'/);
  assert.match(runtime, /title\.includes\('entrevistas'\)/);
  assert.match(runtime, /label: 'Registrados'/);
  assert.match(runtime, /title\.includes\('registrados completos'\)/);
  assert.match(runtime, /title\.includes\('pendientes de agendar'\)/);
  assert.match(runtime, /label: 'Completos sin HV'/);
  assert.match(runtime, /title\.includes\('completos pendientes de hv'\)/);
  assert.match(runtime, /label: 'Aprobados'/);
});

test('solo una sección tabulada queda visible y las demás se ocultan sin borrar contenido', () => {
  const runtime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

  assert.match(runtime, /descriptor\.section\.hidden = index !== 0/);
  assert.match(runtime, /descriptor\.section\.hidden = !selected/);
  assert.match(runtime, /vacancyBody\.prepend\(tabList\)/);
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
