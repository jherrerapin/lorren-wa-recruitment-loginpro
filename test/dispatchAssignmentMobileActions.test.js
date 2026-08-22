import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('acciones de solicitudes quedan compactas y con ancho coherente en mobile', async () => {
  const [css, view] = await Promise.all([
    readFile(new URL('../src/public/operaciones-ui.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/views/operacionesAsignacionesConfirmacion.ejs', import.meta.url), 'utf8')
  ]);

  assert.match(view, /class="request-actions"/);
  assert.match(view, />Seleccionar<\/a>/);
  assert.match(view, />Editar<\/a>/);
  assert.match(view, /data-delete-service-request="true"/);

  assert.match(css, /@media \(max-width: 760px\) \{[\s\S]*?\.assignment-page \.request-actions\s*\{[\s\S]*?display:\s*grid\s*!important/);
  assert.match(css, /@media \(max-width: 760px\) \{[\s\S]*?grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(82px,\s*1fr\)\)\s*!important/);
  assert.match(css, /@media \(max-width: 760px\) \{[\s\S]*?\.assignment-page \.request-actions > a,[\s\S]*?\.assignment-page \.request-actions > form[\s\S]*?width:\s*100%\s*!important/);
  assert.match(css, /@media \(max-width: 760px\) \{[\s\S]*?\.assignment-page \.request-actions \.btn[\s\S]*?width:\s*100%\s*!important/);
});
