import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKER_BIOMETRIC_EVIDENCE_VERSION,
  WORKER_BIOMETRIC_MODEL_VERSION,
  assessWorkerBiometric,
  enrollWorkerBiometric,
  getWorkerBiometricEnrollment,
  humanFaceSimilarity,
  issueWorkerBiometricChallenge,
  revokeWorkerBiometric
} from '../src/services/workerBiometricService.js';

const ENV = { ATTENDANCE_BIOMETRIC_SECRET: 'r'.repeat(64) };
const START = new Date('2026-08-12T15:00:00.000Z');
const WORKER_ID = 'TEST-worker-reference-bank';
const ASSIGNMENT_ID = 'TEST-assignment-reference-bank';

function unitDescriptor(firstCoordinate) {
  const bounded = Math.max(-1, Math.min(1, Number(firstCoordinate)));
  return [bounded, Math.sqrt(1 - bounded ** 2), ...Array(126).fill(0)];
}

function matchesWhere(event, where = {}) {
  if (where.entityType && event.entityType !== where.entityType) return false;
  if (where.entityLabel && event.entityLabel !== where.entityLabel) return false;
  if (where.createdAt?.gte && new Date(event.createdAt).getTime() < new Date(where.createdAt.gte).getTime()) return false;
  if (where.entityId) {
    if (typeof where.entityId === 'string' && event.entityId !== where.entityId) return false;
    if (where.entityId.in && !where.entityId.in.includes(event.entityId)) return false;
    if (where.entityId.not && event.entityId === where.entityId.not) return false;
  }
  if (where.action) {
    if (typeof where.action === 'string' && event.action !== where.action) return false;
    if (where.action.in && !where.action.in.includes(event.action)) return false;
  }
  if (where.metadata?.path?.[0]) {
    const key = where.metadata.path[0];
    if (event.metadata?.[key] !== where.metadata.equals) return false;
  }
  return true;
}

function fakePrisma() {
  const events = [];
  let sequence = 0;
  return {
    events,
    devAuditEvent: {
      async findMany({ where = {}, select, take } = {}) {
        let found = events
          .filter((event) => matchesWhere(event, where))
          .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
        if (take) found = found.slice(0, take);
        if (!select) return found.map((event) => structuredClone(event));
        return found.map((event) => Object.fromEntries(
          Object.keys(select).filter((key) => select[key]).map((key) => [key, structuredClone(event[key])])
        ));
      },
      async findFirst({ where = {} } = {}) {
        const found = events
          .filter((event) => matchesWhere(event, where))
          .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))[0];
        return found ? structuredClone(found) : null;
      },
      async create({ data }) {
        const event = { id: `event-${++sequence}`, ...structuredClone(data) };
        events.push(event);
        return structuredClone(event);
      },
      async update({ where, data }) {
        const event = events.find((candidate) => candidate.id === where.id);
        assert.ok(event, `event ${where.id} must exist`);
        Object.assign(event, structuredClone(data));
        return structuredClone(event);
      }
    }
  };
}

async function enroll(prisma, sampleDescriptors) {
  return enrollWorkerBiometric(prisma, {
    workerId: WORKER_ID,
    workerLabel: 'Auxiliar TEST',
    actorUsername: 'worker-portal:test',
    actorRole: 'worker',
    consentAccepted: true,
    evidenceVersion: WORKER_BIOMETRIC_EVIDENCE_VERSION,
    modelVersion: WORKER_BIOMETRIC_MODEL_VERSION,
    sampleDescriptors,
    sampleRealScores: [0.9, 0.91, 0.92],
    sampleLiveScores: [0.9, 0.91, 0.92],
    captureDurationMs: 1_500
  }, { now: START, env: ENV });
}

async function assessArrival(prisma, descriptor, idempotencyKey, now) {
  const challenge = issueWorkerBiometricChallenge({
    workerId: WORKER_ID,
    assignmentId: ASSIGNMENT_ID,
    idempotencyKey,
    markType: 'ARRIVAL'
  }, { now: new Date(now.getTime() - 1_000), env: ENV, randomIndex: 0 });
  return assessWorkerBiometric(prisma, {
    workerId: WORKER_ID,
    assignmentId: ASSIGNMENT_ID,
    idempotencyKey,
    markType: 'ARRIVAL',
    evidenceVersion: WORKER_BIOMETRIC_EVIDENCE_VERSION,
    modelVersion: WORKER_BIOMETRIC_MODEL_VERSION,
    challengeToken: challenge.token,
    challengeAction: challenge.action,
    challengeCompleted: true,
    challengeEvidence: {
      kind: 'MODEL_PASSIVE_LIVENESS_V2',
      action: challenge.action,
      frames: 2,
      captureDurationMs: 1_000
    },
    sampleDescriptors: [descriptor, descriptor],
    sampleRealScores: [0.9, 0.91],
    sampleLiveScores: [0.9, 0.91],
    realScore: 0.9,
    liveScore: 0.9
  }, { now, env: ENV });
}

