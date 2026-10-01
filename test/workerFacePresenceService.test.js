import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessWorkerFacePresence,
  issueWorkerFacePresenceChallenge,
  workerFacePresenceStatus
} from '../src/services/workerFacePresenceService.js';
import {
  ATTENDANCE_BIOMETRIC_ENTITY_TYPE,
  WORKER_BIOMETRIC_ACTION,
  WORKER_BIOMETRIC_EVIDENCE_VERSION,
  WORKER_BIOMETRIC_MODEL_VERSION
} from '../src/services/workerBiometricService.js';

const ENV = { ATTENDANCE_BIOMETRIC_SECRET: 'face-presence-test-secret-1234567890abcdef' };
const NOW = new Date('2026-10-01T16:00:00.000Z');

function descriptor(seed = 1) {
  return Array.from({ length: 64 }, (_, index) => ((index + seed) % 17 + 1) / 20);
}

function prismaHarness(initialEvents = []) {
  const events = [...initialEvents];
  return {
    events,
    devAuditEvent: {
      async findFirst({ where }) {
        if (where?.metadata?.path?.[0]) {
          const key = where.metadata.path[0];
          return events.find((event) => (
            event.entityType === where.entityType
            && event.action === where.action
            && event.entityId !== where.entityId?.not
            && event.metadata?.[key] === where.metadata.equals
          )) || null;
        }
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

function challenge(idempotencyKey = 'presence-attempt-123456', now = NOW) {
  return issueWorkerFacePresenceChallenge({
    workerId: 'worker-1',
    assignmentId: 'assignment-1',
    idempotencyKey,
    markType: 'BREAK_START'
  }, { now, env: ENV, randomIndex: 0 });
}

function inputFor(challengeValue, idempotencyKey = 'presence-attempt-123456') {
  const first = descriptor(1);
  const second = descriptor(9);
  return {
    workerId: 'worker-1',
    assignmentId: 'assignment-1',
    idempotencyKey,
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
    sampleRealScores: [0.91, 0.88],
    sampleLiveScores: [0.93, 0.89]
  };
}

test('estado de presencia no exige enrolamiento facial previo', () => {
  const status = workerFacePresenceStatus();
  assert.equal(status.enrolled, true);
  assert.equal(status.presenceOnly, true);
  assert.equal(status.evidenceVersion, WORKER_BIOMETRIC_EVIDENCE_VERSION);
});

test('presencia facial acepta un rostro vivo sin comparar identidad ni plantilla guardada', async () => {
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

test('presencia facial rechaza evidencia con señales de vida insuficientes sin convertirlo en mismatch de identidad', async () => {
  const prisma = prismaHarness();
  const issued = challenge();
  const input = inputFor(issued);
  input.sampleRealScores = [0.91, 0.88];
  input.sampleLiveScores = [0.2, 0.3];

  const assessment = await assessWorkerFacePresence(prisma, input, { now: NOW, env: ENV });
  assert.equal(assessment.verified, false);
  assert.ok(assessment.riskFlags.includes('BIOMETRIC_LIVENESS_LOW'));
  assert.equal(assessment.riskFlags.includes('BIOMETRIC_FACE_MISMATCH'), false);
});

test('presencia facial rechaza reutilizar exactamente la misma captura en otro intento', async () => {
  const prisma = prismaHarness();
  const firstChallenge = challenge('presence-attempt-123456', NOW);
  const first = await assessWorkerFacePresence(prisma, inputFor(firstChallenge, 'presence-attempt-123456'), { now: NOW, env: ENV });
  assert.equal(first.verified, true);

  const later = new Date(NOW.getTime() + 10_000);
  const secondChallenge = challenge('presence-attempt-654321', later);
  const second = await assessWorkerFacePresence(prisma, inputFor(secondChallenge, 'presence-attempt-654321'), { now: later, env: ENV });
  assert.equal(second.verified, false);
  assert.ok(second.riskFlags.includes('BIOMETRIC_DESCRIPTOR_REPLAY'));
});

test('presencia facial sigue rechazando evidencia sin un descriptor facial válido', async () => {
  const prisma = prismaHarness();
  const issued = challenge();
  const input = inputFor(issued);
  input.sampleDescriptors = [[]];
  input.sampleRealScores = [0.9];
  input.sampleLiveScores = [0.9];

  await assert.rejects(
    assessWorkerFacePresence(prisma, input, { now: NOW, env: ENV }),
    /attendance_biometric_descriptor_invalid/
  );
});

test('constantes de auditoría del flujo de presencia permanecen compatibles con el guard de asistencia', () => {
  assert.equal(ATTENDANCE_BIOMETRIC_ENTITY_TYPE, 'DISPATCH_ATTENDANCE_BIOMETRIC');
  assert.equal(WORKER_BIOMETRIC_ACTION.ASSESSED, 'BIOMETRIC_ASSESSED');
});
