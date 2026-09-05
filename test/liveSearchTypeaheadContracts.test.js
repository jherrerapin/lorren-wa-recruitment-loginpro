import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { injectAdminModuleNavigation } from '../src/services/adminNavigation.js';

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function adminRequest(path = '/admin') {
  return {
    originalUrl: path,
    url: path,
    session: {
      userRole: 'dev',
      username: 'dev-test',
      canAccessDispatch: true,
      canAccessAttendance: true,
      canAccessPayroll: true,
      canAccessTestWorkspace: true,
      canAccessStatistics: true
    }
  };
}

const baseHtml = '<!doctype html><html><head><title>Prueba</title></head><body><nav class="navbar"><a href="/admin">Panel</a></nav><main>Contenido</main></body></html>';

test('la navegación admin carga una sola autoridad de autocompletado en páginas HTML', () => {
  const once = injectAdminModuleNavigation(baseHtml, adminRequest('/admin'));
  const twice = injectAdminModuleNavigation(once, adminRequest('/admin'));
  assert.match(once, /<script src="\/public\/lorren-live-search\.js" defer><\/script>/);
  assert.equal((twice.match(/\/public\/lorren-live-search\.js/g) || []).length, 1);

  const apiHtml = injectAdminModuleNavigation(baseHtml, adminRequest('/admin/operaciones/asistencia/gestion-tiempo/api/resumen'));
  assert.doesNotMatch(apiHtml, /lorren-live-search\.js/);
});

test('el autocompletado común cubre los buscadores de texto ejecutados y conserva selección accesible', () => {
  const runtime = source('src/public/lorren-live-search.js');

  assert.match(runtime, /input\[name="searchText"\]/);
  assert.match(runtime, /input\[name\^="vs_"\]\[name\$="_text"\]/);
  assert.match(runtime, /workerFilterForm/);
  assert.match(runtime, /payroll-filters/);
  assert.match(runtime, /phoneSearchInput/);
  assert.match(runtime, /attendance-address-search/);

  assert.match(runtime, /AbortController/);
  assert.match(runtime, /aria-autocomplete/);
  assert.match(runtime, /role', 'listbox'/);
  assert.match(runtime, /ArrowDown/);
  assert.match(runtime, /ArrowUp/);
  assert.match(runtime, /event\.key === 'Enter'/);
  assert.match(runtime, /event\.key === 'Escape'/);
  assert.match(runtime, /credentials: 'same-origin'/);
  assert.match(runtime, /fetchFormDocument/);
});

test('el inventario de buscadores no crea una segunda autoridad de negocio', () => {
  const recruitment = source('src/views/list.ejs');
  const assignments = source('src/views/operacionesAsignacionesConfirmacion.ejs');
  const payroll = source('src/views/operacionesGestionTiempo.ejs');
  const whatsapp = source('src/views/operacionesWhatsappMonitor.ejs');
  const attendance = source('src/public/attendance-map-reliability.js');
  const payrollExport = source('src/views/operacionesGestionTiempoExport.ejs');
  const server = source('src/server.js');

  assert.match(recruitment, /name="searchText"/);
  assert.match(recruitment, /name="vs_<%= v\.id %>_text"/);
  assert.match(assignments, /id="workerFilterForm"/);
  assert.match(assignments, /name="q"/);
  assert.match(payroll, /id="search" name="search"/);
  assert.match(whatsapp, /id="phoneSearchInput"/);
  assert.match(attendance, /GEOCODING_ENDPOINT = '\/admin\/operaciones\/asistencia\/geocodificar'/);

  assert.match(payrollExport, /id="export-worker-search"/);
  assert.match(payrollExport, /addEventListener\('input'/);

  assert.match(server, /dispatchOpsExtrasRouter\(prisma\)/);
  assert.doesNotMatch(server, /dispatchAssignmentConfirmationsRouter\(/);
});
