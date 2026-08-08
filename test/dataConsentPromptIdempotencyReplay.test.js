import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import {
  dataConsentGateMiddleware,
  parseConsentPendingMode
} from '../src/services/dataConsentGate.js';
import { CONSENT_PROMPT_IDEMPOTENCY_REPLAYS } from './conversation-replay/consentPromptIdempotencyReplay.js';

const originalAxiosPost = axios.post;
after(() => {
  axios.post = originalAxiosPost;
});

function webhookPayload(messages = []) {
  return {
    entry: [{
      changes: [{
        value: { messages: structuredClone(messages) }
      }]
    }]
  };
}

function createHarness(replay) {
  let candidate = structuredClone(replay.candidate);
  const claimedInboundIds = new Set();
  const sentBodies = [];
  const outboundRecords = [];
  const metrics = {
    inboundClaims: 0,
    candidateUpdates: 0
  };
  const vacancy = {
    id: 'TEST-VACANCY-CONSENT-IDEMPOTENCY',
    title: 'Auxiliar de Operación',
    role: 'Auxiliar de Operación',
    city: 'Neiva',
    roleDescription: 'Apoyar la operación asignada.',
    requirements: 'Experiencia relacionada.',
    conditions: 'Condiciones registradas para la vacante.',
    operationAddress: 'Zona de prueba.',
    requiredDocuments: null,
    isActive: true,
    acceptingApplications: true,
    operation: { city: { name: 'Neiva' } }
  };

  axios.post = async (_url, requestBody) => {
    sentBodies.push(requestBody?.text?.body || '');
    return { data: { messages: [{ id: `TEST-OUTBOUND-${sentBodies.length}` }] } };
  };

  const prisma = {
    candidate: {
      upsert: async () => structuredClone(candidate),
      update: async ({ data }) => {
        metrics.candidateUpdates += 1;
        candidate = { ...candidate, ...structuredClone(data) };
        return structuredClone(candidate);
      },
      updateMany: async ({ data }) => {
        metrics.candidateUpdates += 1;
        candidate = { ...candidate, ...structuredClone(data) };
        return { count: 1 };
      },
      findUnique: async () => structuredClone(candidate)
    },
    vacancy: {
      findUnique: async ({ where }) => where.id === vacancy.id ? structuredClone(vacancy) : null
    },
    message: {
      findFirst: async ({ where }) => claimedInboundIds.has(where.waMessageId)
        ? {
          id: `TEST-INBOUND-${where.waMessageId}`,
          waMessageId: where.waMessageId,
          respondedAt: null,
          createdAt: new Date()
        }
        : null,
      createMany: async ({ data }) => {
        const waMessageId = data[0]?.waMessageId;
        if (waMessageId && claimedInboundIds.has(waMessageId)) return { count: 0 };
        if (waMessageId) claimedInboundIds.add(waMessageId);
        metrics.inboundClaims += 1;
        return { count: 1 };
      },
      create: async ({ data }) => {
        outboundRecords.push(structuredClone(data));
        return { id: `TEST-OUTBOUND-RECORD-${outboundRecords.length}`, ...structuredClone(data) };
      }
    }
  };

  return {
    prisma,
    metrics,
    sentBodies,
    outboundRecords,
    getCandidate: () => structuredClone(candidate),
    getClaimedInboundIds: () => new Set(claimedInboundIds)
  };
}

