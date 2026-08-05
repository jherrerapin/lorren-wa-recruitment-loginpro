import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import {
  dataConsentGateMiddleware,
  deriveConsentResumeUpdate,
  evaluateConsentBoundary,
  parseConsentPendingMode
} from '../src/services/dataConsentGate.js';
import { CONSENT_ORDER_REPLAYS } from './conversation-replay/consentOrderReplay.js';

const originalAxiosPost = axios.post;
after(() => {
  axios.post = originalAxiosPost;
});

function webhookPayload(message) {
  return {
    entry: [{
      changes: [{
        value: { messages: [structuredClone(message)] }
      }]
    }]
  };
}

function createHarness(replay) {
  let candidate = structuredClone(replay.candidate);
  const sentBodies = [];
  const outboundRecords = [];
  const candidateUpdates = [];
  const vacancy = {
    id: 'vacancy-consent-order',
    title: 'Líder de Operación',
    role: 'Líder de Operación',
    city: 'Neiva',
    isActive: true,
    acceptingApplications: true,
    conditions: 'Salario y horario registrados por la vacante',
    requirements: 'Experiencia relacionada',
    roleDescription: 'Apoyar la operación asignada',
    operationAddress: 'Zona de prueba',
    requiredDocuments: null,
    operation: { city: { name: 'Neiva' } }
  };

  axios.post = async (_url, payload) => {
    sentBodies.push(payload?.text?.body || '');
    return { data: { messages: [{ id: 'TEST-OUTBOUND-ID' }] } };
  };

  const prisma = {
    candidate: {
      upsert: async () => structuredClone(candidate),
      update: async ({ data }) => {
        candidateUpdates.push(structuredClone(data));
        candidate = { ...candidate, ...structuredClone(data) };
        return structuredClone(candidate);
      },
      updateMany: async ({ data }) => {
        candidateUpdates.push(structuredClone(data));
        candidate = { ...candidate, ...structuredClone(data) };
        return { count: 1 };
      },
      findUnique: async () => structuredClone(candidate)
    },
    vacancy: {
      findUnique: async ({ where }) => where.id === vacancy.id ? structuredClone(vacancy) : null
    },
    message: {
      findFirst: async () => null,
      createMany: async () => ({ count: 1 }),
      create: async ({ data }) => {
        outboundRecords.push(structuredClone(data));
        return { id: `TEST-OUTBOUND-${outboundRecords.length}`, ...structuredClone(data) };
      }
    }
  };

  return {
    prisma,
    sentBodies,
    outboundRecords,
    candidateUpdates,
    getCandidate: () => structuredClone(candidate)
  };
}

async function executeReplay(replay) {
  const harness = createHarness(replay);
  const middleware = dataConsentGateMiddleware(harness.prisma);
  const req = {
    body: webhookPayload(replay.inbound),
    headers: {},
    ip: '127.0.0.1'
  };
  const observed = { nextCalls: 0, statuses: [] };
  const res = {
    sendStatus(status) {
      observed.statuses.push(status);
      return status;
    }
  };

  await middleware(req, res, () => {
    observed.nextCalls += 1;
  });

  return {
    ...harness,
    ...observed,
    remainingMessages: req.body.entry[0].changes[0].value.messages.length
  };
}

function assertTextIncludes(body, expected = []) {
  for (const fragment of expected) assert.match(body, new RegExp(fragment, 'i'));
}

function assertTextExcludes(body, expected = []) {
  for (const fragment of expected) assert.doesNotMatch(body, new RegExp(fragment, 'i'));
}

test('replays de orden: saludos y preguntas de vacante no equivalen a interés explícito', async () => {
  for (const id of [
    'conv-004-greeting-without-consent-v1',
    'conv-034-salary-question-without-consent-v1',
    'conv-065-schedule-question-without-consent-v1'
  ]) {
    const replay = CONSENT_ORDER_REPLAYS.find((item) => item.id === id);
    const decision = evaluateConsentBoundary(replay.candidate, replay.inbound);
    assert.deepEqual(decision, {
      block: replay.expected.gateBlock,
      reason: replay.expected.reason
    }, replay.id);

    const observed = await executeReplay(replay);
    assert.equal(observed.sentBodies.length, replay.expected.outboundCount, replay.id);
    assert.equal(observed.nextCalls, replay.expected.nextCalls, replay.id);
  }
});

