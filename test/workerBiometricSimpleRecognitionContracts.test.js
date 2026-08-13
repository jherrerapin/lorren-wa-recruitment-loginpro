import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  WORKER_BIOMETRIC_EVIDENCE_VERSION,
  WORKER_BIOMETRIC_MODEL_VERSION,
  assessWorkerBiometric,
  enrollWorkerBiometric,
  getWorkerBiometricEnrollment,
  issueWorkerBiometricChallenge
} from '../src/services/workerBiometricService.js';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const mobile = read('src/public/worker-biometric-mobile.js');
const flow = read('src/public/worker-portal-biometric-flow.js');
const service = read('src/services/workerBiometricService.js');
const loader = read('src/public/worker-biometric.js');
const serviceWorker = read('src/public/worker-portal-sw.js');
const ENV = { ATTENDANCE_BIOMETRIC_SECRET: 's'.repeat(64) };
const NOW = new Date('2026-08-12T15:00:00.000Z');

function fakePrisma() {
  const events = [];
  let sequence = 0;
  const matches = (event, where = {}) => {
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
    if (where.metadata?.path?.[0]) {
      const key = where.metadata.path[0];
      if (event.metadata?.[key] !== where.metadata.equals) return false;
    }
    return true;
  };
  return {
    events,
    devAuditEvent: {
      async findMany({ where = {}, select } = {}) {
        const found = events.filter((event) => matches(event, where));
        if (!select) return structuredClone(found);
        return found.map((event) => Object.fromEntries(
          Object.keys(select).filter((key) => select[key]).map((key) => [key, structuredClone(event[key])])
        ));
      },
      async findFirst({ where = {} } = {}) {
        const found = events
          .filter((event) => matches(event, where))
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
        assert.ok(event);
        Object.assign(event, structuredClone(data));
        return structuredClone(event);
      }
    }
  };
}

function descriptor(axis = 0) {
  return Array.from({ length: 128 }, (_, index) => index === axis ? 1 : 0);
}

async function enrollOneFace(prisma, workerId = 'TEST-worker-one-face') {
  return enrollWorkerBiometric(prisma, {
    workerId,
    actorUsername: 'worker-portal:test',
    consentAccepted: true,
    evidenceVersion: WORKER_BIOMETRIC_EVIDENCE_VERSION,
    modelVersion: WORKER_BIOMETRIC_MODEL_VERSION,
    sampleDescriptors: [descriptor(0)],
    sampleRealScores: [0.9],
    sampleLiveScores: [0.9],
    captureDurationMs: 0
  }, { now: NOW, env: ENV });
}

async function assessOneFace(prisma, {
  workerId = 'TEST-worker-one-face',
  capturedDescriptor = descriptor(1),
  realScore = 0.9,
  liveScore = 0.9,
  markType = 'BREAK_START',
  idempotencyKey = 'TEST-one-face-mark-0001'
} = {}) {
  const assignmentId = 'TEST-assignment-one-face';
  const challenge = issueWorkerBiometricChallenge({
    workerId,
    assignmentId,
    idempotencyKey,
    markType
  }, { now: NOW, env: ENV, randomIndex: 0 });

  return assessWorkerBiometric(prisma, {
    workerId,
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
      frames: 1,
      captureDurationMs: 0
    },
    sampleDescriptors: [capturedDescriptor],
    sampleRealScores: [realScore],
    sampleLiveScores: [liveScore],
    realScore,
    liveScore
  }, { now: new Date(NOW.getTime() + 1_000), env: ENV });
}

test('registro y marcaciones usan una sola cara real en el modo temporal', () => {
  assert.match(mobile, /const ENROLLMENT_TARGET_SAMPLES = 1/);
  assert.match(mobile, /const ENROLLMENT_MIN_SAMPLES = 1/);
  assert.match(mobile, /const VERIFICATION_STAGE_SAMPLES = 1/);
  assert.match(mobile, /const REQUIRED_STABLE_FRONT_FRAMES = 1/);
  assert.match(mobile, /faces\.length !== 1/);
  assert.match(mobile, /scores\.realScore < MIN_REAL_SCORE/);
  assert.match(mobile, /scores\.liveScore < MIN_LIVE_SCORE/);
  assert.match(mobile, /'biometric_capture_timeout'/);
  assert.match(flow, /\['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE'\]\.includes/);
  assert.match(service, /BIOMETRIC_MARK_TYPES = new Set\(\['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE'\]\)/);
});

test('el backend acepta uno, dos o tres rostros válidos y conserva las referencias cifradas', async () => {
  for (const sampleCount of [1, 2, 3]) {
    const prisma = fakePrisma();
    const samples = Array.from({ length: sampleCount }, () => descriptor(0));
    await enrollWorkerBiometric(prisma, {
      workerId: `TEST-worker-${sampleCount}`,
      actorUsername: 'worker-portal:test',
      consentAccepted: true,
      evidenceVersion: WORKER_BIOMETRIC_EVIDENCE_VERSION,
      modelVersion: WORKER_BIOMETRIC_MODEL_VERSION,
      sampleDescriptors: samples,
      sampleRealScores: Array(sampleCount).fill(0.9),
      sampleLiveScores: Array(sampleCount).fill(0.9),
      captureDurationMs: 0
    }, { now: NOW, env: ENV });

    const enrollmentEvent = prisma.events.find((event) => event.action === 'BIOMETRIC_ENROLLED');
    assert.equal(enrollmentEvent.metadata.sampleCount, sampleCount);
    assert.equal(enrollmentEvent.metadata.enrollmentReferences.length, sampleCount);
    assert.ok(enrollmentEvent.metadata.enrollmentReferences.every((entry) => entry.algorithm === 'aes-256-gcm'));

    const restored = await getWorkerBiometricEnrollment(prisma, `TEST-worker-${sampleCount}`, { env: ENV });
    assert.equal(restored.enrollmentReferences.length, sampleCount);
  }
});

