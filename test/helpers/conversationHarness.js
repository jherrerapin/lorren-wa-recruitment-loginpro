import assert from 'node:assert/strict';
import { createMockPrisma } from './mockPrisma.js';
import { createWhatsappMock } from './mockWhatsapp.js';
import { installOpenAIMock } from './mockOpenAI.js';
import { baseOperations, baseVacancies } from '../fixtures/conversationCases.js';

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
  return { text: normalizeForAssertion(sourceText), pattern: new RegExp(normalizedFragment) };
}

function nextTimestamp() {
  inboundSequence += 1;
  return new Date(Date.now() + inboundSequence * 60000);
}

async function seedInbound(prisma, candidateId, body) {
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
  await prisma.candidate.update({ where: { id: candidateId }, data: { lastInboundAt: createdAt } });
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
    assert.match(text, pattern, `${conversationCase.id}: la respuesta final no contiene "${fragment}"`);
  }
  for (const fragment of conversationCase.expect?.lastReplyNotIncludes || []) {
    const { text, pattern } = buildAssertionInput(fragment, lastReply);
    assert.doesNotMatch(text, pattern, `${conversationCase.id}: la respuesta final no deberia contener "${fragment}"`);
  }
  if (conversationCase.expect?.exactOutboundCount !== undefined) {
    assert.equal(whatsappMock.sentMessages.length, conversationCase.expect.exactOutboundCount, `${conversationCase.id}: cantidad de salidas inesperada`);
  }
  if (conversationCase.expect?.bookingCount !== undefined) {
    assert.equal(prisma.state.interviewBookings.length, conversationCase.expect.bookingCount, `${conversationCase.id}: cantidad de bookings inesperada`);
  }
}

function uniqueSorted(values = []) {
  return [...new Set(values.filter(Boolean).map(String))].sort();
}

function capturedCandidateFields(candidate = {}) {
  const fields = [
    'fullName', 'documentType', 'documentNumber', 'age', 'neighborhood', 'locality',
    'medicalRestrictions', 'transportMode', 'experienceInfo', 'experienceTime',
    'experienceSummary'
  ];
  return fields.filter((field) => candidate[field] !== null && candidate[field] !== undefined && candidate[field] !== '');
}

function blockedActionNames(traces = []) {
  return uniqueSorted(traces.flatMap((trace) => (trace?.blockedActions || []).map((item) => {
    if (typeof item === 'string') return item;
    return item?.type || item?.action || item?.code || 'blocked';
  })));
}

export function buildParitySnapshot({ caseId, mode, result }) {
  const candidate = result.candidate || {};
  const outboundMessages = (result.messages || []).filter((message) => message.direction === 'OUTBOUND');
  const silenceMessages = outboundMessages.filter((message) => message?.rawPayload?.source === 'bot_silence_trace');
  const payloadKeys = uniqueSorted(outboundMessages.flatMap((message) => (
    Object.keys(message?.rawPayload || {}).filter((key) => !['body', 'inboundPreview'].includes(key))
  )));
  const callTypes = (result.openAiCalls || []).map((call) => call?.type).filter(Boolean);
  const byType = Object.fromEntries(uniqueSorted(callTypes).map((type) => [type, callTypes.filter((item) => item === type).length]));
  const traces = result.debugTraces || [];

  return {
    version: 1,
    caseId,
    mode,
    candidate: {
      status: candidate.status || null,
      currentStep: candidate.currentStep || null,
      vacancyId: candidate.vacancyId || null,
      botPaused: Boolean(candidate.botPaused),
      botPauseReason: candidate.botPauseReason || null,
      botResumeMode: candidate.botResumeMode || null,
      reminderState: candidate.reminderState || null,
      reminderScheduled: Boolean(candidate.reminderScheduledFor),
      hasCv: Boolean(candidate.cvData || candidate.cvStorageKey),
      capturedFields: capturedCandidateFields(candidate)
    },
    bookings: (result.bookings || []).map((booking) => ({
      status: booking.status || null,
      slotId: booking.slotId || null,
      scheduled: Boolean(booking.scheduledAt),
      reminderSent: Boolean(booking.reminderSentAt),
      reminderWindowClosed: Boolean(booking.reminderWindowClosed)
    })),
    outbound: {
      count: result.outbound?.length || 0,
      sources: uniqueSorted(outboundMessages.map((message) => message?.rawPayload?.source)),
      payloadKeys
    },
    persistedFields: uniqueSorted(traces.flatMap((trace) => trace?.persisted_fields || [])),
    intentionalSilence: silenceMessages.map((message) => ({
      reason: message?.rawPayload?.reason || null,
      gate: message?.rawPayload?.gate || null,
      action: message?.rawPayload?.action || null
    })),
    blockedActions: blockedActionNames(traces),
    engine: {
      actions: uniqueSorted(traces.flatMap((trace) => trace?.engine_actions || [])),
      previewConsumption: uniqueSorted(traces.map((trace) => trace?.engine_preview_consumption))
    },
    openAi: { count: callTypes.length, byType }
  };
}

export async function runConversationCase(conversationCase, options = {}) {
  assert.equal(typeof options.processText, 'function', 'processText es requerido');
  assert.equal(typeof options.createDebugTrace, 'function', 'createDebugTrace es requerido');
  inboundSequence = 0;
  const prisma = buildPrismaForCase(conversationCase);
  const whatsappMock = createWhatsappMock();
  const openAiCalls = options.openAiCalls || [];
  const restoreAxios = installOpenAIMock({
    whatsappMock,
    calls: openAiCalls,
    recognizeCurrentEnginePrompt: Boolean(options.recognizeCurrentEnginePrompt)
  });
  const debugTraces = [];
  try {
    for (const step of conversationCase.steps) {
      const candidate = prisma.state.candidates[0];
      await seedInbound(prisma, candidate.id, step);
      const freshCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id } });
      const debugTrace = options.createDebugTrace({ phone: candidate.phone, currentStepBefore: freshCandidate.currentStep });
      await options.processText(prisma, freshCandidate, candidate.phone, step, debugTrace, {});
      debugTraces.push(structuredClone(debugTrace));
    }
    if (options.assertExpectations !== false) assertCaseExpectations(conversationCase, prisma, whatsappMock);
    return {
      candidate: structuredClone(prisma.state.candidates[0]),
      outbound: structuredClone(whatsappMock.sentMessages),
      bookings: structuredClone(prisma.state.interviewBookings),
      messages: structuredClone(prisma.state.messages),
      debugTraces,
      openAiCalls: structuredClone(openAiCalls)
    };
  } finally {
    restoreAxios();
  }
}
