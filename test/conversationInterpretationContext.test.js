import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageDirection } from '@prisma/client';
import { loadConversationInterpretationContext } from '../src/services/conversationMessageRepository.js';

function createPrismaMock(rows = []) {
  const calls = [];
  return {
    prisma: {
      message: {
        findMany: async (args) => {
          calls.push(args);
          return rows;
        }
      }
    },
    calls
  };
}

test('carga solo historial previo y conserva la última salida como pregunta activa', async () => {
  const { prisma, calls } = createPrismaMock([
    {
      direction: MessageDirection.OUTBOUND,
      body: '¿Tienes experiencia en logística?',
      rawPayload: { source: 'bot_flow' },
      respondedAt: null,
      createdAt: new Date('2026-08-12T15:01:00.000Z')
    },
    {
      direction: MessageDirection.INBOUND,
      body: 'Tengo 30 años.',
      rawPayload: { source: 'whatsapp' },
      respondedAt: new Date('2026-08-12T15:00:30.000Z'),
      createdAt: new Date('2026-08-12T15:00:00.000Z')
    }
  ]);

  const context = await loadConversationInterpretationContext(prisma, {
    candidateId: 'candidate-context-1',
    limit: 12
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].where, {
    candidateId: 'candidate-context-1',
    OR: [
      { direction: MessageDirection.OUTBOUND },
      {
        direction: MessageDirection.INBOUND,
        respondedAt: { not: null }
      }
    ]
  });
  assert.equal(calls[0].orderBy.createdAt, 'desc');
  assert.equal(calls[0].take, 12);
  assert.deepEqual(calls[0].select, {
    direction: true,
    body: true,
    createdAt: true
  });

  assert.equal(context.lastBotQuestion, '¿Tienes experiencia en logística?');
  assert.deepEqual(context.recentConversation, [
    { direction: MessageDirection.INBOUND, body: 'Tengo 30 años.' },
    { direction: MessageDirection.OUTBOUND, body: '¿Tienes experiencia en logística?' }
  ]);
});

test('no inventa pregunta activa cuando el historial previo no contiene salida textual', async () => {
  const { prisma } = createPrismaMock([
    {
      direction: MessageDirection.INBOUND,
      body: 'Dato anterior',
      respondedAt: new Date('2026-08-12T15:00:30.000Z'),
      createdAt: new Date('2026-08-12T15:00:00.000Z')
    }
  ]);

  const context = await loadConversationInterpretationContext(prisma, {
    candidateId: 'candidate-context-2'
  });

  assert.equal(context.lastBotQuestion, null);
  assert.deepEqual(context.recentConversation, [
    { direction: MessageDirection.INBOUND, body: 'Dato anterior' }
  ]);
});

test('rechaza contexto sin candidato antes de consultar persistencia', async () => {
  const { prisma, calls } = createPrismaMock([]);

  await assert.rejects(
    () => loadConversationInterpretationContext(prisma, { candidateId: '   ' }),
    /candidate_id_required/
  );

  assert.equal(calls.length, 0);
});
