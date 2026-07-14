import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageDirection, MessageType } from '@prisma/client';
import {
  persistInboundConversationMessage,
  persistOutboundConversationMessage
} from '../src/services/conversationMessageRepository.js';

function createPrismaMock({ inboundCount = 1 } = {}) {
  const calls = {
    createMany: [],
    create: []
  };
  const prisma = {
    message: {
      createMany: async (args) => {
        calls.createMany.push(args);
        return { count: inboundCount };
      },
      create: async ({ data }) => {
        calls.create.push(data);
        return { id: 'message-test-1', ...data };
      }
    }
  };
  return { prisma, calls };
}

test('persiste entrada idempotente con identidad de WhatsApp y payload trazable', async () => {
  const { prisma, calls } = createPrismaMock();
  const rawPayload = {
    source: 'data_consent_gate',
    consentDecision: 'ACCEPTED'
  };

  const result = await persistInboundConversationMessage(prisma, {
    candidateId: 'candidate-test-1',
    waMessageId: 'wamid-test-1',
    messageType: MessageType.TEXT,
    body: 'Sí, autorizo',
    rawPayload
  });

  assert.equal(result.created, true);
  assert.equal(result.count, 1);
  assert.equal(calls.createMany.length, 1);
  assert.equal(calls.createMany[0].skipDuplicates, true);
  assert.deepEqual(calls.createMany[0].data, [{
    candidateId: 'candidate-test-1',
    waMessageId: 'wamid-test-1',
    direction: MessageDirection.INBOUND,
    messageType: MessageType.TEXT,
    body: 'Sí, autorizo',
    rawPayload
  }]);
});

test('una entrada duplicada se reporta sin inventar una nueva escritura', async () => {
  const { prisma } = createPrismaMock({ inboundCount: 0 });

  const result = await persistInboundConversationMessage(prisma, {
    candidateId: 'candidate-test-1',
    waMessageId: 'wamid-test-1',
    messageType: MessageType.TEXT,
    body: 'Sí, autorizo'
  });

  assert.equal(result.created, false);
  assert.equal(result.count, 0);
});

test('persiste salida sin permitir que el consumidor altere la dirección', async () => {
  const { prisma, calls } = createPrismaMock();
  const respondedAt = new Date('2026-07-14T15:00:00.000Z');

  const result = await persistOutboundConversationMessage(prisma, {
    candidateId: 'candidate-test-1',
    direction: MessageDirection.INBOUND,
    messageType: MessageType.TEXT,
    body: 'Tu autorización quedó registrada.',
    rawPayload: { source: 'data_consent_gate' },
    respondedAt
  });

  assert.equal(result.created, true);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].direction, MessageDirection.OUTBOUND);
  assert.equal(calls.create[0].respondedAt.toISOString(), respondedAt.toISOString());
  assert.equal(result.message.id, 'message-test-1');
});

test('admite cuerpos nulos y conserva payload JSON sin transformarlo', async () => {
  const { prisma, calls } = createPrismaMock();
  const rawPayload = { type: 'document', metadata: { synthetic: true } };

  await persistInboundConversationMessage(prisma, {
    candidateId: 'candidate-test-2',
    messageType: MessageType.DOCUMENT,
    body: null,
    rawPayload
  });

  const data = calls.createMany[0].data[0];
  assert.equal(Object.hasOwn(data, 'waMessageId'), false);
  assert.equal(data.body, null);
  assert.equal(data.rawPayload, rawPayload);
});

test('rechaza contratos, identificadores, tipos y fechas inválidas antes de persistir', async () => {
  await assert.rejects(
    () => persistInboundConversationMessage({}, {
      candidateId: 'candidate-test-1',
      messageType: MessageType.TEXT
    }),
    /inbound_message_prisma_contract_invalid/
  );
  await assert.rejects(
    () => persistOutboundConversationMessage({ message: { create: true } }, {
      candidateId: 'candidate-test-1',
      messageType: MessageType.TEXT
    }),
    /outbound_message_prisma_contract_invalid/
  );

  const { prisma, calls } = createPrismaMock();
  await assert.rejects(
    () => persistInboundConversationMessage(prisma, {
      candidateId: '   ',
      messageType: MessageType.TEXT
    }),
    /candidate_id_required/
  );
  await assert.rejects(
    () => persistOutboundConversationMessage(prisma, {
      candidateId: 'candidate-test-1',
      messageType: '',
      respondedAt: 'fecha-inválida'
    }),
    /message_type_required/
  );
  await assert.rejects(
    () => persistOutboundConversationMessage(prisma, {
      candidateId: 'candidate-test-1',
      messageType: MessageType.TEXT,
      respondedAt: 'fecha-inválida'
    }),
    /responded_at_invalid/
  );
  assert.equal(calls.createMany.length, 0);
  assert.equal(calls.create.length, 0);
});
