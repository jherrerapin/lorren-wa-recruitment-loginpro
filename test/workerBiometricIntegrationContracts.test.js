import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  WORKER_BIOMETRIC_EVIDENCE_VERSION,
  WORKER_BIOMETRIC_MODEL_VERSION,
  assertWorkerBiometricAttemptAllowed,
  assessWorkerBiometric,
  enrollWorkerBiometric,
  getWorkerBiometricEnrollment,
  isWorkerBiometricVerificationUsable,
  issueWorkerBiometricChallenge
} from '../src/services/workerBiometricService.js';

const ENV = { ATTENDANCE_BIOMETRIC_SECRET: 'b'.repeat(64) };
const NOW = new Date('2026-08-01T23:00:00.000Z');
const ASSIGNMENT_ID = 'assignment-1';
const WORKER_ID = 'worker-1';
const baseDescriptor = unitVector(Array.from({ length: 128 }, (_, index) => Math.sin(index + 1) / 9));

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

function sampleSet(count, startAngle = 0.01) {
  return Array.from({ length: count }, (_, index) => rotatedDescriptor(baseDescriptor, startAngle + index * 0.01));
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

function strictEnrollmentInput(overrides = {}) {
  return {
    workerId: WORKER_ID,
    workerLabel: 'Auxiliar de prueba',
    actorUsername: 'worker-portal:worker-1',
    actorRole: 'worker',
    consentAccepted: true,
    evidenceVersion: WORKER_BIOMETRIC_EVIDENCE_VERSION,
    modelVersion: WORKER_BIOMETRIC_MODEL_VERSION,
    sampleDescriptors: sampleSet(3),
    sampleRealScores: [0.84, 0.86, 0.85],
    sampleLiveScores: [0.79, 0.81, 0.8],
    captureDurationMs: 1_800,
    descriptor: Array(128).fill(99),
    realScore: 1,
    liveScore: 1,
    ...overrides
  };
}

function validChallengeEvidence(action, overrides = {}) {
  return {
    kind: 'MODEL_AND_ACTIVE_CHALLENGE_V2',
    action,
    baselineFrames: 2,
    actionFrames: 3,
    finalFrames: 2,
    captureDurationMs: 2_600,
    challengeDurationMs: 900,
    baselineYaw: 0.02,
    actionYaw: action === 'TURN_SIDE' ? 0.34 : 0.04,
    finalYaw: 0.01,
    baselineFaceRatio: 0.35,
    actionFaceRatio: action === 'MOVE_CLOSER' ? 0.43 : 0.36,
    finalFaceRatio: 0.36,
    actionDescriptors: sampleSet(3, 0.055),
    actionRealScores: [0.8, 0.82, 0.81],
    actionLiveScores: [0.68, 0.7, 0.69],
    actionRealScoreMin: 0.8,
    actionLiveScoreMin: 0.68,
    ...overrides
  };
}

async function enrollStrict(prisma) {
  return enrollWorkerBiometric(prisma, strictEnrollmentInput(), { now: NOW, env: ENV });
}

async function assessStrict(prisma, {
  idempotencyKey = 'strict-mark-key-123456',
  randomIndex = 0,
  samples = sampleSet(4, 0.015),
  realScores = [0.81, 0.82, 0.8, 0.83],
  liveScores = [0.72, 0.74, 0.71, 0.73],
  challengeEvidence,
  now = new Date(NOW.getTime() + 5_000),
  topLevelRealScore = 0.99,
  topLevelLiveScore = 0.99
} = {}) {
  const challenge = issueWorkerBiometricChallenge({
    workerId: WORKER_ID,
    assignmentId: ASSIGNMENT_ID,
    idempotencyKey,
    markType: 'ARRIVAL'
  }, { now: NOW, env: ENV, randomIndex });
  return assessWorkerBiometric(prisma, {
    workerId: WORKER_ID,
    assignmentId: ASSIGNMENT_ID,
    idempotencyKey,
    markType: 'ARRIVAL',
    evidenceVersion: WORKER_BIOMETRIC_EVIDENCE_VERSION,
    challengeToken: challenge.token,
    challengeAction: challenge.action,
    challengeCompleted: true,
    challengeEvidence: challengeEvidence || validChallengeEvidence(challenge.action),
    sampleDescriptors: samples,
    sampleRealScores: realScores,
    sampleLiveScores: liveScores,
    descriptor: Array(128).fill(99),
    realScore: topLevelRealScore,
    liveScore: topLevelLiveScore,
    modelVersion: WORKER_BIOMETRIC_MODEL_VERSION
  }, { now, env: ENV });
}

test('el enrolamiento estricto recalcula la plantilla desde tres muestras válidas', async () => {
  const prisma = fakePrisma();
  await enrollStrict(prisma);
  const event = prisma.events.find((candidate) => candidate.action === 'BIOMETRIC_ENROLLED');
  assert.equal(event.metadata.evidenceVersion, 2);
  assert.equal(event.metadata.sampleCount, 3);
  assert.equal(event.metadata.realScore, 0.84);
  assert.equal(event.metadata.liveScore, 0.79);
  assert.ok(event.metadata.minimumSampleSimilarity > 0.99);
  assert.notEqual(event.metadata.descriptorHash, null);
  assert.notEqual(event.metadata.captureHash, null);
  const enrollment = await getWorkerBiometricEnrollment(prisma, WORKER_ID, { env: ENV });
  assert.equal(enrollment.evidenceVersion, 2);
});

test('ninguna puntuación declarada arriba puede ocultar una muestra con liveness bajo', async () => {
  const prisma = fakePrisma();
  await enrollStrict(prisma);
  const assessment = await assessStrict(prisma, {
    idempotencyKey: 'low-live-sample-12345',
    liveScores: [0.72, 0.2, 0.71, 0.73],
    topLevelLiveScore: 1
  });
  assert.equal(assessment.verified, false);
  assert.ok(assessment.riskFlags.includes('BIOMETRIC_LIVENESS_LOW'));
});

test('el movimiento también exige liveness real en sus tres fotogramas', async () => {
  const prisma = fakePrisma();
  await enrollStrict(prisma);
  const evidence = validChallengeEvidence('TURN_SIDE', {
    actionLiveScores: [0.7, 0.1, 0.69]
  });
  const assessment = await assessStrict(prisma, {
    idempotencyKey: 'low-action-live-12345',
    challengeEvidence: evidence
  });
  assert.equal(assessment.verified, false);
  assert.ok(assessment.riskFlags.includes('BIOMETRIC_LIVENESS_LOW'));
});

test('un desafío activo coherente y siete muestras consistentes producen verificación temporal', async () => {
  const prisma = fakePrisma();
  await enrollStrict(prisma);
  const assessment = await assessStrict(prisma);
  assert.equal(assessment.verified, true);
  assert.equal(assessment.evidenceVersion, 2);
  assert.equal(assessment.sampleCount, 4);
  assert.equal(assessment.realScore, 0.8);
  assert.equal(assessment.liveScore, 0.71);
  assert.ok(assessment.minimumSampleSimilarity > 0.99);
  assert.ok(assessment.actionIdentitySimilarity > 0.99);
  assert.equal(assessment.challengeEvidence.actionDescriptors, undefined);
  assert.equal(typeof assessment.challengeEvidence.actionCaptureHash, 'string');
  assert.ok(new Date(assessment.validUntil) > new Date(assessment.assessedAt));
});

test('el servidor rechaza geometría que no demuestra el movimiento firmado', async () => {
  const prisma = fakePrisma();
  await enrollStrict(prisma);
  const evidence = validChallengeEvidence('TURN_SIDE', { actionYaw: 0.08 });
  const assessment = await assessStrict(prisma, {
    idempotencyKey: 'bad-geometry-1234567',
    challengeEvidence: evidence
  });
  assert.equal(assessment.verified, false);
  assert.ok(assessment.riskFlags.includes('BIOMETRIC_CHALLENGE_EVIDENCE_INVALID'));
});

test('muestras faciales incompatibles no se promedian para fabricar una coincidencia', async () => {
  const prisma = fakePrisma();
  await enrollStrict(prisma);
  const inconsistent = [
    ...sampleSet(3, 0.01),
    rotatedDescriptor(baseDescriptor, 1.2)
  ];
  const assessment = await assessStrict(prisma, {
    idempotencyKey: 'inconsistent-samples-1',
    samples: inconsistent
  });
  assert.equal(assessment.verified, false);
  assert.ok(assessment.riskFlags.includes('BIOMETRIC_SAMPLES_INCONSISTENT'));
});

test('un enrolamiento legado exige renovación antes de una verificación v2', async () => {
  const prisma = fakePrisma();
  await enrollWorkerBiometric(prisma, {
    workerId: WORKER_ID,
    workerLabel: 'Auxiliar legado',
    descriptor: baseDescriptor,
    realScore: 0.9,
    liveScore: 0.9,
    consentAccepted: true,
    actorUsername: 'legacy-admin',
    actorRole: 'admin'
  }, { now: NOW, env: ENV });
  const enrollment = await getWorkerBiometricEnrollment(prisma, WORKER_ID, { env: ENV });
  assert.equal(enrollment.evidenceVersion, 1);
  const assessment = await assessStrict(prisma, { idempotencyKey: 'legacy-upgrade-12345' });
  assert.equal(assessment.verified, false);
  assert.ok(assessment.riskFlags.includes('BIOMETRIC_ENROLLMENT_UPGRADE_REQUIRED'));
});

test('una secuencia completa reutilizada queda marcada como replay', async () => {
  const prisma = fakePrisma();
  await enrollStrict(prisma);
  const samples = sampleSet(4, 0.015);
  const evidence = validChallengeEvidence('TURN_SIDE');
  const first = await assessStrict(prisma, {
    idempotencyKey: 'fresh-capture-123456',
    samples,
    challengeEvidence: evidence
  });
  assert.equal(first.verified, true);
  const replay = await assessStrict(prisma, {
    idempotencyKey: 'replayed-capture-1234',
    samples,
    challengeEvidence: evidence,
    now: new Date(NOW.getTime() + 12_000)
  });
  assert.equal(replay.verified, false);
  assert.ok(replay.riskFlags.includes('BIOMETRIC_DESCRIPTOR_REPLAY'));
});

test('cinco fallos consecutivos imponen espera en el servidor', async () => {
  const prisma = fakePrisma();
  for (let index = 0; index < 5; index += 1) {
    prisma.events.push({
      id: `failure-${index}`,
      entityType: 'DISPATCH_ATTENDANCE_BIOMETRIC',
      entityId: `failed-key-${index}`,
      entityLabel: ASSIGNMENT_ID,
      action: 'BIOMETRIC_ASSESSED',
      metadata: {
        workerId: WORKER_ID,
        verified: false,
        decision: 'REVIEW_REQUIRED',
        assessedAt: new Date(NOW.getTime() - index * 1_000).toISOString()
      },
      createdAt: new Date(NOW.getTime() - index * 1_000)
    });
  }
  await assert.rejects(
    () => assertWorkerBiometricAttemptAllowed(prisma, {
      workerId: WORKER_ID,
      assignmentId: ASSIGNMENT_ID
    }, { now: NOW }),
    (error) => error.message === 'attendance_biometric_rate_limited' && error.retryAfterSeconds >= 25
  );
});

test('una verificación solo sirve para su contexto, dentro de su vigencia y una sola vez', () => {
  const metadata = {
    decision: 'VERIFIED',
    verified: true,
    evidenceVersion: 2,
    modelVersion: WORKER_BIOMETRIC_MODEL_VERSION,
    workerId: WORKER_ID,
    assignmentId: ASSIGNMENT_ID,
    markType: 'ARRIVAL',
    idempotencyKey: 'usable-key-12345678',
    validUntil: new Date(NOW.getTime() + 90_000).toISOString(),
    consumedAt: null
  };
  const expected = {
    workerId: WORKER_ID,
    assignmentId: ASSIGNMENT_ID,
    markType: 'ARRIVAL',
    idempotencyKey: 'usable-key-12345678'
  };
  assert.equal(isWorkerBiometricVerificationUsable(metadata, expected, NOW), true);
  assert.equal(isWorkerBiometricVerificationUsable({ ...metadata, consumedAt: NOW.toISOString() }, expected, NOW), false);
  assert.equal(isWorkerBiometricVerificationUsable(metadata, expected, new Date(NOW.getTime() + 91_000)), false);
  assert.equal(isWorkerBiometricVerificationUsable(metadata, { ...expected, markType: 'DEPARTURE' }, NOW), false);
});

test('los archivos del navegador envían evidencia completa y nunca elevan el liveness', () => {
  const mobile = fs.readFileSync(new URL('../src/public/worker-biometric-mobile.js', import.meta.url), 'utf8');
  const flow = fs.readFileSync(new URL('../src/public/worker-portal-biometric-flow.js', import.meta.url), 'utf8');
  const loader = fs.readFileSync(new URL('../src/public/worker-biometric.js', import.meta.url), 'utf8');
  const route = fs.readFileSync(new URL('../src/routes/workerPortal.js', import.meta.url), 'utf8');

  assert.doesNotMatch(mobile, /Math\.max\(modelLiveScore,\s*MIN_LIVE_SCORE\)/);
  assert.match(mobile, /sampleDescriptors:/);
  assert.match(mobile, /sampleRealScores:/);
  assert.match(mobile, /sampleLiveScores:/);
  assert.doesNotMatch(mobile, /actionDescriptors:/);
  assert.doesNotMatch(mobile, /actionLiveScores:/);
  assert.match(mobile, /MODEL_PASSIVE_LIVENESS_V2/);
  assert.match(mobile, /VERIFICATION_STAGE_SAMPLES = 2/);
  assert.match(flow, /challengeEvidence:\s*capture\.challengeEvidence/);
  assert.match(flow, /sampleDescriptors:\s*capture\.sampleDescriptors/);
  assert.match(route, /evidenceVersion:\s*WORKER_BIOMETRIC_EVIDENCE_VERSION/);
  assert.match(route, /hasCurrentBiometricEnrollment/);
  assert.match(route, /validUntil:\s*assessment\.validUntil/);
  assert.match(route, /consumeVerifiedAssessmentAfterSuccess/);
  assert.match(loader, /BIOMETRIC_ASSET_RELEASE\s*=\s*'20260804-worker-portal-biometric-v8'/);
});

test('los fallos de una etapa no bloquean otra marcación de la jornada', async () => {
  const prisma = fakePrisma();
  for (let index = 0; index < 5; index += 1) {
    prisma.events.push({
      id: `break-failure-${index}`,
      entityType: 'DISPATCH_ATTENDANCE_BIOMETRIC',
      entityId: `break-failed-key-${index}`,
      entityLabel: ASSIGNMENT_ID,
      action: 'BIOMETRIC_ASSESSED',
      metadata: {
        workerId: WORKER_ID,
        markType: 'BREAK_END',
        verified: false,
        decision: 'REVIEW_REQUIRED',
        assessedAt: new Date(NOW.getTime() - index * 1_000).toISOString()
      },
      createdAt: new Date(NOW.getTime() - index * 1_000)
    });
  }

  const departure = await assertWorkerBiometricAttemptAllowed(prisma, {
    workerId: WORKER_ID,
    assignmentId: ASSIGNMENT_ID,
    markType: 'DEPARTURE'
  }, { now: NOW });
  assert.equal(departure.allowed, true);

  await assert.rejects(
    () => assertWorkerBiometricAttemptAllowed(prisma, {
      workerId: WORKER_ID,
      assignmentId: ASSIGNMENT_ID,
      markType: 'BREAK_END'
    }, { now: NOW }),
    (error) => error.message === 'attendance_biometric_rate_limited'
  );
});
