import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  WORKER_BIOMETRIC_EVIDENCE_VERSION,
  WORKER_BIOMETRIC_MODEL_VERSION,
  enrollWorkerBiometric,
  getWorkerBiometricEnrollment
} from '../src/services/workerBiometricService.js';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const mobile = read('src/public/worker-biometric-mobile.js');
const flow = read('src/public/worker-portal-biometric-flow.js');
const service = read('src/services/workerBiometricService.js');
const loader = read('src/public/worker-biometric.js');
const serviceWorker = read('src/public/worker-portal-sw.js');
const ENV = { ATTENDANCE_BIOMETRIC_SECRET: 's'.repeat(64) };

function fakePrisma() {
  const events = [];
  let sequence = 0;
  const matches = (event, where = {}) => {
    if (where.entityType && event.entityType !== where.entityType) return false;
    if (where.entityId) {
      if (typeof where.entityId === 'string' && event.entityId !== where.entityId) return false;
      if (where.entityId.in && !where.entityId.in.includes(event.entityId)) return false;
    }
    if (where.action) {
      if (typeof where.action === 'string' && event.action !== where.action) return false;
      if (where.action.in && !where.action.in.includes(event.action)) return false;
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

function descriptor(seed = 1) {
  return [seed, ...Array(127).fill(0)];
}

test('un registro facial sirve para llegada, almuerzos y salida', () => {
  assert.match(mobile, /const ENROLLMENT_TARGET_SAMPLES = 1/);
  assert.match(mobile, /const ENROLLMENT_MIN_SAMPLES = 1/);
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
    const samples = Array.from({ length: sampleCount }, (_, index) => descriptor(index + 1));
    await enrollWorkerBiometric(prisma, {
      workerId: `TEST-worker-${sampleCount}`,
      actorUsername: 'worker-portal:test',
      consentAccepted: true,
      evidenceVersion: WORKER_BIOMETRIC_EVIDENCE_VERSION,
      modelVersion: WORKER_BIOMETRIC_MODEL_VERSION,
      sampleDescriptors: samples,
      sampleRealScores: Array(sampleCount).fill(0.9),
      sampleLiveScores: Array(sampleCount).fill(0.9),
      captureDurationMs: 1_000
    }, { now: new Date('2026-08-12T15:00:00.000Z'), env: ENV });

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
    const samples = Array.from({ length: sampleCount }, (_, index) => descriptor(index + 1));
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
        captureDurationMs: 1_000
      }, { now: new Date('2026-08-12T15:00:00.000Z'), env: ENV }),
      /attendance_biometric_enrollment_samples_invalid/
    );
  }
});

test('Android evita WebGL y la marcación conserva dos muestras frontales', () => {
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

test('el servidor conserva anti-spoof, liveness y comparación de identidad', () => {
  assert.match(service, /ENROLLMENT_MIN_SAMPLE_COUNT = 1/);
  assert.match(service, /ENROLLMENT_TARGET_SAMPLE_COUNT = 3/);
  assert.match(service, /PASSIVE_VERIFICATION_SAMPLE_COUNT = 2/);
  assert.match(service, /validateStrictSamples\(input, verificationSampleCount/);
  assert.match(service, /REAL_THRESHOLD = 0\.55/);
  assert.match(service, /LIVE_THRESHOLD = 0\.55/);
  assert.match(service, /MATCH_THRESHOLD = 0\.82/);
  assert.match(service, /ATTENDANCE_IDENTITY_THRESHOLD = 0\.60/);
  assert.match(service, /PASSIVE_CHALLENGE_KIND = 'MODEL_PASSIVE_LIVENESS_V2'/);
});

test('no encadena reinicios automáticos y fuerza actualización del portal', () => {
  assert.match(flow, /MAX_AUTOMATIC_ATTEMPTS = 1/);
  assert.match(loader, /20260812-worker-portal-biometric-v10/);
  assert.match(serviceWorker, /lorren-worker-portal-shell-v14/);
});
