import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const serviceWorker = fs.readFileSync(new URL('../src/public/worker-portal-sw.js', import.meta.url), 'utf8');


test('las reglas estrictas invalidan el caché anterior del portal', () => {
  assert.match(serviceWorker, /CACHE_NAME\s*=\s*'lorren-worker-portal-shell-v5'/);
  assert.match(serviceWorker, /'\/operaciones\/portal\/offline\.js'/);
  assert.match(serviceWorker, /cache\.addAll\(STATIC_ASSETS\)/);
  assert.match(serviceWorker, /key !== CACHE_NAME/);
  assert.match(serviceWorker, /La asistencia requiere conexión/);
});
