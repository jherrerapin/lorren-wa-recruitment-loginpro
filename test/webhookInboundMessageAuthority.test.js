import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageDirection, MessageType } from '@prisma/client';
import { saveInboundMessage } from '../src/routes/webhook.js';

function createPrismaMock({ duplicate = false } = {}) {
  const calls = {
    createMany: [],
    findUnique: [],
    candidateUpdate: []
  };
  const prisma = {
    message: {
      async createMany(args) {
        calls.createMany.push(args);
        return { count: duplicate ? 0 : 1 };
      },
      async findUnique(args) {
        calls.findUnique.push(args);
        return { id: 'message-inbound-1' };
      }
    },
    candidate: {
      async update(args) {
        calls.candidateUpdate.push(args);
        return { id: args.where.id, ...args.data };
      }
    }
  };
  return { prisma, calls };
}

test('inbox persiste solo campos Prisma válidos y conserva trazabilidad e identidad', async () => {
  const { prisma, calls } = createPrismaMock();
  const rawMessage = {
    id: 'wamid.inbound-1',
    from: '573001112233',
    type: 'text',
    text: { body: 'Hola' }
  };

  const result = await saveInboundMessage(
    prisma,
    'candidate-inbound-1',
    rawMessage,
    'Hola',
    MessageType.TEXT,
    '573001112233'
  );

  assert.deepEqual(result, { isNew: true, id: 'message-inbound-1' });
  assert.equal(calls.createMany.length, 1);
  assert.equal(calls.createMany[0].skipDuplicates, true);
  const persisted = calls.createMany[0].data[0];
  assert.equal(persisted.candidateId, 'candidate-inbound-1');
  assert.equal(persisted.waMessageId, 'wamid.inbound-1');
  assert.equal(persisted.direction, MessageDirection.INBOUND);
  assert.equal(persisted.messageType, MessageType.TEXT);
  assert.equal(persisted.body, 'Hola');
  assert.deepEqual(persisted.rawPayload, {
    id: 'wamid.inbound-1',
    from: '573001112233',
    timestamp: undefined,
    type: 'text',
    text: { body: 'Hola' },
    document: undefined
  });
  assert.equal(Object.hasOwn(persisted, 'phone'), false);
  assert.equal(calls.candidateUpdate.length, 1);
  assert.equal(calls.candidateUpdate[0].where.id, 'candidate-inbound-1');
  assert.ok(calls.candidateUpdate[0].data.lastInboundAt instanceof Date);
  assert.deepEqual(calls.findUnique, [{
    where: { waMessageId: 'wamid.inbound-1' },
    select: { id: true }
  }]);
});

test('inbox duplicado no actualiza candidato ni consulta identidad creada', async () => {
  const { prisma, calls } = createPrismaMock({ duplicate: true });
  const originalLog = console.log;
  console.log = () => {};

  try {
    const result = await saveInboundMessage(
      prisma,
      'candidate-inbound-2',
      { id: 'wamid.duplicate-1', from: '573001112233', type: 'text' },
      'Hola repetido',
      MessageType.TEXT,
      '573001112233'
    );

    assert.deepEqual(result, { isNew: false, id: null });
  } finally {
    console.log = originalLog;
  }

  assert.equal(calls.createMany.length, 1);
  assert.equal(calls.candidateUpdate.length, 0);
  assert.equal(calls.findUnique.length, 0);
});