test('las referencias cifradas rescatan una coincidencia legítima que el centroide pierde', async () => {
  const prisma = fakePrisma();
  const enrollmentSamples = [unitDescriptor(0.45), unitDescriptor(0.63), unitDescriptor(0.615)];
  assert.ok(humanFaceSimilarity(enrollmentSamples[0], enrollmentSamples[1]) > 0.95);
  assert.ok(humanFaceSimilarity(enrollmentSamples[0], enrollmentSamples[2]) > 0.95);
  await enroll(prisma, enrollmentSamples);

  const enrollmentEvent = prisma.events.find((event) => event.action === 'BIOMETRIC_ENROLLED');
  assert.equal(enrollmentEvent.metadata.enrollmentReferences.length, 3);
  assert.ok(enrollmentEvent.metadata.enrollmentReferences.every((entry) => entry.algorithm === 'aes-256-gcm'));
  assert.equal(
    JSON.stringify(enrollmentEvent.metadata.enrollmentReferences).includes(JSON.stringify(enrollmentSamples[1])),
    false,
    'las referencias individuales no deben persistirse en claro'
  );

  const restored = await getWorkerBiometricEnrollment(prisma, WORKER_ID, {
    env: ENV,
    now: new Date(START.getTime() + 30_000)
  });
  assert.equal(restored.enrollmentReferences.length, 3);
  assert.ok(humanFaceSimilarity(restored.enrollmentReferences[1], enrollmentSamples[1]) > 0.999);

  const verificationDescriptor = unitDescriptor(1);
  const assessment = await assessArrival(
    prisma,
    verificationDescriptor,
    'TEST-reference-bank-arrival-0001',
    new Date(START.getTime() + 60_000)
  );

  assert.ok(assessment.baseSimilarity < 0.60, 'el centroide legado debe quedar por debajo de la frontera operativa');
  assert.ok(assessment.enrollmentReferenceSimilarity >= 0.60);
  assert.equal(assessment.enrollmentReferenceCount, 3);
  assert.equal(assessment.similarity, assessment.enrollmentReferenceSimilarity);
  assert.equal(assessment.referenceSource, 'ENROLLMENT_PROBABLE');
  assert.equal(assessment.identityConfidence, 'PROBABLE');
  assert.equal(assessment.verified, true);
  assert.deepEqual(assessment.riskFlags, []);
  assert.equal(enrollmentEvent.metadata.sessionReferences.length, 0, 'una coincidencia probable no debe anclar el turno');
});

test('un enrolamiento legado sin banco conserva el camino del centroide y la revocación redacta referencias nuevas', async () => {
  const prisma = fakePrisma();
  const base = unitDescriptor(1);
  await enroll(prisma, [base, base, base]);
  const enrollmentEvent = prisma.events.find((event) => event.action === 'BIOMETRIC_ENROLLED');
  enrollmentEvent.metadata.enrollmentReferences = null;

  const probableDescriptor = unitDescriptor(0.6348);
  const assessment = await assessArrival(
    prisma,
    probableDescriptor,
    'TEST-reference-bank-arrival-legacy-0002',
    new Date(START.getTime() + 60_000)
  );
  assert.equal(assessment.enrollmentReferenceSimilarity, null);
  assert.equal(assessment.enrollmentReferenceCount, 0);
  assert.ok(assessment.baseSimilarity >= 0.60);
  assert.equal(assessment.verified, true);

  enrollmentEvent.metadata.enrollmentReferences = [{ algorithm: 'placeholder' }];
  await revokeWorkerBiometric(prisma, {
    workerId: WORKER_ID,
    workerLabel: 'Auxiliar TEST',
    actorUsername: 'admin-test',
    actorRole: 'admin'
  }, { now: new Date(START.getTime() + 2 * 60_000), env: ENV });

  assert.equal(enrollmentEvent.metadata.template, null);
  assert.equal(enrollmentEvent.metadata.enrollmentReferences, null);
  assert.equal(enrollmentEvent.metadata.sessionReferences, null);
  assert.equal(enrollmentEvent.metadata.descriptorHash, null);
  assert.equal(enrollmentEvent.metadata.captureHash, null);
});