async function executeReplay(replay) {
  const harness = createHarness(replay);
  const middleware = dataConsentGateMiddleware(harness.prisma);
  const deliveries = [];

  for (const messages of replay.deliveries) {
    const req = {
      body: webhookPayload(messages),
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

    deliveries.push({
      ...observed,
      remainingMessages: req.body.entry[0].changes[0].value.messages.length
    });
  }

  return { ...harness, deliveries };
}

function countBodiesMatching(bodies = [], pattern) {
  return bodies.filter((body) => pattern.test(body)).length;
}

test('replay CONV-065: el mismo waMessageId solicita consentimiento una sola vez', async () => {
  const replay = CONSENT_PROMPT_IDEMPOTENCY_REPLAYS.find((item) => item.id === 'conv-065-consent-prompt-webhook-retry-v1');
  const observed = await executeReplay(replay);
  const pending = parseConsentPendingMode(observed.getCandidate().botResumeMode);

  assert.equal(observed.outboundRecords.length, replay.expected.outboundMessages);
  assert.equal(observed.metrics.inboundClaims, replay.expected.inboundClaims);
  assert.equal(countBodiesMatching(observed.sentBodies, /Autorizo a LoginPro/i), replay.expected.consentPromptCount);
  assert.equal(pending.pending, replay.expected.finalPending);
  assert.deepEqual(observed.deliveries.map((item) => item.statuses), [[200], [200]]);
  assert.deepEqual(observed.deliveries.map((item) => item.remainingMessages), [0, 0]);
});

test('replay CONV-062: dos fragmentos se reclaman pero solo el primero construye el aviso', async () => {
  const replay = CONSENT_PROMPT_IDEMPOTENCY_REPLAYS.find((item) => item.id === 'conv-062-fragmented-interest-single-prompt-v1');
  const observed = await executeReplay(replay);
  const pending = parseConsentPendingMode(observed.getCandidate().botResumeMode);

  assert.equal(observed.outboundRecords.length, replay.expected.outboundMessages);
  assert.equal(observed.metrics.inboundClaims, replay.expected.inboundClaims);
  assert.equal(countBodiesMatching(observed.sentBodies, /Autorizo a LoginPro/i), replay.expected.consentPromptCount);
  assert.equal(pending.pending, replay.expected.finalPending);
  assert.deepEqual(observed.deliveries[0].statuses, [200]);
  assert.equal(observed.deliveries[0].remainingMessages, 0);
});

test('replay CONV-034: una pregunta pendiente se responde una vez ante reintento', async () => {
  const replay = CONSENT_PROMPT_IDEMPOTENCY_REPLAYS.find((item) => item.id === 'conv-034-pending-question-retry-v1');
  const observed = await executeReplay(replay);
  const pending = parseConsentPendingMode(observed.getCandidate().botResumeMode);

  assert.equal(observed.outboundRecords.length, replay.expected.outboundMessages);
  assert.equal(observed.metrics.inboundClaims, replay.expected.inboundClaims);
  assert.equal(
    countBodiesMatching(observed.sentBodies, /Para continuar necesito saber si autorizas/i),
    replay.expected.clarifierCount
  );
  assert.equal(pending.pending, replay.expected.finalPending);
  assert.match(observed.sentBodies[0], /gestionar (?:tu|la) postulación|fines de reclutamiento/i);
  assert.deepEqual(observed.deliveries.map((item) => item.statuses), [[200], [200]]);
});

test('replay CONV-008: un adjunto pendiente conserva reenvío de CV sin repetir consentimiento', async () => {
  const replay = CONSENT_PROMPT_IDEMPOTENCY_REPLAYS.find((item) => item.id === 'conv-008-pending-attachment-no-second-prompt-v1');
  const observed = await executeReplay(replay);
  const pending = parseConsentPendingMode(observed.getCandidate().botResumeMode);

  assert.equal(observed.outboundRecords.length, replay.expected.outboundMessages);
  assert.equal(observed.metrics.inboundClaims, replay.expected.inboundClaims);
  assert.equal(countBodiesMatching(observed.sentBodies, /Autorizo a LoginPro/i), replay.expected.consentPromptCount);
  assert.equal(pending.pending, replay.expected.finalPending);
  assert.equal(pending.cvResendRequired, replay.expected.cvResendRequired);
  assert.deepEqual(observed.deliveries[0].statuses, [200]);
  assert.equal(observed.deliveries[0].remainingMessages, 0);
});
