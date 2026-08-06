import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import {
  APPLICATION_INTEREST_PENDING_MODE,
  dataConsentGateMiddleware,
  evaluateProfileDataEvidence
} from '../src/services/dataConsentGate.js';
import { captureConsentedProfileData } from '../src/services/consentProfileCapture.js';

const originalAxiosPost = axios.post;
after(() => {
  axios.post = originalAxiosPost;
});

function textMessage(body, id = 'TEST-RC-WAMID') {
  return { id, from: 'TEST-RC-PHONE', type: 'text', text: { body } };
}

function buildHarness({ candidateOverrides = {}, persistedInboundIds = [] } = {}) {
  let candidate = {
    id: 'TEST-RC-CANDIDATE',
    phone: 'TEST-RC-PHONE',
    status: 'NUEVO',
    dataConsentStatus: 'PENDING',
    currentStep: 'GREETING_SENT',
    vacancyId: 'TEST-RC-VACANCY',
    botResumeMode: APPLICATION_INTEREST_PENDING_MODE,
    botPaused: false,
    ...candidateOverrides
  };
  const inboundIds = new Set(persistedInboundIds);
  const inboundRows = [];
  const outboundRows = [];
  const candidateUpdates = [];
  const providerOutbound = [];

  axios.post = async (_url, payload) => {
    providerOutbound.push(payload?.text?.body || '');
    return { data: { messages: [{ id: 'TEST-RC-OUTBOUND' }] } };
  };

  const prisma = {
    candidate: {
      upsert: async () => structuredClone(candidate),
      findUnique: async () => structuredClone(candidate),
      update: async ({ data }) => {
        candidateUpdates.push(structuredClone(data));
        candidate = { ...candidate, ...structuredClone(data) };
        return structuredClone(candidate);
      },
      updateMany: async () => ({ count: 1 })
    },
    message: {
      findFirst: async ({ where }) => inboundIds.has(where.waMessageId)
        ? { id: `TEST-${where.waMessageId}`, waMessageId: where.waMessageId }
        : null,
      createMany: async ({ data }) => {
        const row = structuredClone(data[0]);
        if (inboundIds.has(row.waMessageId)) return { count: 0 };
        inboundIds.add(row.waMessageId);
        inboundRows.push(row);
        return { count: 1 };
      },
      create: async ({ data }) => {
        outboundRows.push(structuredClone(data));
        return { id: 'TEST-RC-OUTBOUND-ROW', ...data };
      }
    },
    vacancy: {
      findUnique: async () => ({
        id: 'TEST-RC-VACANCY',
        title: 'Cargo de Prueba',
        city: 'Neiva',
        isActive: true,
        acceptingApplications: true,
        operation: { city: { name: 'Neiva' } }
      })
    },
    candidateDataConsentEvent: { create: async () => ({ id: 'TEST-RC-CONSENT-EVENT' }) },
    interviewBooking: { updateMany: async () => ({ count: 0 }) }
  };

  return {
    prisma,
    inboundRows,
    outboundRows,
    providerOutbound,
    candidateUpdates,
    getCandidate: () => structuredClone(candidate)
  };
}

async function runMiddleware(harness, body, id = 'TEST-RC-WAMID') {
  const req = {
    body: { entry: [{ changes: [{ value: { messages: [textMessage(body, id)] } }] }] },
    headers: {},
    ip: '127.0.0.1'
  };
  const observed = { nextCalls: 0, statuses: [] };
  const res = { sendStatus: (status) => observed.statuses.push(status) };
  await dataConsentGateMiddleware(harness.prisma)(req, res, () => { observed.nextCalls += 1; });
  return observed;
}

const positiveEvidenceCases = [
  ['TEST-RC-DOCUMENT-ISOLATED', '100000001', ['documentNumber']],
  ['TEST-RC-MEDICAL', 'Tengo una restricción médica de prueba', ['medicalRestrictions']],
  ['TEST-RC-EXPERIENCE', 'Tengo 2 años de experiencia en logística', ['experienceInfo', 'experienceTime', 'experienceSummary']]
];

for (const [id, body, expectedFields] of positiveEvidenceCases) {
  test(`${id}: los datos protegidos del inbound actual se reconocen antes del consentimiento`, () => {
    const result = evaluateProfileDataEvidence(body, {
      candidate: { vacancyId: 'TEST-RC-VACANCY', currentStep: 'GREETING_SENT' }
    });
    assert.equal(result.containsProfileData, true);
    for (const field of expectedFields) {
      assert.ok(result.evidence.some((item) => item.field === field), `${id}: falta evidencia para ${field}`);
    }
    for (const evidence of result.evidence) {
      assert.equal(evidence.source, 'CURRENT_INBOUND_EXPLICIT');
      assert.ok(evidence.fragment);
    }
  });
}

