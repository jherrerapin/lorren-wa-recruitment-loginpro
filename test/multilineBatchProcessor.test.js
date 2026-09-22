import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { processDueMultilineCandidates } from '../src/services/multilineBatchProcessor.js';

function createHarness({ paused = false } = {}) {
  const now = new Date('2026-09-22T12:00:30.000Z');
  let candidate = {
    id: 'candidate-1',
    phone: '3000000000',
    currentStep: 'COLLECTING_DATA',
    botPaused: paused,
    botResumeMode: paused ? 'manual_pause_until_admin_resume' : null,
    multilineWindowUntil: new Date('2026-09-22T12:00:20.000Z'),
    multilineBatchVersion: 7
  };
  const messages = [
    {
      id: 'message-1',
      waMessageId: 'wamid-1',
      body: 'Juan Pérez',
      createdAt: new Date('2026-09-22T12:00:00.000Z'),
      respondedAt: null
    },
    {
      id: 'message-2',
      waMessageId: 'wamid-2',
      body: 'CC 123456789',
      createdAt: new Date('2026-09-22T12:00:05.000Z'),
      respondedAt: null
    }
  ];
  const calls = { processor: [], responded: [] };

  const prisma = {
    candidate: {
      findMany: async () => [{
        id: candidate.id,
        phone: candidate.phone,
        multilineBatchVersion: candidate.multilineBatchVersion,
        multilineWindowUntil: candidate.multilineWindowUntil
      }],
      updateMany: async ({ where, data }) => {
        if (
          candidate.id !== where.id
          || candidate.multilineBatchVersion !== where.multilineBatchVersion
          || candidate.multilineWindowUntil.getTime() > new Date(where.multilineWindowUntil.lte).getTime()
        ) {
          return { count: 0 };
        }
        candidate = {
          ...candidate,
          multilineWindowUntil: data.multilineWindowUntil,
          multilineBatchVersion: candidate.multilineBatchVersion + Number(data.multilineBatchVersion.increment || 0)
        };
        return { count: 1 };
      },
      findUnique: async () => ({ ...candidate })
    },
    message: {
      findMany: async () => messages.filter((message) => message.respondedAt === null),
      updateMany: async ({ where, data }) => {
        const ids = new Set(where.id.in);
        for (const message of messages) {
          if (ids.has(message.id) && message.respondedAt === null) {
            message.respondedAt = data.respondedAt;
            calls.responded.push(message.id);
          }
        }
        return { count: calls.responded.length };
      }
    }
  };

  const processCandidateText = async (...args) => {
    calls.processor.push(args);
  };

  return { prisma, now, calls, messages, processCandidateText };
}

test('el servicio multilinea no depende de la ruta HTTP y exige procesador explícito', async () => {
  const source = await readFile(new URL('../src/services/multilineBatchProcessor.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /routes\/webhook|\bprocessText\b/);

  const { prisma, now } = createHarness();
  await assert.rejects(
    () => processDueMultilineCandidates(prisma, { now }),
    /multiline_batch_text_processor_required/
  );
});

test('el worker reclama una sola versión vencida y procesa el turno consolidado', async () => {
  const { prisma, now, calls, messages, processCandidateText } = createHarness();

  const stats = await processDueMultilineCandidates(prisma, {
    now,
    processCandidateText
  });

  assert.deepEqual(stats, {
    due: 1,
    claimed: 1,
    processed: 1,
    blocked: 0,
    empty: 0,
    errors: 0
  });
  assert.equal(calls.processor.length, 1);
  assert.equal(calls.processor[0][3], 'Juan Pérez\nCC 123456789');
  assert.equal(calls.processor[0][5].inboundMessageId, 'wamid-2');
  assert.equal(calls.processor[0][5].batchedMessageCount, 2);
  assert.equal(calls.processor[0][5].usedMultilineContext, true);
  assert.deepEqual(calls.responded, ['message-1', 'message-2']);
  assert.ok(messages.every((message) => message.respondedAt instanceof Date));
});

test('una intervención humana impide que el worker responda el lote ya vencido', async () => {
  const { prisma, now, calls, processCandidateText } = createHarness({ paused: true });

  const stats = await processDueMultilineCandidates(prisma, {
    now,
    processCandidateText
  });

  assert.equal(stats.claimed, 1);
  assert.equal(stats.processed, 0);
  assert.equal(stats.blocked, 1);
  assert.equal(calls.processor.length, 0);
  assert.deepEqual(calls.responded, []);
});