test('replay CONV-062: confirmar vacante informa y pregunta interés antes del consentimiento', async () => {
  const replay = CONSENT_ORDER_REPLAYS.find((item) => item.id === 'conv-062-vacancy-confirmation-before-consent-v1');
  const observed = await executeReplay(replay);
  const finalCandidate = observed.getCandidate();
  const body = observed.sentBodies.join('\n');

  assert.equal(observed.sentBodies.length, replay.expected.outboundCount);
  assert.equal(observed.nextCalls, replay.expected.nextCalls);
  assertTextIncludes(body, replay.expected.includes);
  assertTextExcludes(body, replay.expected.excludes);
  assert.equal(finalCandidate.currentStep, replay.expected.finalStep);
  assert.equal(finalCandidate.botResumeMode, replay.expected.finalResumeMode);
});

test('replay CONV-039: interés explícito activa una única solicitud de consentimiento', async () => {
  const replay = CONSENT_ORDER_REPLAYS.find((item) => item.id === 'conv-039-explicit-interest-prompts-once-v1');
  const decision = evaluateConsentBoundary(replay.candidate, replay.inbound);
  const observed = await executeReplay(replay);
  const finalCandidate = observed.getCandidate();

  assert.deepEqual(decision, { block: true, reason: replay.expected.reason });
  assert.equal(observed.sentBodies.length, replay.expected.outboundCount);
  assert.equal(observed.outboundRecords.length, replay.expected.outboundCount);
  assert.equal(observed.nextCalls, replay.expected.nextCalls);
  assertTextIncludes(observed.sentBodies[0], replay.expected.includes);
  assert.equal(finalCandidate.botResumeMode, replay.expected.finalResumeMode);
});

test('autorización aceptada pasa al router y rechazo o revocación persistidos no reabren el consentimiento', async () => {
  for (const id of [
    'accepted-consent-is-not-requested-again-v1',
    'rejected-consent-is-not-requested-again-v1',
    'conv-007-revoked-consent-is-not-requested-again-v1'
  ]) {
    const replay = CONSENT_ORDER_REPLAYS.find((item) => item.id === id);
    const decision = evaluateConsentBoundary(replay.candidate, replay.inbound);
    const observed = await executeReplay(replay);

    assert.deepEqual(decision, {
      block: replay.expected.gateBlock,
      reason: replay.expected.reason
    }, replay.id);
    assert.equal(observed.sentBodies.length, replay.expected.outboundCount, replay.id);
    assert.equal(observed.nextCalls, replay.expected.nextCalls, replay.id);
  }
});

test('pregunta durante consentimiento: responde primero y conserva el punto pendiente', async () => {
  const replay = CONSENT_ORDER_REPLAYS.find((item) => item.id === 'question-during-consent-is-answered-v1');
  const decision = evaluateConsentBoundary(replay.candidate, replay.inbound);
  const observed = await executeReplay(replay);
  const body = observed.sentBodies[0];
  const firstIndex = body.indexOf(replay.expected.includesInOrder[0]);
  const secondIndex = body.indexOf(replay.expected.includesInOrder[1]);

  assert.deepEqual(decision, { block: true, reason: replay.expected.reason });
  assert.equal(observed.sentBodies.length, replay.expected.outboundCount);
  assert.equal(observed.nextCalls, replay.expected.nextCalls);
  assert.ok(firstIndex >= 0);
  assert.ok(secondIndex > firstIndex);
  assert.equal(observed.getCandidate().botResumeMode, replay.expected.finalResumeMode);
});

test('después de la aclaración el contexto pendiente reanuda la recolección, no la vacante ni el saludo', () => {
  const replay = CONSENT_ORDER_REPLAYS.find((item) => item.id === 'consent-answer-resumes-pending-context-v1');
  const context = parseConsentPendingMode(replay.candidate.botResumeMode);
  const resume = deriveConsentResumeUpdate(context.resumeMode);

  assert.equal(context.pending, true);
  assert.equal(resume.currentStep, replay.expected.resumeStep);
  assert.equal(resume.botResumeMode, replay.expected.resumeMode);
});

test('replay CONV-008: un archivo sin interés explícito se bloquea sin pedir consentimiento', async () => {
  const replay = CONSENT_ORDER_REPLAYS.find((item) => item.id === 'conv-008-attachment-before-interest-v1');
  const decision = evaluateConsentBoundary(replay.candidate, replay.inbound);
  const observed = await executeReplay(replay);
  const finalCandidate = observed.getCandidate();
  const body = observed.sentBodies.join('\n');

  assert.deepEqual(decision, { block: true, reason: replay.expected.reason });
  assert.equal(observed.sentBodies.length, replay.expected.outboundCount);
  assert.equal(observed.nextCalls, replay.expected.nextCalls);
  assertTextIncludes(body, replay.expected.includes);
  assertTextExcludes(body, replay.expected.excludes);
  assert.equal(finalCandidate.currentStep, replay.expected.finalStep);
  assert.equal(finalCandidate.botResumeMode, replay.expected.finalResumeMode);
});
