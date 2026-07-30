import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessWorkerBiometric,
  enrollWorkerBiometric,
  getWorkerBiometricEnrollment,
  humanFaceSimilarity,
  issueWorkerBiometricChallenge,
  loadWorkerBiometricStatusMap,
  revokeWorkerBiometric
} from '../src/services/workerBiometricService.js';

const ENV = { ATTENDANCE_BIOMETRIC_SECRET: 'b'.repeat(64) };
const NOW = new Date('2026-07-28T03:00:00.000Z');
const descriptor = Array.from({ length: 128 }, (_, index) => Math.sin(index + 1) / 12);

function unitVector(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / norm);
}

function rotatedDescriptor(vector, angle) {
  const base = unitVector(vector);
  const seed = Array.from({ length: base.length }, (_, index) => Math.cos((index + 1) * 1.7));
  const projection = seed.reduce((sum, value, index) => sum + value * base[index], 0);
  const orthogonal = unitVector(seed.map((value, index) => value - projection * base[index]));
  return base.map((value, index) => value * Math.cos(angle) + orthogonal[index] * Math.sin(angle));
}

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
        const found = events.filter((event) => matchesWhere(event, where)).sort((a, b) => b.createdAt - a.createdAt);
        if (!select) return found.map((event) => structuredClone(event));
        return found.map((event) => Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, structuredClone(event[key])])));
      },
      async findFirst({ where = {} } = {}) {
        const found = events.filter((event) => matchesWhere(event, where)).sort((a, b) => b.createdAt - a.createdAt)[0];
        return found ? structuredClone(found) : null;
      },
      async create({ data }) {
        const event = { id: `event-${++sequence}`, ...structuredClone(data) };
        events.push(event);
        return structuredClone(event);
      },
      async update({ where, data }) {
        const event = events.find((item) => item.id === where.id);
        assert.ok(event, `event ${where.id} must exist`);
        Object.assign(event, structuredClone(data));
        return structuredClone(event);
      }
    }
  };
}

async function enroll(prisma, vector = descriptor, now = NOW) {
  return enrollWorkerBiometric(prisma, {
    workerId: 'worker-1',
    workerLabel: 'Auxiliar Prueba',
    descriptor: vector,
    realScore: 0.91,
    liveScore: 0.89,
    consentAccepted: true,
    actorUsername: 'coordinador',
    actorRole: 'admin'
  }, { now, env: ENV });
}

async function assess(prisma, vector, {
  idempotencyKey,
  markType = 'ARRIVAL',
  randomIndex = 0,
  elapsedMs = 10_000
}) {
  const challenge = issueWorkerBiometricChallenge({
    workerId: 'worker-1', assignmentId: 'assignment-1', idempotencyKey, markType
  }, { now: NOW, env: ENV, randomIndex });
  return assessWorkerBiometric(prisma, {
    workerId: 'worker-1',
    assignmentId: 'assignment-1',
    idempotencyKey,
    markType,
    challengeToken: challenge.token,
    challengeAction: challenge.action,
    challengeCompleted: true,
    descriptor: vector,
    realScore: 0.93,
    liveScore: 0.9
  }, { now: new Date(NOW.getTime() + elapsedMs), env: ENV });
}

test('cifra la plantilla y permite recuperarla únicamente con el secreto', async () => {
  const prisma = fakePrisma();
  await enroll(prisma);
  const stored = prisma.events.find((event) => event.action === 'BIOMETRIC_ENROLLED');
  assert.equal(stored.metadata.template.algorithm, 'aes-256-gcm');
  assert.equal(JSON.stringify(stored.metadata).includes(JSON.stringify(descriptor)), false);
  const enrollment = await getWorkerBiometricEnrollment(prisma, 'worker-1', { env: ENV });
  assert.equal(enrollment.enrolled, true);
  assert.deepEqual(enrollment.descriptor, descriptor.map((value) => Math.round(value * 1_000_000) / 1_000_000));
});

