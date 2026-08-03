import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ejs from 'ejs';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('la vista es la única fuente del resumen y los controles de filtros', async () => {
  const portalView = await read('src/views/workerPortal.ejs');

  assert.match(portalView, /class="portal-filter-summary"/);
  assert.match(portalView, /class="portal-filter-panel"/);
  assert.match(portalView, /id="assignment-date-from"/);
  assert.match(portalView, /id="assignment-date-to"/);
  assert.match(portalView, /id="assignment-status-filter"/);
  assert.match(portalView, /data-portal-preset="today"/);
  assert.match(portalView, /data-portal-preset="upcoming"/);
  assert.match(portalView, /data-portal-preset="week"/);
  assert.match(portalView, /data-portal-preset="all"/);
  assert.match(portalView, /id="portal-filtered-empty"/);
  assert.match(portalView, /worker-biometric\.js\?v=20260803-worker-portal-runtime-v5/);
  assert.doesNotMatch(portalView, /20260730-mobile-camera-v3/);
});

test('la plantilla activa renderiza controles y estados sin errores de EJS', async () => {
  const portalView = await read('src/views/workerPortal.ejs');
  const html = ejs.render(portalView, {
    mode: 'active',
    nonce: 'test-nonce',
    assignments: [{
      id: 'assignment-1',
      dateLabel: '3 de agosto de 2026',
      clientName: 'Cliente de prueba',
      timeLabel: '08:00 – 17:00',
      operationPointName: 'Operación principal',
      cityName: 'Bogotá',
      address: 'Dirección de prueba',
      arrivalReported: false,
      departureReported: false,
      breakActionType: null,
      canRegisterArrival: true,
      canRegisterDeparture: false
    }]
  });

  assert.match(html, /Organizar asignaciones/);
  assert.match(html, /data-portal-status="PENDING"/);
  assert.match(html, /id="assignment-filter-result"/);
  assert.match(html, />1 visibles</);
});

test('el entrypoint conecta los controles existentes y conserva una sola cola offline', async () => {
  const loader = await read('src/public/worker-biometric.js');

  assert.match(loader, /20260803-worker-portal-runtime-v5/);
  assert.match(loader, /\/public\/worker-biometric-core\.js/);
  assert.match(loader, /\/public\/worker-biometric-mobile\.js/);
  assert.match(loader, /\/public\/worker-portal-biometric-flow\.js/);
  assert.match(loader, /\/public\/worker-portal-offline\.js/);
  assert.doesNotMatch(loader, /worker-portal-offline-v2\.js/);
  assert.match(loader, /\/public\/worker-portal-offline-controller\.js/);
  assert.doesNotMatch(loader, /worker-portal-hardening\.js/);

  assert.match(loader, /document\.querySelector\('\.portal-filter-summary'\)/);
  assert.match(loader, /document\.querySelector\('\.portal-filter-panel'\)/);
  assert.match(loader, /document\.querySelector\('#portal-filtered-empty'\)/);
  assert.match(loader, /function buildDateGroups\(/);
  assert.match(loader, /function applyFilters\(\)/);
  assert.match(loader, /setPreset\('all'\)/);
  assert.doesNotMatch(loader, /PORTAL_FILTER_STYLE|ensureFilterStyle|ensureSummary|ensurePanel|Filtra por periodo o estado/);
});

test('los filtros reintentan la inicialización y reaccionan a cambios de jornada', async () => {
  const loader = await read('src/public/worker-biometric.js');

  assert.match(loader, /function initializePortalFilters\(\)/);
  assert.match(loader, /function initializeWhenAvailable\(\)/);
  assert.match(loader, /DOMContentLoaded/);
  assert.match(loader, /window\.addEventListener\('pageshow'/);
  assert.match(loader, /MutationObserver/);
  assert.match(loader, /attributeFilter: \['class', 'data-mark-type'\]/);
});
