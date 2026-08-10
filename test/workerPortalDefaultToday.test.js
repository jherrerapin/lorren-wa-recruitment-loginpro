import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('el Portal del Auxiliar inicia mostrando las asignaciones de hoy', async () => {
  const loader = await read('src/public/worker-biometric.js');
  const portalView = await read('src/views/workerPortal.ejs');

  assert.match(portalView, /data-portal-preset="today">Hoy<\/button>/);
  assert.match(loader, /function bogotaDateKey\(/);
  assert.match(loader, /timeZone:\s*'America\/Bogota'/);
  assert.match(loader, /if \(name === 'today'\) \{\s*fromInput\.value = today;\s*toInput\.value = today;/);
  assert.match(loader, /document\.body\.classList\.add\('portal-filters-ready'\);\s*setPreset\('today'\);\s*return true;/);
});
