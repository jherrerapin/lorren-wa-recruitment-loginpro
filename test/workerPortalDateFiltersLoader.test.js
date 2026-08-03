import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('la vista entrega los filtros aunque el JavaScript todavía no haya iniciado', async () => {
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
  assert.match(portalView, /worker-biometric\.js\?v=20260803-worker-portal-runtime-v5/);
  assert.doesNotMatch(portalView, /20260730-mobile-camera-v3/);
});

test('el entrypoint conserva agrupación y filtros con una sola cola offline', async () => {
  const loader = await read('src/public/worker-biometric.js');

  assert.match(loader, /\/public\/worker-biometric-core\.js/);
  assert.match(loader, /\/public\/worker-biometric-mobile\.js/);
  assert.match(loader, /\/public\/worker-portal-biometric-flow\.js/);
  assert.match(loader, /\/public\/worker-portal-offline\.js/);
  assert.doesNotMatch(loader, /worker-portal-offline-v2\.js/);
  assert.match(loader, /\/public\/worker-portal-offline-controller\.js/);
  assert.doesNotMatch(loader, /worker-portal-hardening\.js/);

  assert.match(loader, /assignment-date-from/);
  assert.match(loader, /assignment-date-to/);
  assert.match(loader, /assignment-status-filter/);
  assert.match(loader, /\['today', 'Hoy'\]/);
  assert.match(loader, /\['upcoming', 'Próximas'\]/);
  assert.match(loader, /\['week', '7 días'\]/);
  assert.match(loader, /\['all', 'Todas'\]/);
  assert.match(loader, /function applyFilters\(\)/);
  assert.match(loader, /setPreset\('upcoming'\)/);
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