test('el backend rechaza cero o más de tres muestras de enrolamiento', async () => {
  for (const sampleCount of [0, 4]) {
    const prisma = fakePrisma();
    const samples = Array.from({ length: sampleCount }, () => descriptor(0));
    await assert.rejects(
      enrollWorkerBiometric(prisma, {
        workerId: `TEST-worker-invalid-${sampleCount}`,
        actorUsername: 'worker-portal:test',
        consentAccepted: true,
        evidenceVersion: WORKER_BIOMETRIC_EVIDENCE_VERSION,
        modelVersion: WORKER_BIOMETRIC_MODEL_VERSION,
        sampleDescriptors: samples,
        sampleRealScores: Array(sampleCount).fill(0.9),
        sampleLiveScores: Array(sampleCount).fill(0.9),
        captureDurationMs: 0
      }, { now: NOW, env: ENV }),
      /attendance_biometric_enrollment_samples_invalid/
    );
  }
});

test('una sola cara real puede marcar aunque la similitud de identidad sea baja', async () => {
  const prisma = fakePrisma();
  await enrollOneFace(prisma);
  const assessment = await assessOneFace(prisma);

  assert.equal(assessment.sampleCount, 1);
  assert.equal(assessment.challengeEvidence.frames, 1);
  assert.equal(assessment.similarity, 0);
  assert.equal(assessment.identityConfidence, 'UNCONFIRMED');
  assert.equal(assessment.identityMatchEnforced, false);
  assert.equal(assessment.verified, true);
  assert.equal(assessment.decision, 'VERIFIED');
  assert.equal(assessment.riskFlags.includes('BIOMETRIC_FACE_MISMATCH'), false);
});

test('una sola cara que no supera anti-spoof sigue bloqueada', async () => {
  const prisma = fakePrisma();
  await enrollOneFace(prisma, 'TEST-worker-spoof');
  const assessment = await assessOneFace(prisma, {
    workerId: 'TEST-worker-spoof',
    capturedDescriptor: descriptor(0),
    realScore: 0.54,
    liveScore: 0.9,
    idempotencyKey: 'TEST-one-face-spoof-0001'
  });

  assert.equal(assessment.verified, false);
  assert.equal(assessment.decision, 'REVIEW_REQUIRED');
  assert.ok(assessment.riskFlags.includes('BIOMETRIC_ANTISPOOF_LOW'));
});

test('Android evita WebGL y una sola muestra frontal completa la marcación', () => {
  assert.match(mobile, /const IS_ANDROID = \/Android\/i/);
  assert.match(mobile, /IS_ANDROID \? \['cpu'\] : \['webgl', 'wasm', 'cpu'\]/);
  assert.match(mobile, /mesh: \{ enabled: !IS_ANDROID/);
  assert.match(mobile, /iris: \{ enabled: !IS_ANDROID/);
  const start = mobile.indexOf('async function captureVerification');
  const end = mobile.indexOf('function stopStream', start);
  const verification = mobile.slice(start, end);
  assert.match(verification, /VERIFICATION_STAGE_SAMPLES/);
  assert.match(verification, /MODEL_PASSIVE_LIVENESS_V2/);
  assert.doesNotMatch(verification, /captureActiveChallenge/);
});

test('el servidor limita la comparación no bloqueante al modo estricto de una muestra', () => {
  assert.match(service, /ENROLLMENT_MIN_SAMPLE_COUNT = 1/);
  assert.match(service, /ENROLLMENT_TARGET_SAMPLE_COUNT = 3/);
  assert.match(service, /PASSIVE_VERIFICATION_MIN_SAMPLE_COUNT = 1/);
  assert.match(service, /PASSIVE_VERIFICATION_SAMPLE_COUNT = 2/);
  assert.match(service, /validateStrictSamples\(input, verificationSampleCount/);
  assert.match(service, /REAL_THRESHOLD = 0\.55/);
  assert.match(service, /LIVE_THRESHOLD = 0\.55/);
  assert.match(service, /MATCH_THRESHOLD = 0\.82/);
  assert.match(service, /ATTENDANCE_IDENTITY_THRESHOLD = 0\.60/);
  assert.match(service, /identityMatchEnforced = !strictEvidence \|\| sampleCount > PASSIVE_VERIFICATION_MIN_SAMPLE_COUNT/);
  assert.match(service, /!enrollmentMatched && !enrollmentProbable && !sessionMatched && identityMatchEnforced/);
  assert.match(service, /addFlag\(flags, 'BIOMETRIC_FACE_MISMATCH'/);
  assert.match(service, /identityMatchEnforced,/);
  assert.match(service, /PASSIVE_CHALLENGE_KIND = 'MODEL_PASSIVE_LIVENESS_V2'/);
});

test('no encadena reinicios automáticos y conserva la estrategia network-first vigente', () => {
  assert.match(flow, /MAX_AUTOMATIC_ATTEMPTS = 1/);
  assert.match(loader, /20260811-worker-portal-biometric-v9/);
  assert.match(serviceWorker, /lorren-worker-portal-shell-v14/);
});
