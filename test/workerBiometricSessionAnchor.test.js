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

const ENV = { ATTENDANCE_BIOMETRIC_SECRET: 's'.repeat(64) };
const START = new Date('2026-08-11T13:00:00.000Z');
const WORKER_ID = 'TEST-worker-anchor';
const ASSIGNMENT_ID = 'TEST-assignment-anchor';
const baseDescriptor = unitVector(Array.from({ length: 128 }, (_, index) => Math.sin(index + 1) / 7));

function unitVector(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / norm);
}

function dot(left, right) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function orthogonalDirection(vector) {
  const base = unitVector(vector);
  const seed = Array.from({ length: base.length }, (_, index) => Math.cos((index + 1) * 1.7));
  const projection = dot(seed, base);
  return unitVector(seed.map((value, index) => value - projection * base[index]));
}

function secondOrthogonalDirection(baseVector, firstOrthogonal) {
  const base = unitVector(baseVector);
  const first = unitVector(firstOrthogonal);
  const seed = Array.from({ length: base.length }, (_, index) => Math.sin((index + 1) * 2.3 + 0.4));
  const baseProjection = dot(seed, base);
  const firstProjection = dot(seed, first);
  return unitVector(seed.map((value, index) => (
    value - baseProjection * base[index] - firstProjection * first[index]
  )));
}

function descriptorAtCosine(cosine, direction = 1) {
  const base = unitVector(baseDescriptor);
  const orthogonal = orthogonalDirection(base);
  const bounded = Math.max(-1, Math.min(1, cosine));
  const angle = Math.acos(bounded) * direction;
  return base.map((value, index) => value * Math.cos(angle) + orthogonal[index] * Math.sin(angle));
}

