import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runReminderSweep } from '../src/workers/cronReminders.js';

function candidate(overrides = {}) {
  return {
    id: 'candidate-1',
    phone: '573001112233',
    dataConsentStatus: 'ACCEPTED',
    vacancyId: 'vacancy-1',
    vacancy: { id: 'vacancy-1', city: 'Ibague', experienceRequired: 'NO' },
    botPaused: false,
    inactivityReminderSent: false,
    updatedAt: new Date('2026-09-24T09:00:00.000Z'),
    ...overrides
  };
}

function harness({ claimInactivity = 1, claimInterview = 1 } = {}) {
  const calls = [];
  const tx = {
    candidate: {
      async updateMany(args) {
        calls.push(['markInactivity', args]);
        return { count: claimInactivity };
      }
    },
    interviewBooking: {
      async updateMany(args) {
        calls.push(['markInterview', args]);
        return { count: claimInterview };
      }
    }
  };
  const activePrisma = {
    candidate: {
      async findMany(args) {
        calls.push(['findCandidates', args]);
        return [candidate()];
      }
    },
    interviewBooking: {
      async findMany(args) {
        calls.push(['findBookings', args]);
        return [{
          id: 'booking-1',
          status: 'SCHEDULED',
          scheduledAt: new Date('2026-09-24T13:00:00.000Z'),
          candidate: { phone: '573009998877' }
        }];
      }
    },
    async $transaction(callback) {
      calls.push(['transaction']);
      return callback(tx);
    }
  };
  const enqueueInboundMessage = async (payload, dependencies) => {
    calls.push(['enqueue', payload, dependencies]);
  };
  return { calls, tx, activePrisma, enqueueInboundMessage };
}

test('marca y encola ambos recordatorios dentro de la misma transacción', async () => {
  const h = harness();
  const now = new Date('2026-09-24T12:00:00.000Z');
  const result = await runReminderSweep({
    prisma: h.activePrisma,
    enqueueInboundMessage: h.enqueueInboundMessage
  }, { now });

  assert.deepEqual(result, { inactivityEnqueued: 1, interviewEnqueued: 1 });
  const enqueues = h.calls.filter(([name]) => name === 'enqueue');
  assert.equal(enqueues.length, 2);
  assert.equal(enqueues[0][1].intent, 'INACTIVITY_REMINDER');
  assert.equal(enqueues[0][1].isSystemAction, true);
  assert.match(enqueues[0][1].messageId, /^system:inactivity:candidate-1:/);
  assert.equal(enqueues[0][2].prisma, h.tx);
  assert.equal(enqueues[1][1].intent, 'INTERVIEW_REMINDER');
  assert.equal(enqueues[1][1].messageId, 'system:interview:booking-1');
  assert.equal(enqueues[1][2].prisma, h.tx);

  const candidateQuery = h.calls.find(([name]) => name === 'findCandidates')[1];
  assert.equal(candidateQuery.where.inactivityReminderSent, false);
  assert.equal(candidateQuery.where.botPaused, false);
  assert.equal(candidateQuery.where.updatedAt.lt.toISOString(), '2026-09-24T10:00:00.000Z');

  const bookingQuery = h.calls.find(([name]) => name === 'findBookings')[1];
  assert.equal(bookingQuery.where.interviewReminderSent, false);
  assert.equal(bookingQuery.where.scheduledAt.gte.toISOString(), '2026-09-24T12:57:30.000Z');
  assert.equal(bookingQuery.where.scheduledAt.lt.toISOString(), '2026-09-24T13:02:30.000Z');
});

test('una bandera reclamada por otro proceso impide volver a encolar', async () => {
  const h = harness({ claimInactivity: 0, claimInterview: 0 });
  const result = await runReminderSweep({
    prisma: h.activePrisma,
    enqueueInboundMessage: h.enqueueInboundMessage
  }, { now: new Date('2026-09-24T12:00:00.000Z') });

  assert.deepEqual(result, { inactivityEnqueued: 0, interviewEnqueued: 0 });
  assert.equal(h.calls.some(([name]) => name === 'enqueue'), false);
});

test('Prisma y la migración declaran las banderas durables', async () => {
  const schema = await readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  const migration = await readFile(new URL(
    '../prisma/migrations/20260924170000_add_durable_reminder_flags/migration.sql',
    import.meta.url
  ), 'utf8');

  assert.match(schema, /inactivityReminderSent\s+Boolean\s+@default\(false\)/);
  assert.match(schema, /interviewReminderSent\s+Boolean\s+@default\(false\)/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "inactivityReminderSent"/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "interviewReminderSent"/);
});