test('TEST-RC-DOCUMENT-QUESTION: una pregunta sobre documentos no contiene documento personal', () => {
  const result = evaluateProfileDataEvidence('¿Qué documentos son 2 copias?', {
    candidate: { vacancyId: 'TEST-RC-VACANCY', currentStep: 'GREETING_SENT' }
  });
  assert.equal(result.containsProfileData, false);
  assert.deepEqual(result.evidence, []);
});

test('TEST-RC-NAME-STRUCTURE: profesión larga y rasgos consecutivos no son nombre', () => {
  for (const body of [
    'Administrador Logístico de Operaciones',
    'Responsable puntual comprometido organizado',
    'Trabajo como coordinador de despachos y almacenamiento'
  ]) {
    const result = evaluateProfileDataEvidence(body, {
      candidate: { vacancyId: 'TEST-RC-VACANCY', currentStep: 'GREETING_SENT' }
    });
    assert.equal(result.evidence.some((item) => item.field === 'fullName'), false, body);
  }
});

test('TEST-RC-LOCATION-STRUCTURE: un nombre explícito no se propone también como residencia', () => {
  const result = evaluateProfileDataEvidence('Me llamo Nombre de Prueba');
  assert.deepEqual(result.evidence.map((item) => item.field), ['fullName']);
});

test('TEST-RC-CANONICAL-WRITER: la captura canónica falla cerrada sin consentimiento ACCEPTED', async () => {
  const updates = [];
  const candidate = {
    id: 'TEST-RC-CANDIDATE',
    dataConsentStatus: 'PENDING',
    fullName: null,
    documentNumber: null,
    age: null
  };
  const result = await captureConsentedProfileData({
    prisma: {
      candidate: {
        update: async ({ data }) => {
          updates.push(structuredClone(data));
          return { ...candidate, ...data };
        }
      }
    },
    candidate,
    currentText: 'Me llamo Nombre de Prueba, mi cédula es TEST-100000001 y tengo 30 años'
  });

  assert.deepEqual(updates, []);
  assert.equal(result.reason, 'consent_not_accepted');
  assert.deepEqual(result.capturedFields, []);
});

test('TEST-RC-PAUSED-DATA: un dato personal durante pausa se adquiere sin reanudar ni responder', async () => {
  const harness = buildHarness({
    candidateOverrides: {
      botPaused: true,
      botPauseReason: 'Intervención humana de prueba',
      dataConsentStatus: 'PENDING'
    }
  });
  const observed = await runMiddleware(harness, 'Mi cédula es TEST-100000001', 'TEST-RC-PAUSED-DATA');

  assert.equal(observed.nextCalls, 0);
  assert.deepEqual(observed.statuses, [200]);
  assert.equal(harness.inboundRows.length, 1);
  assert.equal(harness.providerOutbound.length, 0);
  assert.equal(harness.outboundRows.length, 0);
  assert.equal(harness.getCandidate().botPaused, true);
  assert.equal(harness.candidateUpdates.length, 0);
});

test('TEST-RC-PRECONSENT-RAW: deduplicar no persiste texto personal crudo', async () => {
  const harness = buildHarness();
  const observed = await runMiddleware(harness, 'Mi cédula es TEST-100000001', 'TEST-RC-RAW-BODY');

  assert.equal(observed.nextCalls, 0);
  assert.deepEqual(observed.statuses, [200]);
  assert.equal(harness.inboundRows.length, 1);
  assert.equal(harness.inboundRows[0].waMessageId, 'TEST-RC-RAW-BODY');
  assert.ok(harness.inboundRows[0].body === null || harness.inboundRows[0].body === '[REDACTED_PRECONSENT]');
  assert.doesNotMatch(JSON.stringify(harness.inboundRows[0].rawPayload || {}), /TEST-100000001/);
  assert.equal(harness.providerOutbound.length, 1);
});

test('TEST-RC-PRECONSENT-IDEMPOTENCY: el mismo webhook produce una sola adquisición y una sola respuesta', async () => {
  const harness = buildHarness();
  const first = await runMiddleware(harness, 'Mi cédula es TEST-100000001', 'TEST-RC-IDEMPOTENT');
  const retry = await runMiddleware(harness, 'Mi cédula es TEST-100000001', 'TEST-RC-IDEMPOTENT');

  assert.deepEqual(first.statuses, [200]);
  assert.deepEqual(retry.statuses, [200]);
  assert.equal(harness.inboundRows.length, 1);
  assert.equal(harness.providerOutbound.length, 1);
});
