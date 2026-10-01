import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessWorkerFacePresence,
  issueWorkerFacePresenceChallenge,
  workerFacePresenceStatus
} from '../src/services/workerFacePresenceService.js';
import {
  WORKER_BIOMETRIC_EVIDENCE_VERSION,
  WORKER_BIOMETRIC_MODEL_VERSION
} from '../src/services/workerBiometricService.js';

const ENV = { ATTENDANCE_BIOMETRIC_SECRET: 'face-presence-test-secret-1234567890abcdef' };
const NOW = new Date('2026-10-01T16:00:00.000Z');

function descriptor(seed = 1) {
  return Array.from({ length: 64 }, (_, index) => ((index + seed) % 17 + 1) / 20);
}

function prismaHarness() {
  const events = [];
  return {
    events,
    devAuditEvent: {
      async findFirst({ where }) {
        return events.find((event) => (
          event.entityType === where.entityType
          && event.entityId === where.entityId
          && event.action === where.action
        )) || null;
      },
      async create({ data }) {
        const event = { id: `event-${events.length + 1}`, ...data };
        events.push(event);
        return event;
      }
    }
  };
}

function challenge() {
  return issueWorkerFacePresenceChallenge({
    workerId: 'worker-1',
    assignmentId: 'assignment-1',
    idempotencyKey: 'presence-attempt-123456',
    markType: 'BREAK_START'
  }, { now: NOW, env: ENV, randomIndex: 0 });
}

function inputFor(challengeValue) {
  const first = descriptor(1);
  const second = descriptor(9);
  return {
    workerId: 'worker-1',
    assignmentId: 'assignment-1',
    idempotencyKey: 'presence-attempt-123456',
    markType: 'BREAK_START',
    evidenceVersion: WORKER_BIOMETRIC_EVIDENCE_VERSION,
    modelVersion: WORKER_BIOMETRIC_MODEL_VERSION,
    challengeToken: challengeValue.token,
    challengeAction: challengeValue.action,
    challengeCompleted: true,
    challengeEvidence: {
      kind: 'MODEL_PASSIVE_LIVENESS_V2',
      action: challengeValue.action,
      frames: 2,
      captureDurationMs: 850
    },
    descriptor: first,
    sampleDescriptors: [first, second],
    sampleRealScores: [0.2, 0.1],
    sampleLiveScores: [0.15, 0.25]
  };
}

test('estado de presencia no exige enrolamiento facial previo', () => {
  const status = workerFacePresenceStatus();
  assert.equal(status.enrolled, true);
  assert.equal(status.presenceOnly, true);
  assert.equal(status.evidenceVersion, WORKER_BIOMETRIC_EVIDENCE_VERSION);
});

test('presencia facial acepta un rostro detectable sin comparar identidad ni plantilla guardada', async () => {
  const prisma = prismaHarness();
  const issued = challenge();
  const assessment = await assessWorkerFacePresence(prisma, inputFor(issued), { now: NOW, env: ENV });

  assert.equal(assessment.verified, true);
  assert.equal(assessment.facePresent, true);
  assert.equal(assessment.identityMatchEnforced, false);
  assert.equal(assessment.referenceSource, 'FACE_PRESENCE');
  assert.deepEqual(assessment.riskFlags, []);
  assert.equal(prisma.events.length, 1);
  assert.equal(prisma.events[0].metadata.workerId, 'worker-1');
});

test('presencia facial sigue rechazando evidencia sin un descriptor facial válido', async () => {
  const prisma = prismaHarness();
  const issued = challenge();
  const input = inputFor(issued);
  input.sampleDescriptors = [[]];
  input.sampleRealScores = [0.5];
  input.sampleLiveScores = [0.5];

  await assert.rejects(
    assessWorkerFacePresence(prisma, input, { now: NOW, env: ENV }),
    /attendance_biometric_descriptor_invalid/
  );
});
