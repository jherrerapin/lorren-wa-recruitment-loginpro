import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageDirection, MessageType } from '@prisma/client';
import {
  deleteConversationMessagesForCandidate,
  markConversationMessagesResponded,
  mergeConversationMessagePayload,
  persistInboundConversationMessage,
  persistOutboundConversationMessage,
  updateConversationMessagePayload
} from '../src/services/conversationMessageRepository.js';

function createPrismaMock({
  inboundCount = 1,
  updateManyCount = 2,
  deleteManyCount = 3,
  existingRawPayload = { source: 'inbound' },
  messageExists = true
} = {}) {
  const calls = {
    createMany: [],
    create: [],
    findUnique: [],
    update: [],
    updateMany: [],
    deleteMany: []
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
      },
      findUnique: async (args) => {
        calls.findUnique.push(args);
        return messageExists ? { rawPayload: existingRawPayload } : null;
      },
      update: async (args) => {
        calls.update.push(args);
        return { id: args.where.id, ...args.data };
      },
      updateMany: async (args) => {
        calls.updateMany.push(args);
        return { count: updateManyCount };
      },
      deleteMany: async (args) => {
        calls.deleteMany.push(args);
        return { count: deleteManyCount };
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

test('actualiza únicamente el payload del mensaje identificado', async () => {
  const { prisma, calls } = createPrismaMock();
  const rawPayload = {
    source: 'admin_manual_review_request',
    resolved: true,
    resolvedAt: '2026-07-14T20:00:00.000Z'
  };

  const result = await updateConversationMessagePayload(prisma, {
    messageId: 'message-pending-1',
    rawPayload
  });

  assert.equal(result.updated, true);
  assert.equal(result.message.id, 'message-pending-1');
  assert.deepEqual(calls.update, [{
    where: { id: 'message-pending-1' },
    data: { rawPayload }
  }]);
});

test('fusiona una traza en rawPayload sin borrar metadatos previos', async () => {
  const { prisma, calls } = createPrismaMock({
    existingRawPayload: { source: 'inbound', existing: true }
  });
  const debugTrace = { currentStep_before: 'MENU', currentStep_after: 'COLLECTING_DATA' };

  const result = await mergeConversationMessagePayload(prisma, {
    messageId: 'message-inbound-1',
    patch: { debugTrace }
  });

  assert.deepEqual(calls.findUnique, [{
    where: { id: 'message-inbound-1' },
    select: { rawPayload: true }
  }]);
  assert.deepEqual(calls.update, [{
    where: { id: 'message-inbound-1' },
    data: {
      rawPayload: {
        source: 'inbound',
        existing: true,
        debugTrace
      }
    }
  }]);
  assert.equal(result.updated, true);
  assert.deepEqual(result.rawPayload.debugTrace, debugTrace);
});

test('rechaza la fusión si el mensaje no existe sin intentar una actualización', async () => {
  const { prisma, calls } = createPrismaMock({ messageExists: false });

  await assert.rejects(
    () => mergeConversationMessagePayload(prisma, {
      messageId: 'message-missing-1',
      patch: { debugTrace: { currentStep_before: 'MENU' } }
    }),
    /message_not_found/
  );

  assert.equal(calls.findUnique.length, 1);
  assert.equal(calls.update.length, 0);
});

test('marca un lote deduplicado como respondido con fecha controlada', async () => {
  const { prisma, calls } = createPrismaMock({ updateManyCount: 2 });
  const respondedAt = new Date('2026-07-14T21:00:00.000Z');

  const result = await markConversationMessagesResponded(prisma, {
    messageIds: ['message-1', 'message-2', 'message-1'],
    respondedAt
  });

  assert.equal(result.updated, 2);
  assert.deepEqual(result.messageIds, ['message-1', 'message-2']);
  assert.notEqual(result.respondedAt, respondedAt);
  assert.equal(result.respondedAt.toISOString(), respondedAt.toISOString());
  assert.deepEqual(calls.updateMany, [{
    where: { id: { in: ['message-1', 'message-2'] } },
    data: { respondedAt: result.respondedAt }
  }]);
});

test('elimina únicamente los mensajes del candidato dentro del cliente recibido', async () => {
  const { prisma, calls } = createPrismaMock({ deleteManyCount: 4 });

  const result = await deleteConversationMessagesForCandidate(prisma, {
    candidateId: 'candidate-delete-1'
  });

  assert.equal(result.deleted, 4);
  assert.equal(result.candidateId, 'candidate-delete-1');
  assert.deepEqual(calls.deleteMany, [{
    where: { candidateId: 'candidate-delete-1' }
  }]);
});

test('rechaza contratos, identificadores, tipos, fechas y payloads inválidos antes de persistir', async () => {
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
  await assert.rejects(
    () => updateConversationMessagePayload({ message: { update: true } }, {
      messageId: 'message-test-1',
      rawPayload: {}
    }),
    /message_payload_update_prisma_contract_invalid/
  );
  await assert.rejects(
    () => mergeConversationMessagePayload({ message: { update: async () => {} } }, {
      messageId: 'message-test-1',
      patch: {}
    }),
    /message_payload_merge_prisma_contract_invalid/
  );
  await assert.rejects(
    () => markConversationMessagesResponded({ message: { updateMany: true } }, {
      messageIds: ['message-test-1']
    }),
    /message_responded_prisma_contract_invalid/
  );
  await assert.rejects(
    () => deleteConversationMessagesForCandidate({ message: { deleteMany: true } }, {
      candidateId: 'candidate-test-1'
    }),
    /candidate_message_delete_prisma_contract_invalid/
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
  await assert.rejects(
    () => persistOutboundConversationMessage(prisma, {
      candidateId: 'candidate-test-1',
      messageType: MessageType.TEXT,
      respondedAt: true
    }),
    /responded_at_invalid/
  );
  await assert.rejects(
    () => updateConversationMessagePayload(prisma, {
      messageId: '  ',
      rawPayload: {}
    }),
    /message_id_required/
  );
  await assert.rejects(
    () => updateConversationMessagePayload(prisma, {
      messageId: 'message-test-1'
    }),
    /raw_payload_required/
  );
  await assert.rejects(
    () => updateConversationMessagePayload(prisma, {
      messageId: 'message-test-1',
      rawPayload: undefined
    }),
    /raw_payload_required/
  );
  await assert.rejects(
    () => mergeConversationMessagePayload(prisma, {
      messageId: 'message-test-1',
      patch: []
    }),
    /payload_patch_required/
  );
  await assert.rejects(
    () => markConversationMessagesResponded(prisma, {
      messageIds: []
    }),
    /message_ids_required/
  );
  await assert.rejects(
    () => markConversationMessagesResponded(prisma, {
      messageIds: ['message-test-1'],
      respondedAt: 'fecha-inválida'
    }),
    /responded_at_invalid/
  );
  await assert.rejects(
    () => markConversationMessagesResponded(prisma, {
      messageIds: ['message-test-1'],
      respondedAt: null
    }),
    /responded_at_invalid/
  );
  await assert.rejects(
    () => markConversationMessagesResponded(prisma, {
      messageIds: ['message-test-1'],
      respondedAt: false
    }),
    /responded_at_invalid/
  );
  await assert.rejects(
    () => deleteConversationMessagesForCandidate(prisma, null),
    /candidate_message_delete_input_invalid/
  );
  await assert.rejects(
    () => deleteConversationMessagesForCandidate(prisma, 'candidate-test-1'),
    /candidate_message_delete_input_invalid/
  );
  await assert.rejects(
    () => deleteConversationMessagesForCandidate(prisma, {
      candidateId: '   '
    }),
    /candidate_id_required/
  );
  assert.equal(calls.createMany.length, 0);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.update.length, 0);
  assert.equal(calls.updateMany.length, 0);
  assert.equal(calls.deleteMany.length, 0);
});
