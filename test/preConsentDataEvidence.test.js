import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import {
  APPLICATION_INTEREST_PENDING_MODE,
  dataConsentGateMiddleware,
  evaluateConsentBoundary,
  evaluateProfileDataEvidence
} from '../src/services/dataConsentGate.js';
import {
  PRE_CONSENT_DATA_EVIDENCE_INCOMPLETE,
  PRE_CONSENT_DATA_EVIDENCE_REPLAYS
} from './conversation-replay/preConsentDataEvidenceReplay.js';

const originalAxiosPost = axios.post;
after(() => {
  axios.post = originalAxiosPost;
});

function textMessage(body, id = 'TEST-WAMID-DATA-EVIDENCE') {
  return { id, from: 'TEST-PHONE-DATA-EVIDENCE', type: 'text', text: { body } };
}

function buildHarness({ candidateOverrides = {}, persistedInboundIds = [] } = {}) {
  let candidate = {
    id: 'TEST-CANDIDATE-DATA-EVIDENCE',
    phone: 'TEST-PHONE-DATA-EVIDENCE',
    status: 'NUEVO',
    dataConsentStatus: 'PENDING',
    currentStep: 'GREETING_SENT',
    vacancyId: 'TEST-VACANCY-DATA-EVIDENCE',
    botResumeMode: APPLICATION_INTEREST_PENDING_MODE,
    botPaused: false,
    fullName: 'Nombre Histórico de Prueba',
    neighborhood: 'Barrio Histórico de Prueba',
    ...candidateOverrides
  };
  const inboundIds = new Set(persistedInboundIds);
  const outbound = [];
  const candidateUpdates = [];

  axios.post = async (_url, payload) => {
    outbound.push(payload?.text?.body || '');
    return { data: { messages: [{ id: 'TEST-OUTBOUND-DATA-EVIDENCE' }] };
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
        const id = data[0]?.waMessageId;
        if (inboundIds.has(id)) return { count: 0 };
        inboundIds.add(id);
        return { count: 1 };
      },
      create: async ({ data }) => ({ id: 'TEST-OUTBOUND-ROW', ...data })
    },
    vacancy: {
      findUnique: async () => ({
        id: 'TEST-VACANCY-DATA-EVIDENCE',
        title: 'Cargo de Prueba',
        city: 'Neiva',
        isActive: true,
        acceptingApplications: true,
        operation: { city: { name: 'Neiva' } }
      })
    },
    candidateDataConsentEvent: { create: async () => ({ id: 'TEST-CONSENT-EVENT' }) },
    interviewBooking: { updateMany: async () => ({ count: 0 }) }
  };

  return { prisma, outbound, candidateUpdates, inboundIds, getCandidate: () => structuredClone(candidate) };
}

async function runMiddleware(harness, body, id = 'TEST-WAMID-DATA-EVIDENCE') {
  const middleware = dataConsentGateMiddleware(harness.prisma);
  const req = {
    body: { entry: [{ changes: [{ value: { messages: [textMessage(body, id)] } }] }] },
    headers: {},
    ip: '127.0.0.1'
  };
  const observed = { nextCalls: 0, statuses: [] };
  const res = { sendStatus: (status) => observed.statuses.push(status) };
  await middleware(req, res, () => { observed.nextCalls += 1; });
  return observed;
}

test('las 18 apariciones completas solo afirman datos cuando existe evidencia explícita del inbound actual', () => {
  const complete = PRE_CONSENT_DATA_EVIDENCE_REPLAYS.filter((item) => item.sourceConversation.startsWith('CONV-'));
  const candidateContext = {
    dataConsentStatus: 'PENDING',
    currentStep: 'GREETING_SENT',
    vacancyId: 'TEST-VACANCY-DATA-EVIDENCE'
  };
  assert.equal(complete.length, 18);

  for (const replay of complete) {
    const result = evaluateProfileDataEvidence(replay.body, { candidate: candidateContext });
    assert.equal(result.containsProfileData, false, replay.id);
    assert.deepEqual(result.evidence, [], replay.id);
    assert.notEqual(
      evaluateConsentBoundary(candidateContext, textMessage(replay.body)).reason,
      'profile_data_before_consent',
      replay.id
    );
  }
});

test('las cuatro apariciones sin inbound visible permanecen como evidencia insuficiente', () => {
  assert.deepEqual(PRE_CONSENT_DATA_EVIDENCE_INCOMPLETE, ['CONV-002', 'CONV-039', 'CONV-050', 'CONV-064']);
});

test('la autoridad estructurada separa negativos, ambiguos y datos explícitos', () => {
  for (const replay of PRE_CONSENT_DATA_EVIDENCE_REPLAYS) {
    const result = evaluateProfileDataEvidence(replay.body);
    assert.deepEqual(result.evidence.map((item) => item.field), replay.expectedFields, replay.id);
    assert.equal(result.containsProfileData, replay.expectedFields.length > 0, replay.id);
    for (const evidence of result.evidence) {
      assert.equal(evidence.source, 'CURRENT_INBOUND_EXPLICIT');
      assert.ok(evidence.confidence >= 0.95);
      assert.ok(evidence.rule);
    }
  }
});

test('un resultado ambiguo del modelo no puede convertir profesión en nombre ni experiencia en residencia', () => {
  const result = evaluateProfileDataEvidence('Trabajo en despachos', {
    parsedFields: {
      fullName: 'Trabajo En Despachos',
      neighborhood: 'Despachos'
    },
    sourceByField: {
      fullName: 'openai',
      neighborhood: 'openai'
    }
  });
  assert.equal(result.containsProfileData, false);
  assert.deepEqual(result.evidence, []);
});

test('datos históricos y metadata de campaña no justifican una afirmación sobre el turno actual', () => {
  const result = evaluateProfileDataEvidence('Hola', {
    candidate: { fullName: 'Nombre Histórico de Prueba', neighborhood: 'Barrio Histórico de Prueba' },
    campaignMetadata: { city: 'Neiva', role: 'Cargo de Prueba' }
  });
  assert.equal(result.containsProfileData, false);
  assert.deepEqual(result.evidence, []);
});

test('interés explícito solicita consentimiento una sola vez sin afirmar datos inexistentes', async () => {
  const harness = buildHarness();
  const first = await runMiddleware(harness, 'Estoy interesado en auxiliar de bodega', 'TEST-WAMID-INTEREST-ONCE');
  const retry = await runMiddleware(harness, 'Estoy interesado en auxiliar de bodega', 'TEST-WAMID-INTEREST-ONCE');

  assert.equal(first.nextCalls, 0);
  assert.deepEqual(first.statuses, [200]);
  assert.equal(harness.outbound.length, 1);
  assert.equal(retry.nextCalls, 0);
  assert.deepEqual(retry.statuses, [200]);
  assert.doesNotMatch(harness.outbound[0], /veo que compartiste|compartiste información/i);
  assert.match(harness.outbound[0], /autorización|autoriza/i);
  assert.equal(harness.candidateUpdates.some((update) => (
    Object.hasOwn(update, 'fullName')
    || Object.hasOwn(update, 'neighborhood')
    || Object.hasOwn(update, 'age')
    || Object.hasOwn(update, 'documentNumber')
  )), false);
});
