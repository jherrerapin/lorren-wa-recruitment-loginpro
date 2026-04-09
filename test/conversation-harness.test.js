import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockPrisma } from './helpers/mockPrisma.js';
import { createWhatsappMock } from './helpers/mockWhatsapp.js';
import { installOpenAIMock } from './helpers/mockOpenAI.js';
import { baseOperations, baseVacancies, conversationCases } from './fixtures/conversationCases.js';

process.env.NODE_ENV = 'test';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.USE_CONVERSATION_ENGINE = 'true';
process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
process.env.META_ACCESS_TOKEN = 'meta-access-token';

const { processText } = await import('../src/routes/webhook.js');
const { createDebugTrace } = await import('../src/services/debugTrace.js');

let inboundSequence = 0;

function normalizeForAssertion(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildAssertionInput(fragment, sourceText) {
  const normalizedFragment = normalizeForAssertion(fragment);
  if (!normalizedFragment) {
    return {
      text: String(sourceText || ''),
      pattern: new RegExp(String(fragment || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    };
  }

  return {
    text: normalizeForAssertion(sourceText),
    pattern: new RegExp(normalizedFragment)
  };
}

function nextTimestamp() {
  inboundSequence += 1;
  return new Date(Date.now() + inboundSequence * 60000);
}

async function seedInbound(prisma, candidateId, phone, body) {
  const createdAt = nextTimestamp();
  await prisma.message.create({
    data: {
      candidateId,
      direction: 'INBOUND',
      messageType: 'TEXT',
      body,
      rawPayload: { body, source: 'candidate' },
      createdAt
    }
  });
  await prisma.candidate.update({
    where: { id: candidateId },
    data: { lastInboundAt: createdAt }
  });
}

function buildPrismaForCase(conversationCase) {
  const candidate = { ...conversationCase.candidate };
  const preMessages = (conversationCase.preMessages || []).map((message, index) => ({
    id: `pre-message-${index + 1}`,
    candidateId: candidate.id,
    messageType: 'TEXT',
    createdAt: message.createdAt || nextTimestamp(),
    respondedAt: null,
    ...message
  }));

  const lastOutbound = [...preMessages].reverse().find((message) => message.direction === 'OUTBOUND');
  if (lastOutbound) candidate.lastOutboundAt = lastOutbound.createdAt;

  return createMockPrisma({
    candidates: [candidate],
    messages: preMessages,
    vacancies: conversationCase.vacancies || baseVacancies,
    operations: conversationCase.operations || baseOperations,
    interviewSlots: conversationCase.interviewSlots || [],
    interviewBookings: conversationCase.interviewBookings || []
  });
}

function assertCaseExpectations(conversationCase, prisma, whatsappMock) {
  const candidate = prisma.state.candidates[0];
  const lastReply = whatsappMock.sentMessages.at(-1)?.body || '';
  const normalizedLastReply = normalizeForAssertion(lastReply);

  if (conversationCase.expect?.candidate) {
    for (const [field, value] of Object.entries(conversationCase.expect.candidate)) {
      assert.deepEqual(candidate[field], value, `${conversationCase.id}: ${field} no coincide`);
    }
  }

  if (conversationCase.expect?.candidateNot) {
    for (const [field, value] of Object.entries(conversationCase.expect.candidateNot)) {
      assert.notDeepEqual(candidate[field], value, `${conversationCase.id}: ${field} no deberia ser ${value}`);
    }
  }

  for (const field of conversationCase.expect?.absentFields || []) {
    assert.ok(candidate[field] === null || candidate[field] === undefined || candidate[field] === '', `${conversationCase.id}: ${field} no deberia persistirse`);
  }

  if (conversationCase.expect?.notStatus) {
    assert.notEqual(candidate.status, conversationCase.expect.notStatus, `${conversationCase.id}: status no deberia ser ${conversationCase.expect.notStatus}`);
  }

  for (const fragment of conversationCase.expect?.lastReplyIncludes || []) {
    const { text, pattern } = buildAssertionInput(fragment, lastReply);
    assert.match(
      text,
      pattern,
      `${conversationCase.id}: la respuesta final no contiene "${fragment}"`
    );
  }

  for (const fragment of conversationCase.expect?.lastReplyNotIncludes || []) {
    const { text, pattern } = buildAssertionInput(fragment, lastReply);
    assert.doesNotMatch(
      text,
      pattern,
      `${conversationCase.id}: la respuesta final no deberia contener "${fragment}"`
    );
  }

  if (conversationCase.expect?.exactOutboundCount !== undefined) {
    assert.equal(whatsappMock.sentMessages.length, conversationCase.expect.exactOutboundCount, `${conversationCase.id}: cantidad de salidas inesperada`);
  }

  if (conversationCase.expect?.bookingCount !== undefined) {
    assert.equal(prisma.state.interviewBookings.length, conversationCase.expect.bookingCount, `${conversationCase.id}: cantidad de bookings inesperada`);
  }

  if (conversationCase.expect?.bookingStatuses) {
    assert.deepEqual(
      prisma.state.interviewBookings.map((booking) => booking.status),
      conversationCase.expect.bookingStatuses,
      `${conversationCase.id}: estados de booking inesperados`
    );
  }

  if (conversationCase.expect?.bookingReminderResponses) {
    assert.deepEqual(
      prisma.state.interviewBookings.map((booking) => booking.reminderResponse || null),
      conversationCase.expect.bookingReminderResponses,
      `${conversationCase.id}: reminderResponse de booking inesperado`
    );
  }
}

async function runConversationCase(conversationCase) {
  inboundSequence = 0;
  const prisma = buildPrismaForCase(conversationCase);
  const whatsappMock = createWhatsappMock();
  const restoreAxios = installOpenAIMock({ whatsappMock });

  try {
    for (const step of conversationCase.steps) {
      const candidate = prisma.state.candidates[0];
      await seedInbound(prisma, candidate.id, candidate.phone, step);
      const freshCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id } });
      const debugTrace = createDebugTrace({ phone: candidate.phone, currentStepBefore: freshCandidate.currentStep });
      await processText(prisma, freshCandidate, candidate.phone, step, debugTrace, {});
    }

    assertCaseExpectations(conversationCase, prisma, whatsappMock);
    return {
      candidate: prisma.state.candidates[0],
      outbound: whatsappMock.sentMessages,
      bookings: prisma.state.interviewBookings
    };
  } finally {
    restoreAxios();
  }
}

test('conversation harness regression cases', async (t) => {
  for (const conversationCase of conversationCases) {
    await t.test(conversationCase.id, async () => {
      await runConversationCase(conversationCase);
    });
  }
});
