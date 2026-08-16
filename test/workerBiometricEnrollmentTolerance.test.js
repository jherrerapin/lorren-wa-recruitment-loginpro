import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  WORKER_BIOMETRIC_EVIDENCE_VERSION,
  WORKER_BIOMETRIC_MODEL_VERSION,
  enrollWorkerBiometric,
  issueWorkerBiometricChallenge,
  assessWorkerBiometric
} from '../src/services/workerBiometricService.js';

const mobile = fs.readFileSync('src/public/worker-biometric-mobile.js', 'utf8');
const TEST_SECRET = 'TEST-biometric-secret-000000000000000000000000';

function descriptor() {
  return Array.from({ length: 128 }, (_, index) => (index === 0 ? 1 : 0));
}

function createClientHarness({ firstDescriptorMissing = false } = {}) {
  let detectionCount = 0;

  class FakeHuman {
    constructor(config) {
      this.config = config;
      this.models = {};
      this.tf = { getBackend: () => config.backend };
    }

    load() { return Promise.resolve(); }

    detect() {
      detectionCount += 1;
      return Promise.resolve({
        face: [{
          box: [200, 200, 320, 320],
          faceScore: 0.95,
          real: 0.20,
          live: 0.25,
          ...((firstDescriptorMissing && detectionCount === 1) ? {} : { embedding: descriptor() }),
          rotation: { angle: { yaw: 0, pitch: 0 } }
        }]
      });
    }
  }

  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => {} }),
    toBlob: (callback) => callback(new Blob(['TEST-photo'], { type: 'image/jpeg' }))
  };
  const document = {
    visibilityState: 'visible',
    wasDiscarded: false,
    querySelector: () => null,
    getElementById: () => null,
    createElement: (tagName) => tagName === 'canvas' ? canvas : {},
    addEventListener: () => {}
  };
  const navigator = { userAgent: 'Android' };
  const window = {
    LorrenWorkerBiometric: Object.freeze({ MODEL_VERSION: WORKER_BIOMETRIC_MODEL_VERSION }),
    Human: { Human: FakeHuman },
    navigator,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    addEventListener: () => {}
  };

  vm.runInNewContext(mobile, {
    window,
    document,
    navigator,
    performance,
    Blob,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  });

  const track = { readyState: 'live', enabled: true, muted: false };
  const video = {
    srcObject: { getVideoTracks: () => [track] },
    readyState: 2,
    videoWidth: 720,
    videoHeight: 960
  };

  return {
    api: window.LorrenWorkerBiometric,
    video,
    detectionCount: () => detectionCount
  };
}

function createPrisma() {
  const events = [];
  let sequence = 0;

  function matches(event, where = {}) {
    if (where.entityType && event.entityType !== where.entityType) return false;
    if (where.entityId && typeof where.entityId === 'string' && event.entityId !== where.entityId) return false;
    if (where.entityLabel && event.entityLabel !== where.entityLabel) return false;
    if (where.action && typeof where.action === 'string' && event.action !== where.action) return false;
    if (where.action?.in && !where.action.in.includes(event.action)) return false;
    return true;
  }

  return {
    events,
    devAuditEvent: {
      async findMany({ where = {} } = {}) {
        return events.filter((event) => matches(event, where)).slice().reverse();
      },
      async findFirst({ where = {} } = {}) {
        return events.filter((event) => matches(event, where)).at(-1) || null;
      },
      async create({ data }) {
        const event = { id: `TEST-event-${++sequence}`, ...data, createdAt: data.createdAt || new Date() };
        events.push(event);
        return event;
      },
      async update({ where, data }) {
        const event = events.find((entry) => entry.id === where.id);
        if (!event) throw new Error('TEST-event-not-found');
        Object.assign(event, data);
        return event;
      }
    }
  };
}

function strictEvidence(scores = {}) {
  return {
    evidenceVersion: WORKER_BIOMETRIC_EVIDENCE_VERSION,
    modelVersion: WORKER_BIOMETRIC_MODEL_VERSION,
    descriptor: descriptor(),
    sampleDescriptors: [descriptor()],
    sampleRealScores: [scores.real ?? 0.20],
    sampleLiveScores: [scores.live ?? 0.25],
    realScore: scores.real ?? 0.20,
    liveScore: scores.live ?? 0.25,
    captureDurationMs: 300
  };
}

