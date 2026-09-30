import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueInboundMessage, enqueueJob, completeJob, failJob, JOB_TYPES } from '../src/services/jobQueue.js';

function harness({ existingJob = null, createError = null } = {}) {
  const calls = [];
  const jobQueueItem = {
    async create(args) {
      calls.push(['create', args]);
      if (createError) throw createError;
      return { id: 'job-1', ...args.data };
    },
    async update(args) { calls.push(['update', args]); return { id: args.where.id, ...args.data }; },
    async findUnique(args) { calls.push(['findUnique', args]); return existingJob; }
  };
  return { prisma: { jobQueueItem }, calls };
}

test('encola un mensaje entrante en JobQueueItem con deduplicación durable', async () => {
  const h = harness();
  const payload = { messageId: 'wamid.1', from: '573001112233', text: 'Hola' };
  await enqueueInboundMessage(payload, { prisma: h.prisma });
  assert.deepEqual(h.calls, [['create', { data: {
    type: JOB_TYPES.WHATSAPP_INBOUND_MESSAGE,
    payload,
    dedupeKey: 'whatsapp:wamid.1'
  } }]]);
});

test('enqueueJob usa los nombres de JobQueueItem', async () => {
  const h = harness();
  const scheduledAt = new Date('2026-09-23T20:00:00.000Z');
  await enqueueJob(h.prisma, {
    type: 'test', payload: { ok: true }, runAt: scheduledAt, dedupeKey: 'test:1', maxAttempts: 3
  });
  assert.deepEqual(h.calls[0][1].data, {
    type: 'test', payload: { ok: true }, scheduledAt, dedupeKey: 'test:1', maxAttempts: 3
  });
});

test('completeJob y failJob actualizan JobQueueItem', async () => {
  const h = harness({ existingJob: { id: 'job-1', attempts: 0, maxAttempts: 2, startedAt: new Date() } });
  await completeJob(h.prisma, 'job-1');
  await failJob(h.prisma, 'job-1', 'temporary');
  assert.equal(h.calls[0][0], 'update');
  assert.equal(h.calls[0][1].data.status, 'DONE');
  assert.equal(h.calls[1][0], 'findUnique');
  assert.equal(h.calls[2][1].data.status, 'PENDING');
  assert.equal(h.calls[2][1].data.attempts, 1);
});

test('rechaza mensajes entrantes sin messageId', async () => {
  const h = harness();
  await assert.rejects(enqueueInboundMessage({ text: 'Hola' }, { prisma: h.prisma }), /payload\.messageId/);
  assert.deepEqual(h.calls, []);
});

test('considera segura una reentrega que ya existe en la cola', async () => {
  const duplicate = new Error('unique constraint');
  duplicate.code = 'P2002';
  const h = harness({ createError: duplicate });

  const result = await enqueueInboundMessage({ messageId: 'wamid.duplicate' }, { prisma: h.prisma });

  assert.deepEqual(result, { duplicate: true });
  assert.equal(h.calls.length, 1);
});

test('propaga errores reales de PostgreSQL para impedir el HTTP 200', async () => {
  const h = harness({ createError: new Error('database unavailable') });

  await assert.rejects(
    enqueueInboundMessage({ messageId: 'wamid.failure' }, { prisma: h.prisma }),
    /database unavailable/
  );
});
