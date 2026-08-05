import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import {
  dataConsentGateMiddleware,
  evaluateConsentBoundary,
  shouldRequestConsentForTurn
} from '../src/services/dataConsentGate.js';

const originalAxiosPost = axios.post;
after(() => {
  axios.post = originalAxiosPost;
});

function payload(message) {
  return {
    entry: [{
      changes: [{ value: { messages: [structuredClone(message)] } }]
    }]
  };
}

function createHarness(initialCandidate, vacancy = null) {
  let candidate = structuredClone(initialCandidate);
  const sentBodies = [];
  const updates = [];

  axios.post = async (_url, requestBody) => {
    sentBodies.push(requestBody?.text?.body || '');
    return { data: { messages: [{ id: 'TEST-OUTBOUND-RECOVERY' }] } };
  };

  const prisma = {
    candidate: {
      upsert: async () => structuredClone(candidate),
      update: async ({ data }) => {
        updates.push(structuredClone(data));
        candidate = { ...candidate, ...structuredClone(data) };
        return structuredClone(candidate);
      },
      updateMany: async ({ data }) => {
        updates.push(structuredClone(data));
        candidate = { ...candidate, ...structuredClone(data) };
        return { count: 1 };
      },
      findUnique: async () => structuredClone(candidate)
    },
    vacancy: {
      findUnique: async ({ where }) => vacancy?.id === where.id ? structuredClone(vacancy) : null
    },
    message: {
      findFirst: async () => null,
      createMany: async () => ({ count: 1 }),
      create: async ({ data }) => ({ id: 'TEST-MESSAGE-RECOVERY', ...structuredClone(data) })
    }
  };

  return {
    prisma,
    sentBodies,
    updates,
    getCandidate: () => structuredClone(candidate)
  };
}

async function runMiddleware(harness, message) {
  const middleware = dataConsentGateMiddleware(harness.prisma);
  const req = { body: payload(message), headers: {}, ip: '127.0.0.1' };
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
    ...observed,
    remainingMessages: req.body.entry[0].changes[0].value.messages.length
  };
}

test('un interés explícito recupera una etapa heredada adelantada sin volver a pedir datos', async () => {
  const candidate = {
    id: 'TEST-CANDIDATE-RECOVERY-INTEREST',
    phone: 'TEST-PHONE-RECOVERY-INTEREST',
    vacancyId: 'TEST-VACANCY-RECOVERY',
    dataConsentStatus: 'PENDING',
    currentStep: 'COLLECTING_DATA',
    botResumeMode: null,
    botPaused: false
  };
  const vacancy = {
    id: 'TEST-VACANCY-RECOVERY',
    title: 'Auxiliar de Operación',
    city: 'Neiva',
    isActive: true,
    acceptingApplications: true,
    operation: { city: { name: 'Neiva' } }
  };
  const message = {
    id: 'TEST-WAMID-RECOVERY-INTEREST',
    from: candidate.phone,
    type: 'text',
    text: { body: 'Quiero postularme y continuar con el proceso.' }
  };

  assert.equal(shouldRequestConsentForTurn(candidate, message.text.body).allowed, true);
  assert.deepEqual(evaluateConsentBoundary(candidate, message), {
    block: true,
    reason: 'protected_step_without_consent'
  });

  const harness = createHarness(candidate, vacancy);
  const observed = await runMiddleware(harness, message);
  const finalCandidate = harness.getCandidate();

  assert.equal(observed.nextCalls, 0);
  assert.equal(harness.sentBodies.length, 1);
  assert.match(harness.sentBodies[0], /Autorizo a LoginPro/i);
  assert.doesNotMatch(harness.sentBodies[0], /compárteme|nombre completo|documento|edad/i);
  assert.equal(finalCandidate.botResumeMode, 'awaiting_data_consent');
});

test('una etapa protegida sin vacante se recupera y conserva el mismo mensaje para el resolvedor', async () => {
  const candidate = {
    id: 'TEST-CANDIDATE-RECOVERY-VACANCY',
    phone: 'TEST-PHONE-RECOVERY-VACANCY',
    vacancyId: null,
    dataConsentStatus: 'PENDING',
    currentStep: 'COLLECTING_DATA',
    botResumeMode: null,
    botPaused: false
  };
  const message = {
    id: 'TEST-WAMID-RECOVERY-VACANCY',
    from: candidate.phone,
    type: 'text',
    text: { body: 'Busco la vacante de auxiliar de bodega en Neiva.' }
  };

  const harness = createHarness(candidate);
  const observed = await runMiddleware(harness, message);
  const finalCandidate = harness.getCandidate();

  assert.equal(observed.nextCalls, 1);
  assert.equal(observed.remainingMessages, 1);
  assert.equal(harness.sentBodies.length, 0);
  assert.equal(finalCandidate.currentStep, 'GREETING_SENT');
  assert.equal(finalCandidate.botResumeMode, null);

  assert.deepEqual(evaluateConsentBoundary(finalCandidate, {
    ...message,
    id: 'TEST-WAMID-RECOVERY-VACANCY-NEXT'
  }), {
    block: false,
    reason: 'consent_not_required_for_this_turn'
  });
});