function descriptorAtBaseAndSessionCosine(baseCosine, sessionCosine, sessionDescriptor) {
  const base = unitVector(baseDescriptor);
  const first = orthogonalDirection(base);
  const second = secondOrthogonalDirection(base, first);
  const session = unitVector(sessionDescriptor);
  const sessionBase = dot(session, base);
  const sessionFirst = dot(session, first);
  assert.ok(Math.abs(dot(session, second)) < 1e-8, 'la referencia sintética debe quedar en el plano base/primera dirección');
  const firstCoefficient = (sessionCosine - sessionBase * baseCosine) / sessionFirst;
  const secondSquared = 1 - baseCosine ** 2 - firstCoefficient ** 2;
  assert.ok(secondSquared > 0, 'las similitudes sintéticas solicitadas deben formar un vector unitario');
  return unitVector(base.map((value, index) => (
    baseCosine * value
      + firstCoefficient * first[index]
      + Math.sqrt(secondSquared) * second[index]
  )));
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

async function enroll(prisma) {
  return enrollWorkerBiometric(prisma, {
    workerId: WORKER_ID,
    workerLabel: 'Auxiliar TEST',
    actorUsername: 'worker-portal:test',
    actorRole: 'worker',
    consentAccepted: true,
    evidenceVersion: WORKER_BIOMETRIC_EVIDENCE_VERSION,
    modelVersion: WORKER_BIOMETRIC_MODEL_VERSION,
    sampleDescriptors: [baseDescriptor, baseDescriptor, baseDescriptor],
    sampleRealScores: [0.9, 0.91, 0.92],
    sampleLiveScores: [0.9, 0.91, 0.92],
    captureDurationMs: 1_200
  }, { now: START, env: ENV });
}

async function assess(prisma, {
  descriptor,
  assignmentId = ASSIGNMENT_ID,
  markType,
  idempotencyKey,
  now
}) {
  const issuedAt = new Date(now.getTime() - 1_000);
  const challenge = issueWorkerBiometricChallenge({
    workerId: WORKER_ID,
    assignmentId,
    idempotencyKey,
    markType
  }, { now: issuedAt, env: ENV, randomIndex: 0 });
  return assessWorkerBiometric(prisma, {
    workerId: WORKER_ID,
    assignmentId,
    idempotencyKey,
    markType,
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

test('una llegada validada por el enrolamiento ancla el turno sin relajar 0.82', async () => {
  const prisma = fakePrisma();
  await enroll(prisma);
  const arrivalDescriptor = descriptorAtCosine(0.8404);
  const arrival = await assess(prisma, {
    descriptor: arrivalDescriptor,
    markType: 'ARRIVAL',
    idempotencyKey: 'TEST-arrival-anchor-0001',
    now: new Date(START.getTime() + 60_000)
  });

  assert.equal(arrival.verified, true);
  assert.equal(arrival.referenceSource, 'ENROLLMENT');
  assert.ok(arrival.baseSimilarity >= 0.82);
  assert.equal(arrival.matchThreshold, 0.82);
  assert.equal(arrival.sessionIdentityThreshold, 0.65);

  const enrollmentEvent = prisma.events.find((event) => event.action === 'BIOMETRIC_ENROLLED');
  assert.equal(enrollmentEvent.metadata.sessionReferences.length, 1);
  assert.equal(enrollmentEvent.metadata.sessionReferences[0].assignmentId, ASSIGNMENT_ID);
  assert.equal(enrollmentEvent.metadata.sessionReferences[0].template.algorithm, 'aes-256-gcm');
  assert.equal(JSON.stringify(enrollmentEvent.metadata).includes(JSON.stringify(arrivalDescriptor)), false);

  const enrollment = await getWorkerBiometricEnrollment(prisma, WORKER_ID, {
    env: ENV,
    now: new Date(START.getTime() + 2 * 60_000)
  });
  assert.equal(enrollment.sessionReferences.length, 1);
  assert.ok(humanFaceSimilarity(enrollment.sessionReferences[0].descriptor, arrivalDescriptor) > 0.999);
});

test('el mismo turno tolera continuidad real entre 0.65 y 0.82 sin relajar la llegada', async () => {
  const prisma = fakePrisma();
  await enroll(prisma);
  const arrivalDescriptor = descriptorAtCosine(0.8404);
  const breakDescriptor = descriptorAtBaseAndSessionCosine(0.6658, 0.70, arrivalDescriptor);

  await assess(prisma, {
    descriptor: arrivalDescriptor,
    markType: 'ARRIVAL',
    idempotencyKey: 'TEST-arrival-anchor-0002',
    now: new Date(START.getTime() + 60_000)
  });
  const breakAssessment = await assess(prisma, {
    descriptor: breakDescriptor,
    markType: 'BREAK_START',
    idempotencyKey: 'TEST-break-anchor-0002',
    now: new Date(START.getTime() + 4 * 60 * 60_000)
  });

  assert.ok(breakAssessment.baseSimilarity < 0.82);
  assert.ok(breakAssessment.sessionSimilarity >= 0.65);
  assert.ok(breakAssessment.sessionSimilarity < 0.82);
  assert.equal(breakAssessment.sessionIdentityThreshold, 0.65);
  assert.equal(breakAssessment.similarity, breakAssessment.sessionSimilarity);
  assert.equal(breakAssessment.referenceSource, 'SESSION');
  assert.equal(breakAssessment.verified, true);
  assert.deepEqual(breakAssessment.riskFlags, []);

  const enrollmentEvent = prisma.events.find((event) => event.action === 'BIOMETRIC_ENROLLED');
  assert.equal(enrollmentEvent.metadata.sessionReferences.length, 1, 'una coincidencia secundaria no crea una cadena de plantillas');
});

test('una llegada débil no puede usar el umbral de continuidad aunque exista un ancla del turno', async () => {
  const prisma = fakePrisma();
  await enroll(prisma);
  const arrivalDescriptor = descriptorAtCosine(0.8404);
  await assess(prisma, {
    descriptor: arrivalDescriptor,
    markType: 'ARRIVAL',
    idempotencyKey: 'TEST-arrival-anchor-0003',
    now: new Date(START.getTime() + 60_000)
  });

  const weakArrivalDescriptor = descriptorAtBaseAndSessionCosine(0.70, 0.75, arrivalDescriptor);
  const weakArrival = await assess(prisma, {
    descriptor: weakArrivalDescriptor,
    markType: 'ARRIVAL',
    idempotencyKey: 'TEST-weak-arrival-0003',
    now: new Date(START.getTime() + 2 * 60_000)
  });

  assert.ok(weakArrival.baseSimilarity < 0.82);
  assert.ok(weakArrival.sessionSimilarity >= 0.65);
  assert.equal(weakArrival.referenceSource, null);
  assert.equal(weakArrival.verified, false);
  assert.ok(weakArrival.riskFlags.includes('BIOMETRIC_FACE_MISMATCH'));
});

test('el ancla del turno no cruza asignaciones ni acepta un rostro por debajo de la continuidad', async () => {
  const prisma = fakePrisma();
  await enroll(prisma);
  const arrivalDescriptor = descriptorAtCosine(0.8404);
  await assess(prisma, {
    descriptor: arrivalDescriptor,
    markType: 'ARRIVAL',
    idempotencyKey: 'TEST-arrival-anchor-0004',
    now: new Date(START.getTime() + 60_000)
  });

  const driftForOtherAssignment = descriptorAtCosine(0.71);
  const otherAssignment = await assess(prisma, {
    descriptor: driftForOtherAssignment,
    assignmentId: 'TEST-assignment-other',
    markType: 'BREAK_START',
    idempotencyKey: 'TEST-other-assignment-0004',
    now: new Date(START.getTime() + 3 * 60 * 60_000)
  });
  assert.equal(otherAssignment.sessionSimilarity, null);
  assert.equal(otherAssignment.verified, false);
  assert.ok(otherAssignment.riskFlags.includes('BIOMETRIC_FACE_MISMATCH'));

  const nearImpostor = descriptorAtCosine(0.80, -1);
  const impostorAssessment = await assess(prisma, {
    descriptor: nearImpostor,
    markType: 'DEPARTURE',
    idempotencyKey: 'TEST-impostor-anchor-0004',
    now: new Date(START.getTime() + 5 * 60 * 60_000)
  });
  assert.ok(impostorAssessment.baseSimilarity < 0.82);
  assert.ok(impostorAssessment.sessionSimilarity < 0.65);
  assert.equal(impostorAssessment.verified, false);
  assert.ok(impostorAssessment.riskFlags.includes('BIOMETRIC_FACE_MISMATCH'));
});

test('el ancla expira y la revocación redacta todo el material biométrico adicional', async () => {
  const prisma = fakePrisma();
  await enroll(prisma);
  const arrivalDescriptor = descriptorAtCosine(0.8404);
  await assess(prisma, {
    descriptor: arrivalDescriptor,
    markType: 'ARRIVAL',
    idempotencyKey: 'TEST-arrival-anchor-0005',
    now: new Date(START.getTime() + 60_000)
  });

  const expiredAttempt = await assess(prisma, {
    descriptor: descriptorAtCosine(0.724),
    markType: 'BREAK_END',
    idempotencyKey: 'TEST-expired-anchor-0005',
    now: new Date(START.getTime() + 25 * 60 * 60_000)
  });
  assert.equal(expiredAttempt.sessionSimilarity, null);
  assert.equal(expiredAttempt.verified, false);

  await revokeWorkerBiometric(prisma, {
    workerId: WORKER_ID,
    workerLabel: 'Auxiliar TEST',
    actorUsername: 'admin-test',
    actorRole: 'admin'
  }, { now: new Date(START.getTime() + 26 * 60 * 60_000), env: ENV });

  const enrollmentEvent = prisma.events.find((event) => event.action === 'BIOMETRIC_ENROLLED');
  assert.equal(enrollmentEvent.metadata.template, null);
  assert.equal(enrollmentEvent.metadata.sessionReferences, null);
  assert.equal(enrollmentEvent.metadata.descriptorHash, null);
  assert.equal(enrollmentEvent.metadata.captureHash, null);
});
