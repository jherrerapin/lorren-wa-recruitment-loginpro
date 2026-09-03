import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import {
  APPLICATION_INTEREST_PENDING_MODE,
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
    reason: 'candidate_wants_to_continue'
  });

  const harness = createHarness(candidate, vacancy);
  const observed = await runMiddleware(harness, message);
  const finalCandidate = harness.getCandidate();

  assert.equal(observed.nextCalls, 0);
  assert.equal(harness.sentBodies.length, 1);
  assert.match(harness.sentBodies[0], /Autorizo a LoginPro/i);
  assert.doesNotMatch(
    harness.sentBodies[0],
    /compárteme (?:tu )?(?:nombre|documento|edad)|nombre completo[:?]|(?:cuál|cual) es tu edad/i
  );
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

test('un sí corto en una etapa adelantada abre consentimiento y nunca vuelve a pedir interés', async () => {
  const candidate = {
    id: 'TEST-CANDIDATE-RECOVERY-SHORT-YES',
    phone: 'TEST-PHONE-RECOVERY-SHORT-YES',
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
    id: 'TEST-WAMID-RECOVERY-SHORT-YES',
    from: candidate.phone,
    type: 'text',
    text: { body: 'Siii' }
  };

  assert.equal(shouldRequestConsentForTurn(candidate, message.text.body).allowed, true);
  assert.deepEqual(evaluateConsentBoundary(candidate, message), {
    block: true,
    reason: 'candidate_wants_to_continue'
  });

  const harness = createHarness(candidate, vacancy);
  const observed = await runMiddleware(harness, message);

  assert.equal(observed.nextCalls, 0);
  assert.equal(observed.remainingMessages, 0);
  assert.equal(harness.sentBodies.length, 1);
  assert.match(harness.sentBodies[0], /Autorizo a LoginPro/i);
  assert.doesNotMatch(harness.sentBodies[0], /confírmame si deseas postularte/i);
  assert.equal(harness.getCandidate().botResumeMode, 'awaiting_data_consent');
});

test('un lote con interés y texto consecutivo queda íntegramente dentro del gate de consentimiento', async () => {
  const candidate = {
    id: 'TEST-CANDIDATE-RECOVERY-BATCH',
    phone: 'TEST-PHONE-RECOVERY-BATCH',
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
  const messages = [
    {
      id: 'TEST-WAMID-RECOVERY-BATCH-1',
      from: candidate.phone,
      type: 'text',
      text: { body: 'Siii' }
    },
    {
      id: 'TEST-WAMID-RECOVERY-BATCH-2',
      from: candidate.phone,
      type: 'text',
      text: { body: 'Zona de operación de prueba' }
    }
  ];
  const harness = createHarness(candidate, vacancy);
  const req = {
    body: {
      entry: [{ changes: [{ value: { messages: structuredClone(messages) } }] }]
    },
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

  await dataConsentGateMiddleware(harness.prisma)(req, res, () => {
    observed.nextCalls += 1;
  });

  assert.equal(observed.nextCalls, 0);
  assert.deepEqual(observed.statuses, [200]);
  assert.equal(req.body.entry[0].changes[0].value.messages.length, 0);
  assert.equal(harness.sentBodies.length, 1);
  assert.match(harness.sentBodies[0], /Autorizo a LoginPro/i);
  assert.equal(harness.getCandidate().botResumeMode, 'awaiting_data_consent');
});

test('mientras espera interés una respuesta no interrogativa no puede escapar al recolector', () => {
  const candidate = {
    id: 'TEST-CANDIDATE-RECOVERY-INTEREST-PENDING',
    phone: 'TEST-PHONE-RECOVERY-INTEREST-PENDING',
    vacancyId: 'TEST-VACANCY-RECOVERY',
    dataConsentStatus: 'PENDING',
    currentStep: 'GREETING_SENT',
    botResumeMode: APPLICATION_INTEREST_PENDING_MODE,
    botPaused: false
  };
  const message = {
    id: 'TEST-WAMID-RECOVERY-DOC-TYPE',
    from: candidate.phone,
    type: 'text',
    text: { body: 'Cédula de ciudadanía' }
  };

  assert.deepEqual(evaluateConsentBoundary(candidate, message), {
    block: true,
    reason: 'application_interest_pending'
  });
});
