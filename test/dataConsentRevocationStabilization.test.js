import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import './dataConsentHumanPauseReplay.test.js';
import './preConsentDataEvidence.test.js';
import {
  dataConsentGateMiddleware,
  evaluateConsentBoundary
} from '../src/services/dataConsentGate.js';
import { CONSENT_REVOCATION_STABILIZATION_REPLAYS } from './conversation-replay/consentRevocationStabilizationReplay.js';

const originalAxiosPost = axios.post;
after(() => {
  axios.post = originalAxiosPost;
});

function textMessage(body, id = 'TEST-WAMID-REVOCATION') {
  return {
    id,
    from: 'TEST-PHONE-REVOCATION',
    type: 'text',
    text: { body }
  };
}

function webhookPayload(message) {
  return {
    entry: [{ changes: [{ value: { messages: [structuredClone(message)] } }] }]
  };
}

function acceptedCandidate(overrides = {}) {
  return {
    id: 'TEST-CANDIDATE-REVOCATION',
    phone: 'TEST-PHONE-REVOCATION',
    status: 'NUEVO',
    dataConsentStatus: 'ACCEPTED',
    currentStep: 'SCHEDULED',
    vacancyId: 'TEST-VACANCY-REVOCATION',
    botResumeMode: null,
    botPaused: false,
    botPausedAt: null,
    botPausedBy: null,
    botPauseReason: null,
    reminderState: 'SCHEDULED',
    reminderScheduledFor: new Date('2026-08-05T15:00:00.000Z'),
    ...overrides
  };
}

function buildHarness(initialCandidate) {
  let candidate = structuredClone(initialCandidate);
  const inboundIds = new Set();
  const metrics = {
    consentEvents: 0,
    outboundMessages: 0,
    bookingCancellations: 0,
    pauseResumes: 0,
    nextCalls: 0,
    statuses: []
  };

  axios.post = async () => ({ data: { messages: [{ id: 'TEST-OUTBOUND-REVOCATION' }] } });

  const prisma = {
    candidate: {
      upsert: async () => structuredClone(candidate),
      findUnique: async () => structuredClone(candidate),
      updateMany: async ({ data }) => {
        if (Object.hasOwn(data, 'botPaused') && data.botPaused === false) metrics.pauseResumes += 1;
        candidate = { ...candidate, ...structuredClone(data) };
        return { count: 1 };
      },
      update: async ({ data }) => {
        candidate = { ...candidate, ...structuredClone(data) };
        return structuredClone(candidate);
      }
    },
    candidateDataConsentEvent: {
      create: async ({ data }) => {
        metrics.consentEvents += 1;
        return { id: 'TEST-CONSENT-EVENT', ...structuredClone(data) };
      }
    },
    message: {
      findFirst: async ({ where }) => inboundIds.has(where.waMessageId)
        ? { id: `TEST-MESSAGE-${where.waMessageId}`, waMessageId: where.waMessageId, respondedAt: null, createdAt: new Date() }
        : null,
      createMany: async ({ data }) => {
        const id = data[0]?.waMessageId;
        if (inboundIds.has(id)) return { count: 0 };
        inboundIds.add(id);
        return { count: 1 };
      },
      create: async ({ data }) => {
        metrics.outboundMessages += 1;
        return { id: 'TEST-OUTBOUND-MESSAGE', ...structuredClone(data) };
      }
    },
    vacancy: {
      findUnique: async () => ({
        id: 'TEST-VACANCY-REVOCATION',
        title: 'Auxiliar de Operación',
        city: 'Neiva',
        isActive: true,
        acceptingApplications: true,
        operation: { city: { name: 'Neiva' } }
      })
    },
    interviewBooking: {
      updateMany: async () => {
        metrics.bookingCancellations += 1;
        return { count: 1 };
      }
    }
  };

  return {
    prisma,
    metrics,
    getCandidate: () => structuredClone(candidate),
    inboundIds
  };
}

async function runMiddleware(harness, candidate, message) {
  const middleware = dataConsentGateMiddleware(harness.prisma);
  const req = { body: webhookPayload(message), headers: {}, ip: '127.0.0.1' };
  const res = {
    sendStatus(status) {
      harness.metrics.statuses.push(status);
      return status;
    }
  };
  await middleware(req, res, () => {
    harness.metrics.nextCalls += 1;
  });
  return harness.getCandidate();
}

test('revocación: preguntas de derechos, órdenes, rechazos y mensajes ordinarios quedan separados', () => {
  const candidate = acceptedCandidate({ currentStep: 'COLLECTING_DATA' });
  for (const replay of CONSENT_REVOCATION_STABILIZATION_REPLAYS) {
    assert.deepEqual(
      evaluateConsentBoundary(candidate, textMessage(replay.body, `TEST-${replay.id}`)),
      replay.expectedBoundary,
      replay.id
    );
  }
});

test('revocación: tiene prioridad sobre confirmación de vacante de campaña y cancela automatizaciones', async () => {
  const candidate = acceptedCandidate({
    botResumeMode: 'campaign_vacancy_pending_confirmation'
  });
  const harness = buildHarness(candidate);
  const finalCandidate = await runMiddleware(
    harness,
    candidate,
    textMessage('Solicito la revocatoria de esta autorización.', 'TEST-WAMID-CAMPAIGN-REVOCATION')
  );

  assert.equal(finalCandidate.dataConsentStatus, 'REVOKED');
  assert.equal(finalCandidate.currentStep, 'DONE');
  assert.equal(finalCandidate.reminderState, 'CANCELLED');
  assert.equal(finalCandidate.reminderScheduledFor, null);
  assert.equal(harness.metrics.consentEvents, 1);
  assert.equal(harness.metrics.bookingCancellations, 1);
  assert.equal(harness.metrics.outboundMessages, 1);
  assert.equal(harness.metrics.nextCalls, 0);
});

test('revocación: se procesa durante una pausa humana sin levantarla', async () => {
  const candidate = acceptedCandidate({
    botPaused: true,
    botPausedAt: new Date('2026-08-05T12:00:00.000Z'),
    botPausedBy: 'TEST-RECRUITER',
    botPauseReason: 'Intervención humana activa',
    botResumeMode: 'manual_outbound_sending'
  });
  const harness = buildHarness(candidate);
  const finalCandidate = await runMiddleware(
    harness,
    candidate,
    textMessage('No doy permiso para usar mis datos.', 'TEST-WAMID-PAUSED-REVOCATION')
  );

  assert.equal(finalCandidate.dataConsentStatus, 'REVOKED');
  assert.equal(finalCandidate.botPaused, true);
  assert.equal(harness.metrics.pauseResumes, 0);
  assert.equal(harness.metrics.consentEvents, 1);
  assert.equal(harness.metrics.outboundMessages, 1);
  assert.equal(harness.metrics.nextCalls, 0);
});

test('revocación: el mismo webhook no crea otro evento, cancelación ni respuesta', async () => {
  const candidate = acceptedCandidate({ currentStep: 'COLLECTING_DATA' });
  const harness = buildHarness(candidate);
  const message = textMessage(
    'Quiero retirar mi autorización y detener el proceso.',
    'TEST-WAMID-REVOCATION-IDEMPOTENT'
  );

  await runMiddleware(harness, candidate, message);
  await runMiddleware(harness, harness.getCandidate(), message);

  assert.equal(harness.inboundIds.size, 1);
  assert.equal(harness.metrics.consentEvents, 1);
  assert.equal(harness.metrics.bookingCancellations, 1);
  assert.equal(harness.metrics.outboundMessages, 1);
  assert.equal(harness.metrics.nextCalls, 0);
});