test('el enrolamiento cliente acepta descriptor válido sin bloquear por real/live', async () => {
  const harness = createClientHarness();
  const statuses = [];
  const capture = await harness.api.captureEnrollment({
    video: harness.video,
    onStatus: (message) => statuses.push(message)
  });

  assert.equal(harness.detectionCount(), 1);
  assert.equal(capture.sampleDescriptors.length, 1);
  assert.equal(capture.realScore, 0.20);
  assert.equal(capture.liveScore, 0.25);
  assert.equal(statuses.some((message) => message.includes('Validando que sea un rostro real')), false);
});

test('un descriptor ausente se descarta sin anunciar captura 0 de 1', async () => {
  const harness = createClientHarness({ firstDescriptorMissing: true });
  const statuses = [];
  const capture = await harness.api.captureEnrollment({
    video: harness.video,
    onStatus: (message) => statuses.push(message)
  });

  assert.equal(harness.detectionCount(), 2);
  assert.equal(capture.sampleDescriptors.length, 1);
  assert.ok(statuses.includes('No se pudieron leer los rasgos. Mantén la posición.'));
  assert.equal(statuses.some((message) => message.includes('captura 0 de 1')), false);
});

test('backend conserva scores bajos como auditoría al enrolar evidencia v2', async () => {
  const prisma = createPrisma();
  const now = new Date('2030-01-01T12:00:00.000Z');
  const result = await enrollWorkerBiometric(prisma, {
    workerId: 'TEST-worker-enrollment-tolerance',
    actorUsername: 'TEST-worker-portal',
    consentAccepted: true,
    ...strictEvidence()
  }, {
    now,
    env: { ATTENDANCE_BIOMETRIC_SECRET: TEST_SECRET }
  });

  assert.equal(result.enrolled, true);
  const event = prisma.events.find((entry) => entry.action === 'BIOMETRIC_ENROLLED');
  assert.equal(event.metadata.realScore, 0.20);
  assert.equal(event.metadata.liveScore, 0.25);
  assert.equal(event.metadata.sampleCount, 1);
});

test('una marcación conserva la barrera anti-spoof/liveness', async () => {
  const prisma = createPrisma();
  const now = new Date('2030-01-01T12:00:00.000Z');
  const env = { ATTENDANCE_BIOMETRIC_SECRET: TEST_SECRET };
  await enrollWorkerBiometric(prisma, {
    workerId: 'TEST-worker-mark-strict',
    actorUsername: 'TEST-worker-portal',
    consentAccepted: true,
    ...strictEvidence({ real: 0.90, live: 0.90 })
  }, { now, env });

  const idempotencyKey = 'TEST-mark-low-presence-score';
  const challenge = issueWorkerBiometricChallenge({
    workerId: 'TEST-worker-mark-strict',
    assignmentId: 'TEST-assignment-mark-strict',
    idempotencyKey,
    markType: 'ARRIVAL'
  }, { now, env, randomIndex: 0 });

  const assessment = await assessWorkerBiometric(prisma, {
    workerId: 'TEST-worker-mark-strict',
    assignmentId: 'TEST-assignment-mark-strict',
    idempotencyKey,
    markType: 'ARRIVAL',
    challengeToken: challenge.token,
    challengeAction: challenge.action,
    challengeCompleted: true,
    challengeEvidence: {
      kind: 'MODEL_PASSIVE_LIVENESS_V2',
      action: challenge.action,
      frames: 1,
      captureDurationMs: 300
    },
    ...strictEvidence({ real: 0.20, live: 0.90 })
  }, { now, env });

  assert.equal(assessment.verified, false);
  assert.equal(assessment.decision, 'REVIEW_REQUIRED');
  assert.ok(assessment.riskFlags.includes('BIOMETRIC_ANTISPOOF_LOW'));
});