test('la misma identidad con desafío válido queda verificada', async () => {
  const prisma = fakePrisma();
  await enroll(prisma);
  const assessment = await assess(prisma, descriptor, { idempotencyKey: 'mark-key-12345678' });
  assert.equal(assessment.decision, 'VERIFIED');
  assert.equal(assessment.verified, true);
  assert.equal(assessment.similarity, 1);
  assert.equal(assessment.matchThreshold, 0.85);
  assert.deepEqual(assessment.riskFlags, []);
});

test('una variación legítima que fallaba con 0.90 queda verificada', async () => {
  const prisma = fakePrisma();
  await enroll(prisma);
  const genuineVariation = rotatedDescriptor(descriptor, 0.5);
  const assessment = await assess(prisma, genuineVariation, { idempotencyKey: 'mark-key-genuine-1234' });
  assert.ok(assessment.similarity > 0.87 && assessment.similarity < 0.9);
  assert.equal(assessment.decision, 'VERIFIED');
  assert.equal(assessment.verified, true);
  assert.deepEqual(assessment.riskFlags, []);
});

test('un impostor cercano permanece rechazado con el umbral conservador', async () => {
  const prisma = fakePrisma();
  await enroll(prisma);
  const nearImpostor = rotatedDescriptor(descriptor, 0.65);
  const assessment = await assess(prisma, nearImpostor, {
    idempotencyKey: 'mark-key-impostor-1234',
    markType: 'DEPARTURE',
    randomIndex: 1,
    elapsedMs: 12_000
  });
  assert.ok(assessment.similarity > 0.75 && assessment.similarity < 0.85);
  assert.equal(assessment.decision, 'REVIEW_REQUIRED');
  assert.equal(assessment.verified, false);
  assert.ok(assessment.riskFlags.includes('BIOMETRIC_FACE_MISMATCH'));
});

test('un rostro claramente distinto queda rechazado', async () => {
  const prisma = fakePrisma();
  await enroll(prisma);
  const different = descriptor.map((value, index) => value + (index % 2 ? 1.8 : -1.8));
  const assessment = await assess(prisma, different, {
    idempotencyKey: 'mark-key-87654321',
    markType: 'DEPARTURE',
    randomIndex: 1,
    elapsedMs: 12_000
  });
  assert.equal(assessment.decision, 'REVIEW_REQUIRED');
  assert.equal(assessment.verified, false);
  assert.ok(assessment.riskFlags.includes('BIOMETRIC_FACE_MISMATCH'));
});

test('al actualizar o revocar se borra el material biométrico anterior', async () => {
  const prisma = fakePrisma();
  await enroll(prisma);
  await enroll(prisma, descriptor.map((value) => value * 0.99), new Date(NOW.getTime() + 60_000));
  const enrollments = prisma.events.filter((event) => event.action === 'BIOMETRIC_ENROLLED').sort((a, b) => a.createdAt - b.createdAt);
  assert.equal(enrollments[0].metadata.template, null);
  assert.ok(enrollments[0].metadata.redactedAt);
  assert.ok(enrollments[1].metadata.template?.ciphertext);
  await revokeWorkerBiometric(prisma, {
    workerId: 'worker-1', workerLabel: 'Auxiliar Prueba', actorUsername: 'coordinador', actorRole: 'admin'
  }, { now: new Date(NOW.getTime() + 120_000), env: ENV });
  assert.equal(enrollments[1].metadata.template, null);
  const status = await loadWorkerBiometricStatusMap(prisma, ['worker-1']);
  assert.equal(status.get('worker-1').enrolled, false);
});

test('la similitud normalizada separa variación legítima e impostor', () => {
  const genuineVariation = rotatedDescriptor(descriptor, 0.5);
  const nearImpostor = rotatedDescriptor(descriptor, 0.65);
  assert.equal(humanFaceSimilarity(descriptor, descriptor), 1);
  assert.ok(humanFaceSimilarity(descriptor, genuineVariation) > 0.87);
  assert.ok(humanFaceSimilarity(descriptor, genuineVariation) < 0.9);
  assert.ok(humanFaceSimilarity(descriptor, nearImpostor) > 0.75);
  assert.ok(humanFaceSimilarity(descriptor, nearImpostor) < 0.85);
  assert.ok(humanFaceSimilarity(descriptor, descriptor.map((value) => value + 4)) < 0.1);
});
