import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessWorkerBiometric,
  enrollWorkerBiometric,
  issueWorkerBiometricChallenge
} from '../src/services/workerBiometricService.js';

const ENV = { ATTENDANCE_BIOMETRIC_SECRET: 'c'.repeat(64) };
const NOW = new Date('2026-07-30T16:00:00.000Z');
const DESCRIPTOR = Array.from({ length: 128 }, (_, index) => Math.sin(index + 1) / 10);

function matchesWhere(event, where = {}) {
  if (where.entityType && event.entityType !== where.entityType) return false;
  if (where.entityId) {
    if (typeof where.entityId === 'string' && event.entityId !== where.entityId) return false;
    if (where.entityId.in && !where.entityId.in.includes(event.entityId)) return false;
    if (where.entityId.not && event.entityId === where.entityId.not) return false;
  }
  if (where.action) {
    if (typeof where.action === 'string' && event.action !== where.action) return false;
    if (where.action.in && !where.action.in.includes(event.action)) return false;
  }
  if (where.metadata?.path?.[0] === 'descriptorHash' && event.metadata?.descriptorHash !== where.metadata.equals) return false;
  return true;
}

function fakePrisma() {
  const events = [];
  let sequence = 0;
  return {
    events,
    devAuditEvent: {
      async findMany({ where = {}, select } = {}) {
        const found = events.filter((event) => matchesWhere(event, where)).sort((left, right) => right.createdAt - left.createdAt);
        if (!select) return found.map((event) => structuredClone(event));
        return found.map((event) => Object.fromEntries(
          Object.keys(select).filter((key) => select[key]).map((key) => [key, structuredClone(event[key])])
        ));
      },
      async findFirst({ where = {} } = {}) {
        const event = events.filter((candidate) => matchesWhere(candidate, where)).sort((left, right) => right.createdAt - left.createdAt)[0];
        return event ? structuredClone(event) : null;
      },
      async create({ data }) {
        const event = { id: `event-${++sequence}`, ...structuredClone(data) };
        events.push(event);
        return structuredClone(event);
      },
      async update({ where, data }) {
        const event = events.find((candidate) => candidate.id === where.id);
        assert.ok(event);
        Object.assign(event, structuredClone(data));
        return structuredClone(event);
      }
    }
  };
}

async function verifyBreakMark(markType) {
  const prisma = fakePrisma();
  await enrollWorkerBiometric(prisma, {
    workerId: 'worker-1',
    workerLabel: 'Auxiliar prueba',
    descriptor: DESCRIPTOR,
    realScore: 0.92,
    liveScore: 0.9,
    consentAccepted: true,
    actorUsername: 'worker-portal:worker-1',
    actorRole: 'worker'
  }, { now: NOW, env: ENV });

  const idempotencyKey = `${markType.toLowerCase()}-123456789`;
  const challenge = issueWorkerBiometricChallenge({
    workerId: 'worker-1',
    assignmentId: 'assignment-1',
    idempotencyKey,
    markType
  }, { now: NOW, env: ENV, randomIndex: 0 });

  const assessment = await assessWorkerBiometric(prisma, {
    workerId: 'worker-1',
    assignmentId: 'assignment-1',
    idempotencyKey,
    markType,
    challengeToken: challenge.token,
    challengeAction: challenge.action,
    challengeCompleted: true,
    descriptor: DESCRIPTOR,
    realScore: 0.93,
    liveScore: 0.91
  }, { now: new Date(NOW.getTime() + 5_000), env: ENV });

  assert.equal(assessment.decision, 'VERIFIED');
  assert.equal(assessment.verified, true);
  assert.equal(assessment.similarity, 1);
  assert.equal(assessment.matchThreshold, 0.85);
  const audit = prisma.events.find((event) => event.entityId === idempotencyKey && event.action === 'BIOMETRIC_ASSESSED');
  assert.equal(audit.metadata.markType, markType);
}

test('inicio de almuerzo puede completar desafío y evaluación facial', async () => {
  await verifyBreakMark('BREAK_START');
});

test('fin de almuerzo puede completar desafío y evaluación facial', async () => {
  await verifyBreakMark('BREAK_END');
});

test('un tipo de marcación desconocido continúa rechazado', () => {
  assert.throws(() => issueWorkerBiometricChallenge({
    workerId: 'worker-1',
    assignmentId: 'assignment-1',
    idempotencyKey: 'unknown-mark-123456',
    markType: 'UNKNOWN'
  }, { now: NOW, env: ENV }), /attendance_biometric_challenge_input_invalid/);
});
