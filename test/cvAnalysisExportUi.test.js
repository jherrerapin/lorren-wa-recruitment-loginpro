import test from 'node:test';
import assert from 'node:assert/strict';

import { enhanceCvAnalysisExportSelection } from '../src/services/cvAnalysisExportUi.js';

function exportForm(group, label, secondary = false) {
  return `<form class="export-form" method="post" action="/admin/estadisticas/cv-analysis/export">
    <input type="hidden" name="reviewToken" value="token-seguro">
    <input type="hidden" name="group" value="${group}">
    <button class="btn ${secondary ? 'secondary ' : ''}small" type="submit">${label}</button>
  </form>`;
}

test('reemplaza las descargas repetidas por un único selector con checks', () => {
  const html = `<!doctype html><html><head><style>.btn{display:block}</style></head><body>
    ${exportForm('all', 'Descargar Excel completo')}
    <div class="group-actions"><span class="badge">2</span>${exportForm('strong', 'Descargar esta sección', true)}</div>
    <div class="group-actions"><span class="badge">1</span>${exportForm('possible', 'Descargar esta sección', true)}</div>
  </body></html>`;

  const output = enhanceCvAnalysisExportSelection(html);

  assert.match(output, /data-cv-export-selector/);
  assert.match(output, /data-export-all/);
  assert.match(output, /value="strong" data-export-group/);
  assert.match(output, /value="possible" data-export-group/);
  assert.match(output, /value="low" data-export-group/);
  assert.match(output, /value="manual" data-export-group/);
  assert.match(output, /Descargar Excel seleccionado/);
  assert.doesNotMatch(output, /Descargar esta sección/);
  assert.doesNotMatch(output, /Descargar Excel completo/);
  assert.equal((output.match(/name="reviewToken"/g) || []).length, 1);
  assert.match(output, /selected\.map\(\(checkbox\) => checkbox\.value\)\.join\(','\)/);
});

test('no modifica otras respuestas HTML', () => {
  const html = '<html><head><style></style></head><body><h1>Otra vista</h1></body></html>';
  assert.equal(enhanceCvAnalysisExportSelection(html), html);
});
