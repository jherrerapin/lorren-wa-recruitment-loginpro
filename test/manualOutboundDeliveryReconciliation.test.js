import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deliverManualOutboundText,
  getManualOutboundUserMessage
} from '../src/services/manualOutboundDeliveryService.js';
import { createMockPrisma } from './helpers/mockPrisma.js';

const candidate = {
  id: 'candidate-reconciliation-1',
  phone: '573001112233',
  botPaused: false,
  botPausedAt: null,
  botPausedBy: null,
  botPauseReason: null,
  botResumeMode: 'resumed_by_candidate_inbound',
  reminderScheduledFor: new Date('2026-07-16T04:00:00.000Z'),
  reminderState: 'SCHEDULED',
  lastOutboundAt: new Date('2026-07-15T20:00:00.000Z')
};

const input = {
  candidateId: candidate.id,
  phone: candidate.phone,
  body: 'Mensaje manual de prueba.',
  actor: 'devloginpro',
  reason: 'Conversacion tomada manualmente desde dashboard',
  rawPayload: {
    source: 'admin_outbound',
    action: 'free_text'
  }
};

function clock(...values) {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)]);
}

function providerSuccess() {
  return { messages: [{ id: 'wamid.reconciliation.1' }] };
}

function assertPendingReconciliation(error) {
  assert.equal(error.code, 'manual_outbound_sent_pending_reconciliation');
  assert.equal(error.sent, true);
  assert.equal(error.persistencePending, true);
  assert.equal(error.providerMessageId, 'wamid.reconciliation.1');
  assert.match(getManualOutboundUserMessage(error), /WhatsApp confirmó el envío/i);
  assert.match(getManualOutboundUserMessage(error), /No reenvíes/i);
  return true;
}

test('count cero después de Meta se muestra como enviado pendiente de reconciliación', async () => {
  const prisma = createMockPrisma({ candidates: [candidate] });
  const originalUpdateMany = prisma.candidate.updateMany;
  let updateAttempt = 0;
  prisma.candidate.updateMany = async (args) => {
    updateAttempt += 1;
    if (updateAttempt === 2) return { count: 0 };
    return originalUpdateMany(args);
  };

  await assert.rejects(
    () => deliverManualOutboundText(prisma, input, {
      sendText: providerSuccess,
      now: clock('2026-07-16T01:35:00.000Z', '2026-07-16T01:35:01.000Z')
    }),
    assertPendingReconciliation
  );

  assert.equal(prisma.state.messages.length, 1);
  assert.equal(prisma.state.messages[0].rawPayload.delivery.state, 'SENT');
  assert.equal(prisma.state.messages[0].rawPayload.delivery.candidateStateCount, 0);
});

test('fallo transaccional posterior a Meta advierte sin afirmar que el envío falló', async () => {
  const prisma = createMockPrisma({ candidates: [candidate] });
  const originalTransaction = prisma.$transaction;
  let transactionAttempt = 0;
  prisma.$transaction = async (callback) => {
    transactionAttempt += 1;
    if (transactionAttempt === 2) throw new Error('database_unavailable_after_provider');
    return originalTransaction(callback);
  };

  await assert.rejects(
    () => deliverManualOutboundText(prisma, input, {
      sendText: providerSuccess,
      now: clock('2026-07-16T01:36:00.000Z', '2026-07-16T01:36:01.000Z')
    }),
    assertPendingReconciliation
  );

  assert.equal(prisma.state.messages.length, 1);
  assert.equal(prisma.state.messages[0].rawPayload.delivery.state, 'SENDING');
});

test('el error persistido del proveedor elimina access_token y Bearer', async () => {
  const prisma = createMockPrisma({ candidates: [candidate] });
  const rejection = new Error('falló access_token=secreto Bearer token-supersecreto');
  rejection.response = { status: 400 };

  await assert.rejects(
    () => deliverManualOutboundText(prisma, input, {
      sendText: async () => { throw rejection; },
      now: clock('2026-07-16T01:40:00.000Z', '2026-07-16T01:40:01.000Z')
    }),
    (error) => error.code === 'manual_outbound_provider_rejected'
  );

  const lastError = prisma.state.messages[0].rawPayload.delivery.lastError;
  assert.match(lastError, /access_token=\[REDACTED\]/);
  assert.match(lastError, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(lastError, /secreto|token-supersecreto/);
});
