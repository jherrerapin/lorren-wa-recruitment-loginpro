import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('el entrypoint conserva agrupación y filtros sin cargar el runtime legado', async () => {
  const [loader, portalView] = await Promise.all([
    read('src/public/worker-biometric.js'),
    read('src/views/workerPortal.ejs')
  ]);

  assert.match(portalView, /<script src="\/public\/worker-biometric\.js/);
  assert.match(loader, /\/public\/worker-biometric-core\.js/);
  assert.match(loader, /\/public\/worker-biometric-mobile\.js/);
  assert.match(loader, /\/public\/worker-portal-biometric-flow\.js/);
  assert.match(loader, /\/public\/worker-portal-offline-v2\.js/);
  assert.match(loader, /\/public\/worker-portal-offline-controller\.js/);
  assert.doesNotMatch(loader, /worker-portal-offline\.js/);
  assert.doesNotMatch(loader, /\/operaciones\/portal\/offline\.js/);
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
