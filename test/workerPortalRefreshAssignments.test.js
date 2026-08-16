import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';

const templatePath = fileURLToPath(new URL('../src/views/workerPortal.ejs', import.meta.url));

async function renderPortal(mode, assignments = []) {
  return ejs.renderFile(templatePath, {
    mode,
    nonce: 'TEST_NONCE',
    expiresAt: null,
    assignments
  });
}

test('el Portal activo permite actualizar asignaciones aun cuando la lista esté vacía', async () => {
  const html = await renderPortal('active');

  assert.match(html, /href="\/operaciones\/portal"[^>]*>Actualizar asignaciones<\/a>/);
  assert.match(html, /No tienes asignaciones activas/);
});

test('el control de actualizar asignaciones no aparece fuera de una sesión activa', async () => {
  for (const mode of ['inactive', 'unavailable']) {
    const html = await renderPortal(mode);
    assert.doesNotMatch(html, /Actualizar asignaciones/);
  }
});
