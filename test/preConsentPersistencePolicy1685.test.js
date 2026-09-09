import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createConsentGateHarness } from './helpers/consentGateHarness.js';
import { evaluateConsentBoundary } from '../src/services/dataConsentGate.js';

function text(id, body) {
  return { id, from: 'TEST-PHONE', type: 'text', text: { body } };
}

function document(id) {
  return {
    id,
    from: 'TEST-PHONE',
    type: 'document',
    document: { id: `${id}-media`, filename: 'hoja-de-vida.pdf', mime_type: 'application/pdf' }
  };
}

test('datos personales reales antes del consentimiento no son consumidos ni encubiertos por el gate', async () => {
  const h = createConsentGateHarness({
    candidate: {
      dataConsentStatus: 'PENDING',
      botResumeMode: 'awaiting_data_consent',
      currentStep: 'GREETING_SENT'
    }
  });
  const inbound = text('PRECONSENT-DATA-1', 'Mi nombre es Ana Pérez, tengo 27 años y vivo en Suba');

  const boundary = evaluateConsentBoundary(h.getCandidate(), inbound);
  assert.equal(boundary.block, false);
  assert.equal(boundary.reason, 'content_persists_independently_of_consent');

  const result = await h.run(inbound);
  assert.equal(result.next, 1, 'el mensaje debe continuar al webhook canónico');
  assert.equal(result.status, null);
  assert.equal(h.sent.length, 0, 'el gate no debe sustituir el mensaje por una respuesta de encubrimiento');
  assert.equal(h.messages.length, 0, 'el gate no debe crear una copia protegida paralela del inbound');
});

test('HV enviada antes del consentimiento continúa al almacenamiento canónico sin placeholder ni pedido de reenvío', async () => {
  const h = createConsentGateHarness({
    candidate: {
      dataConsentStatus: 'PENDING',
      botResumeMode: 'awaiting_data_consent',
      currentStep: 'GREETING_SENT'
    }
  });
  const inbound = document('PRECONSENT-CV-1');

  const boundary = evaluateConsentBoundary(h.getCandidate(), inbound);
  assert.equal(boundary.block, false);
  assert.equal(boundary.reason, 'content_persists_independently_of_consent');

  const result = await h.run(inbound);
  assert.equal(result.next, 1, 'el documento debe continuar a webhook.js');
  assert.equal(result.status, null);
  assert.equal(h.sent.length, 0);
  assert.equal(h.messages.length, 0);

  const webhook = readFileSync(new URL('../src/routes/webhook.js', import.meta.url), 'utf8');
  assert.match(webhook, /fetchMediaMetadata\(message\.document\.id\)/);
  assert.match(webhook, /downloadMedia\(metadata\.url\)/);
  assert.match(webhook, /storeCandidateCv\(/);
});

test('la política nueva elimina placeholders y preConsentProtected del runtime activo', () => {
  const consentGate = readFileSync(new URL('../src/services/dataConsentGate.js', import.meta.url), 'utf8');
  const repository = readFileSync(new URL('../src/services/conversationMessageRepository.js', import.meta.url), 'utf8');

  assert.doesNotMatch(consentGate, /Archivo enviado antes de autorizar; el archivo no fue almacenado/);
  assert.doesNotMatch(consentGate, /Mensaje recibido antes de completar la autorización; el contenido protegido no fue almacenado/);
  assert.doesNotMatch(consentGate, /PRE_CONSENT_ATTACHMENT_REPLY/);
  assert.doesNotMatch(consentGate, /PRE_CONSENT_DATA_REPLY/);
  assert.doesNotMatch(consentGate, /preConsentProtected/);
  assert.doesNotMatch(repository, /preConsentProtected/);
});

test('DEV renombra la eliminación únicamente cuando el consentimiento no está aceptado', async () => {
  const { injectDevConsentResendAction } = await import('../src/routes/devConsentResend.js');
  const html = '<button type="submit" class="btn-danger">Eliminar registro completo</button><h2>Historial de conversación</h2>';

  const pending = injectDevConsentResendAction(html, {
    candidate: { id: 'candidate-1', dataConsentStatus: 'PENDING' },
    outboundWindow: { isOpen: false }
  });
  assert.match(pending, /Eliminar registro por no consentimiento/);
  assert.doesNotMatch(pending, />Eliminar registro completo</);

  const revoked = injectDevConsentResendAction(html, {
    candidate: { id: 'candidate-1', dataConsentStatus: 'REVOKED' },
    outboundWindow: { isOpen: false }
  });
  assert.match(revoked, /Eliminar registro por no consentimiento/);

  const accepted = injectDevConsentResendAction(html, {
    candidate: { id: 'candidate-1', dataConsentStatus: 'ACCEPTED' },
    outboundWindow: { isOpen: false }
  });
  assert.match(accepted, /Eliminar registro completo/);
});
