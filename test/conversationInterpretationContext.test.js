import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
      rawPayload: { source: 'bot_flow', actor: 'BOT' },
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
    rawPayload: true,
    createdAt: true
  });

  assert.equal(context.lastBotQuestion, '¿Tienes experiencia en logística?');
  assert.deepEqual(context.recentConversation, [
    { direction: MessageDirection.INBOUND, body: 'Tengo 30 años.' },
    { direction: MessageDirection.OUTBOUND, body: '¿Tienes experiencia en logística?' }
  ]);
});

test('una salida manual no reemplaza la última pregunta automática', async () => {
  const { prisma } = createPrismaMock([
    {
      direction: MessageDirection.OUTBOUND,
      body: 'El equipo revisará tu caso y te escribe por este medio.',
      rawPayload: {
        source: 'admin_outbound',
        sourceCategory: 'MANUAL_AUTHORIZED',
        actor: 'RECRUITER',
        manualIntervention: true
      },
      createdAt: new Date('2026-08-12T15:02:00.000Z')
    },
    {
      direction: MessageDirection.OUTBOUND,
      body: '¿Tienes experiencia en logística?',
      rawPayload: { source: 'bot_flow', actor: 'BOT' },
      createdAt: new Date('2026-08-12T15:01:00.000Z')
    }
  ]);

  const context = await loadConversationInterpretationContext(prisma, {
    candidateId: 'candidate-context-manual'
  });

  assert.equal(context.lastBotQuestion, '¿Tienes experiencia en logística?');
  assert.deepEqual(context.recentConversation, [
    { direction: MessageDirection.OUTBOUND, body: '¿Tienes experiencia en logística?' },
    { direction: MessageDirection.OUTBOUND, body: 'El equipo revisará tu caso y te escribe por este medio.' }
  ]);
});

test('no inventa pregunta activa cuando el historial previo no contiene salida textual', async () => {
  const { prisma } = createPrismaMock([
    {
      direction: MessageDirection.INBOUND,
      body: 'Dato anterior',
      rawPayload: { source: 'whatsapp' },
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

test('el runtime comparte el mismo contexto previo entre extractor y sanitizador', async () => {
  const source = await readFile(new URL('../src/routes/webhook.js', import.meta.url), 'utf8');

  assert.match(source, /loadConversationInterpretationContext/);
  assert.match(
    source,
    /const conversationContext\s*=\s*await loadConversationInterpretationContext\(prisma,\s*\{\s*candidateId:\s*candidate\.id\s*\}\);/
  );
  assert.match(
    source,
    /const sanitizerContext\s*=\s*\{[\s\S]*?currentStep:\s*candidate\.currentStep,[\s\S]*?pendingFields:\s*getMissingFieldLabels\(candidate,\s*currentVacancy\),[\s\S]*?\.\.\.conversationContext[\s\S]*?\};/
  );
  assert.match(source, /tryOpenAIParse\(cleanText,\s*sanitizerContext\)/);
});
