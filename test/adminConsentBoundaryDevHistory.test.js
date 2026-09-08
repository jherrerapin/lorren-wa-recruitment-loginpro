import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { deliverManualOutboundText } from '../src/services/manualOutboundDeliveryService.js';

function pendingConsentPrisma() {
  const calls = {
    transactions: 0,
    providerSends: 0
  };
  const candidate = {
    id: 'candidate-pending-consent',
    dataConsentStatus: 'PENDING',
    botPaused: false,
    botPausedAt: null,
    botPausedBy: null,
    botPauseReason: null,
    botResumeMode: 'resumed_by_candidate_inbound',
    reminderScheduledFor: null,
    reminderState: 'NONE',
    lastOutboundAt: null
  };
  const prisma = {
    candidate: {
      findUnique: async ({ where } = {}) => where?.id === candidate.id ? { ...candidate } : null
    },
    message: {
      findMany: async () => []
    },
    $transaction: async (callback) => {
      calls.transactions += 1;
      return callback(prisma);
    }
  };
  return { prisma, candidate, calls };
}

for (const action of ['request_missing_data', 'request_hv', 'reminder']) {
  test(`bloquea ${action} antes de crear intención o contactar WhatsApp sin consentimiento`, async () => {
    const harness = pendingConsentPrisma();
    const sendText = async () => {
      harness.calls.providerSends += 1;
      return { messages: [{ id: 'wamid.should-not-send' }] };
    };

    await assert.rejects(
      () => deliverManualOutboundText(harness.prisma, {
        candidateId: harness.candidate.id,
        phone: '573001112233',
        body: 'Solicitud protegida de prueba',
        actor: 'dev',
        rawPayload: {
          source: 'admin_outbound',
          action
        }
      }, { sendText }),
      (error) => {
        assert.equal(error.code, 'manual_outbound_consent_required');
        assert.match(error.userMessage, /aceptar la autorización de tratamiento de datos/i);
        return true;
      }
    );

    assert.equal(harness.calls.transactions, 1);
    assert.equal(harness.calls.providerSends, 0);
  });
}

test('la autoridad común carga dataConsentStatus y limita el guard a acciones predefinidas protegidas', () => {
  const source = fs.readFileSync('src/services/manualOutboundDeliveryService.js', 'utf8');
  assert.match(source, /CONSENT_PROTECTED_MANUAL_ACTIONS = new Set\(\['request_missing_data', 'request_hv', 'reminder'\]\)/);
  assert.match(source, /dataConsentStatus: true/);
  assert.match(source, /CONSENT_PROTECTED_MANUAL_ACTIONS\.has\(action\)[\s\S]*dataConsentStatus[\s\S]*!== 'ACCEPTED'/);
  const guardIndex = source.indexOf('CONSENT_PROTECTED_MANUAL_ACTIONS.has(action)');
  const claimIndex = source.indexOf('claimManualOutboundDelivery(tx');
  const intentIndex = source.indexOf('persistOutboundConversationMessage(tx');
  assert.ok(guardIndex >= 0 && claimIndex > guardIndex && intentIndex > guardIndex);
});

test('DEV representa evidencia técnica preconsentimiento sin atribuírsela literalmente al candidato', () => {
  const source = fs.readFileSync('src/views/detail.ejs', 'utf8');
  assert.match(source, /const devConversationBody = \(message\) =>/);
  assert.match(source, /source === 'data_consent_gate'/);
  assert.match(source, /Archivo enviado antes de autorizar; el archivo no fue almacenado\.[\s\S]*return '\(archivo adjunto\)'/);
  assert.match(source, /Mensaje recibido antes de completar la autorización; el contenido protegido no fue almacenado\.[\s\S]*return '\(mensaje recibido\)'/);
  assert.match(source, /return body \|\| '\(archivo adjunto\)'/);
  assert.match(source, /<%= devConversationBody\(m\) %>/);
});

test('DEV deshabilita los accesos predefinidos de captura mientras el consentimiento está pendiente', () => {
  const source = fs.readFileSync('src/views/detail.ejs', 'utf8');
  assert.match(source, /dataConsentAccepted = candidate\.dataConsentStatus === 'ACCEPTED'/);
  assert.match(source, /name="action" value="request_missing_data"/);
  assert.match(source, /name="action" value="request_hv"/);
  assert.match(source, /name="action" value="reminder"/);
  assert.match(source, /Consentimiento pendiente/);
});
