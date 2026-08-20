import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const view = fs.readFileSync(
  new URL('../src/views/operacionesAsignacionesConfirmacion.ejs', import.meta.url),
  'utf8'
);

test('correo y WhatsApp incluyen nombre y documento, pero no teléfono, en el texto al solicitante', () => {
  assert.match(view, /data-worker-document-type="<%= assignment\.worker\.documentType \|\| '' %>"/);
  assert.match(view, /data-worker-document-number="<%= assignment\.worker\.documentNumber \|\| '' %>"/);

  const deliveryTextMatch = view.match(
    /function completionDeliveryText\(button\) \{([\s\S]*?)\n    \}\n\n    function downloadCompletionPdf/
  );
  assert.ok(deliveryTextMatch, 'Debe existir el compositor único de entrega al solicitante.');
  const deliveryTextSource = deliveryTextMatch[1];

  assert.ok(deliveryTextSource.includes("card.dataset.workerDocumentType"));
  assert.ok(deliveryTextSource.includes("card.dataset.workerDocumentNumber"));
  assert.ok(deliveryTextSource.includes("[documentType, documentNumber].filter(Boolean).join(' ')"));
  assert.ok(deliveryTextSource.includes("documentLabel ? ` | Documento: ${documentLabel}` : ''"));
  assert.doesNotMatch(deliveryTextSource, /workerPhone|\| Tel:/);

  assert.ok(deliveryTextSource.includes("return /Estado:\\s*Confirmado/i.test"));
  assert.match(view, /const body = completionDeliveryText\(button\)/);
  assert.match(view, /const text = completionDeliveryText\(button\)/);
});
