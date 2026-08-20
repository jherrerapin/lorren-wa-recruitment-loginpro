import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const view = fs.readFileSync(
  new URL('../src/views/operacionesAsignacionesConfirmacion.ejs', import.meta.url),
  'utf8'
);

test('correo y WhatsApp incluyen nombre, documento y teléfono de auxiliares confirmados en el texto al solicitante', () => {
  assert.match(view, /data-worker-document-type="<%= assignment\.worker\.documentType \|\| '' %>"/);
  assert.match(view, /data-worker-document-number="<%= assignment\.worker\.documentNumber \|\| '' %>"/);
  assert.ok(view.includes("card.dataset.workerDocumentType"));
  assert.ok(view.includes("card.dataset.workerDocumentNumber"));
  assert.ok(view.includes("[documentType, documentNumber].filter(Boolean).join(' ')"));
  assert.ok(view.includes("documentLabel ? ` | Documento: ${documentLabel}` : ''"));
  assert.ok(view.includes("phone ? ` | Tel: ${phone}` : ''"));

  assert.ok(view.includes("return /Estado:\\s*Confirmado/i.test"));
  assert.match(view, /const body = completionDeliveryText\(button\)/);
  assert.match(view, /const text = completionDeliveryText\(button\)/);
});
