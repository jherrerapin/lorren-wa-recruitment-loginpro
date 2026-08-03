import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('el cargador conserva el runtime vigente de agrupación y filtros del portal', async () => {
  const [loader, portalView, portalRuntime] = await Promise.all([
    read('src/public/worker-biometric.js'),
    read('src/views/workerPortal.ejs'),
    read('src/public/worker-portal-offline.js')
  ]);

  assert.match(portalView, /<script src="\/public\/worker-biometric\.js/);
  assert.match(loader, /\/public\/worker-biometric-core\.js/);
  assert.match(loader, /\/public\/worker-biometric-mobile\.js/);
  assert.match(loader, /\/public\/worker-portal-biometric-flow\.js/);
  assert.match(loader, /\/public\/worker-portal-offline\.js/);
  assert.doesNotMatch(loader, /\/operaciones\/portal\/offline\.js/);
  assert.doesNotMatch(loader, /worker-portal-hardening\.js/);

  assert.match(portalRuntime, /function buildFilters\(/);
  assert.match(portalRuntime, /assignment-date-from/);
  assert.match(portalRuntime, /assignment-date-to/);
  assert.match(portalRuntime, /assignment-status-filter/);
  assert.match(portalRuntime, /initializePortalPresentation\(\)/);
});
