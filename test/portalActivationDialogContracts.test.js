import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const viewUrl = new URL('../src/views/operacionesPortalActivaciones.ejs', import.meta.url);

async function portalActivationView() {
  return readFile(viewUrl, 'utf8');
}

test('Portal del Auxiliar no usa diálogos nativos del navegador', async () => {
  const source = await portalActivationView();

  assert.doesNotMatch(source, /\bwindow\.(?:alert|confirm|prompt)\s*\(/);
  assert.doesNotMatch(source, /(^|[^\w.])(?:alert|confirm|prompt)\s*\(/m);
  assert.match(source, /role="alertdialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /function askConfirmation\(options = \{\}\)/);
  assert.match(source, /document\.addEventListener\('keydown', escape\)/);
  assert.match(source, /event\.key === 'Escape'/);
});

test('generar enlace y eliminar rostro pasan por la confirmación visual', async () => {
  const source = await portalActivationView();

  assert.match(source, /title: 'Generar nuevo enlace'/);
  assert.match(source, /confirmLabel: 'Sí, generar enlace'/);
  assert.match(source, /title: 'Eliminar rostro registrado'/);
  assert.match(source, /confirmLabel: 'Sí, eliminar rostro'/);
  assert.match(source, /if \(!confirmed\) return;/);
  assert.match(source, /\/biometria\/revocar/);
});
