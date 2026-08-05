import test from 'node:test';
import assert from 'node:assert/strict';
import { dataConsentGateMiddleware } from '../src/services/dataConsentGate.js';
import { findInboundConversationMessage } from '../src/services/conversationMessageRepository.js';
import { HUMAN_PAUSE_REPLAYS } from './conversation-replay/humanPauseReplay.js';

function webhookPayload(message) {
  return {
    entry: [{
      changes: [{
        value: { messages: [structuredClone(message)] }
      }]
    }]
  };
}

function payloadMessageCount(payload = {}) {
  return payload.entry
    .flatMap((entry) => entry.changes || [])
    .flatMap((change) => change.value?.messages || [])
    .length;
}

function buildReplayPrisma(replay, options = {}) {
  let candidate = structuredClone(replay.candidate);
  const persistedInboundIds = new Set(replay.persistedInboundIds || []);
  const metrics = {
    resumeUpdates: 0,
    candidateUpdates: 0,
    outboundMessages: 0,
    inboundMessages: 0,
    consentEvents: 0,
    lastResumeWhere: null,
    lastResumeData: null
  };

  const prisma = {
    candidate: {
      upsert: async () => structuredClone(candidate),
      updateMany: async ({ where, data }) => {
        metrics.resumeUpdates += 1;
        metrics.lastResumeWhere = structuredClone(where);
        metrics.lastResumeData = structuredClone(data);
        if (options.resumeConflict) return { count: 0 };
        candidate = { ...candidate, ...structuredClone(data) };
        return { count: 1 };
      },
      findUnique: async () => structuredClone(candidate),
      update: async ({ data }) => {
        metrics.candidateUpdates += 1;
        candidate = { ...candidate, ...structuredClone(data) };
        return structuredClone(candidate);
      }
    },
    message: {
      findFirst: async ({ where }) => persistedInboundIds.has(where.waMessageId)
        ? { id: `message-${where.waMessageId}`, waMessageId: where.waMessageId, respondedAt: null, createdAt: new Date() }
        : null,
      createMany: async ({ data }) => {
        const waMessageId = data[0]?.waMessageId;
        if (persistedInboundIds.has(waMessageId)) return { count: 0 };
        persistedInboundIds.add(waMessageId);
        metrics.inboundMessages += 1;
        return { count: 1 };
      },
      create: async () => {
        metrics.outboundMessages += 1;
        return { id: 'outbound-replay' };
      }
    },
    candidateDataConsentEvent: {
      create: async () => {
        metrics.consentEvents += 1;
        return { id: 'consent-event-replay' };
      }
    },
    vacancy: {
      findUnique: async () => null
    }
  };

  return {
    prisma,
    metrics,
    getCandidate: () => structuredClone(candidate),
    getPersistedInboundIds: () => new Set(persistedInboundIds)
  };
}

async function executeReplay(replay, options = {}) {
  const runtime = buildReplayPrisma(replay, options);
  const middleware = dataConsentGateMiddleware(runtime.prisma);
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
    ...runtime,
    ...observed,
    payloadMessageCount: payloadMessageCount(req.body)
  };
}

test('A3 replay: un inbound conocido no ignora la pausa humana ni vuelve a pedir consentimiento', async () => {
  const replay = HUMAN_PAUSE_REPLAYS.find((item) => item.sourceConversation === 'CONV-011');
  const result = await executeReplay(replay);
  const finalCandidate = result.getCandidate();

  assert.equal(result.nextCalls, replay.expected.nextCalls);
  assert.deepEqual(result.statuses, replay.expected.statuses);
  assert.equal(result.metrics.resumeUpdates, replay.expected.resumeUpdates);
  assert.equal(result.metrics.outboundMessages, replay.expected.outboundMessages);
  assert.equal(result.metrics.consentEvents, 0);
  assert.equal(result.payloadMessageCount, replay.expected.payloadMessageCount);
  assert.equal(finalCandidate.botPaused, replay.expected.botPaused);
  assert.equal(finalCandidate.botResumeMode, replay.expected.botResumeMode);
});

test('A3 replay: un inbound nuevo reanuda desde el contexto vigente y pasa una sola vez al router', async () => {
  const replay = HUMAN_PAUSE_REPLAYS.find((item) => item.sourceConversation === 'CONV-019');
  const result = await executeReplay(replay);
  const finalCandidate = result.getCandidate();

  assert.equal(result.nextCalls, replay.expected.nextCalls);
  assert.deepEqual(result.statuses, replay.expected.statuses);
  assert.equal(result.metrics.resumeUpdates, replay.expected.resumeUpdates);
  assert.equal(result.metrics.outboundMessages, replay.expected.outboundMessages);
  assert.equal(result.payloadMessageCount, replay.expected.payloadMessageCount);
  assert.equal(finalCandidate.botPaused, replay.expected.botPaused);
  assert.equal(finalCandidate.botResumeMode, replay.expected.botResumeMode);
  assert.deepEqual(
    Object.fromEntries(Object.keys(replay.expected.preserved).map((field) => [field, finalCandidate[field]])),
    replay.expected.preserved
  );
  assert.equal(result.metrics.lastResumeData.reminderState, 'CANCELLED');
  assert.equal(result.metrics.lastResumeData.reminderScheduledFor, null);
});

test('A3: una pausa no reanudable bloquea el gate de consentimiento y delega al router sin responder', async () => {
  const base = HUMAN_PAUSE_REPLAYS.find((item) => item.sourceConversation === 'CONV-019');
  const replay = structuredClone(base);
  replay.candidate.botResumeMode = 'manual_outbound_sending';
  replay.inbound.id = 'wamid-replay-non-resumable-new';

  const result = await executeReplay(replay);
  const finalCandidate = result.getCandidate();

  assert.equal(result.nextCalls, 1);
  assert.deepEqual(result.statuses, []);
  assert.equal(result.metrics.resumeUpdates, 0);
  assert.equal(result.metrics.outboundMessages, 0);
  assert.equal(result.payloadMessageCount, 1);
  assert.equal(finalCandidate.botPaused, true);
  assert.equal(finalCandidate.botResumeMode, 'manual_outbound_sending');
});

test('A3: un conflicto al reanudar no genera respuesta y conserva el inbound para la autoridad del router', async () => {
  const replay = HUMAN_PAUSE_REPLAYS.find((item) => item.sourceConversation === 'CONV-019');
  const result = await executeReplay(replay, { resumeConflict: true });
  const finalCandidate = result.getCandidate();

  assert.equal(result.nextCalls, 1);
  assert.deepEqual(result.statuses, []);
  assert.equal(result.metrics.resumeUpdates, 1);
  assert.equal(result.metrics.outboundMessages, 0);
  assert.equal(result.payloadMessageCount, 1);
  assert.equal(finalCandidate.botPaused, true);
  assert.equal(finalCandidate.botResumeMode, 'manual_resume_dashboard');
});

test('A3: la consulta canónica de inbound usa candidato, dirección y waMessageId', async () => {
  let observedWhere = null;
  const prisma = {
    message: {
      findFirst: async ({ where }) => {
        observedWhere = where;
        return { id: 'message-existing', waMessageId: where.waMessageId, respondedAt: null, createdAt: new Date() };
      }
    }
  };

  const result = await findInboundConversationMessage(prisma, {
    candidateId: 'candidate-replay-query',
    waMessageId: 'wamid-replay-query'
  });

  assert.equal(result.found, true);
  assert.deepEqual(observedWhere, {
    candidateId: 'candidate-replay-query',
    direction: 'INBOUND',
    waMessageId: 'wamid-replay-query'
  });
});
