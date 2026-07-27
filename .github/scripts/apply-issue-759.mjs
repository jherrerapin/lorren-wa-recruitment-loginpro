import fs from 'node:fs';
import assert from 'node:assert/strict';

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  const count = source.split(before).length - 1;
  assert.equal(count, 1, `${label}: se esperaba una coincidencia y se encontraron ${count}`);
  return source.replace(before, after);
}

const mockOpenAiPath = 'test/helpers/mockOpenAI.js';
let mockOpenAi = fs.readFileSync(mockOpenAiPath, 'utf8');
mockOpenAi = replaceOnce(
  mockOpenAi,
  `export function installOpenAIMock({ whatsappMock, responder } = {}) {`,
  `export function installOpenAIMock({ whatsappMock, responder, calls } = {}) {`,
  'firma del mock OpenAI'
);
mockOpenAi = replaceOnce(
  mockOpenAi,
  `      let content;\n      if (typeof responder === 'function') {\n        content = responder({ url, payload, systemPrompt, userText });\n      } else if (/Eres un reclutador humano experto leyendo mensajes de WhatsApp/.test(systemPrompt)) {\n        content = buildAiParserResponse(userText);\n      } else if (/Sos un reclutador del equipo de seleccion de LoginPro/.test(systemPrompt) && /Devuelve SOLO un objeto JSON/.test(systemPrompt)) {\n        content = buildEngineDecision(systemPrompt, userText);\n      } else {\n        content = buildNaturalReply(systemPrompt);\n      }`,
  `      const requestType = /Eres un reclutador humano experto leyendo mensajes de WhatsApp/.test(systemPrompt)\n        ? 'extraction'\n        : (/Sos un reclutador del equipo de seleccion de LoginPro/.test(systemPrompt) && /Devuelve SOLO un objeto JSON/.test(systemPrompt)\n          ? 'conversation_engine'\n          : 'natural_reply');\n      if (Array.isArray(calls)) calls.push({ type: requestType });\n\n      let content;\n      if (typeof responder === 'function') {\n        content = responder({ url, payload, systemPrompt, userText });\n      } else if (requestType === 'extraction') {\n        content = buildAiParserResponse(userText);\n      } else if (requestType === 'conversation_engine') {\n        content = buildEngineDecision(systemPrompt, userText);\n      } else {\n        content = buildNaturalReply(systemPrompt);\n      }`,
  'clasificación de llamadas OpenAI'
);
fs.writeFileSync(mockOpenAiPath, mockOpenAi);

const sharedHarnessPath = 'test/helpers/conversationHarness.js';
fs.writeFileSync(sharedHarnessPath, `import assert from 'node:assert/strict';
import { createMockPrisma } from './mockPrisma.js';
import { createWhatsappMock } from './mockWhatsapp.js';
import { installOpenAIMock } from './mockOpenAI.js';
import { baseOperations, baseVacancies } from '../fixtures/conversationCases.js';

let inboundSequence = 0;

function normalizeForAssertion(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\\u0300-\\u036f]/g, '')
    .replace(/\\s+/g, ' ')
    .trim();
}

function buildAssertionInput(fragment, sourceText) {
  const normalizedFragment = normalizeForAssertion(fragment);
  if (!normalizedFragment) {
    return {
      text: String(sourceText || ''),
      pattern: new RegExp(String(fragment || '').replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'))
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
    id: \`pre-message-\${index + 1}\`,
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
      assert.deepEqual(candidate[field], value, \`\${conversationCase.id}: \${field} no coincide\`);
    }
  }
  if (conversationCase.expect?.candidateNot) {
    for (const [field, value] of Object.entries(conversationCase.expect.candidateNot)) {
      assert.notDeepEqual(candidate[field], value, \`\${conversationCase.id}: \${field} no deberia ser \${value}\`);
    }
  }
  for (const field of conversationCase.expect?.absentFields || []) {
    assert.ok(candidate[field] === null || candidate[field] === undefined || candidate[field] === '', \`\${conversationCase.id}: \${field} no deberia persistirse\`);
  }
  if (conversationCase.expect?.notStatus) {
    assert.notEqual(candidate.status, conversationCase.expect.notStatus, \`\${conversationCase.id}: status no deberia ser \${conversationCase.expect.notStatus}\`);
  }
  for (const fragment of conversationCase.expect?.lastReplyIncludes || []) {
    const { text, pattern } = buildAssertionInput(fragment, lastReply);
    assert.match(text, pattern, \`\${conversationCase.id}: la respuesta final no contiene "\${fragment}"\`);
  }
  for (const fragment of conversationCase.expect?.lastReplyNotIncludes || []) {
    const { text, pattern } = buildAssertionInput(fragment, lastReply);
    assert.doesNotMatch(text, pattern, \`\${conversationCase.id}: la respuesta final no deberia contener "\${fragment}"\`);
  }
  if (conversationCase.expect?.exactOutboundCount !== undefined) {
    assert.equal(whatsappMock.sentMessages.length, conversationCase.expect.exactOutboundCount, \`\${conversationCase.id}: cantidad de salidas inesperada\`);
  }
  if (conversationCase.expect?.bookingCount !== undefined) {
    assert.equal(prisma.state.interviewBookings.length, conversationCase.expect.bookingCount, \`\${conversationCase.id}: cantidad de bookings inesperada\`);
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
  const restoreAxios = installOpenAIMock({ whatsappMock, calls: openAiCalls });
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
`);

const harnessTestPath = 'test/conversation-harness.test.js';
fs.writeFileSync(harnessTestPath, `import test from 'node:test';
import { conversationCases } from './fixtures/conversationCases.js';
import { runConversationCase } from './helpers/conversationHarness.js';

process.env.NODE_ENV = 'test';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.USE_CONVERSATION_ENGINE = 'true';
process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
process.env.META_ACCESS_TOKEN = 'meta-access-token';
process.env.LORREN_SEND_DELAY_MS = '0';

const { processText } = await import('../src/routes/webhook.js');
const { createDebugTrace } = await import('../src/services/debugTrace.js');

test('conversation harness regression cases', async (t) => {
  for (const conversationCase of conversationCases) {
    await t.test(conversationCase.id, async () => {
      await runConversationCase(conversationCase, { processText, createDebugTrace });
    });
  }
});
`);

const childRunnerPath = 'test/helpers/runConversationParityCases.js';
fs.writeFileSync(childRunnerPath, `import { conversationCases } from '../fixtures/conversationCases.js';
import { buildParitySnapshot, runConversationCase } from './conversationHarness.js';

const mode = String(process.argv[2] || 'false');
const caseIds = JSON.parse(process.argv[3] || '[]');
if (!['true', 'false'].includes(mode)) throw new Error('Modo de engine inválido.');
if (!Array.isArray(caseIds) || !caseIds.length) throw new Error('Se requieren casos de paridad.');

process.env.NODE_ENV = 'test';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.USE_CONVERSATION_ENGINE = mode;
process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
process.env.META_ACCESS_TOKEN = 'meta-access-token';
process.env.LORREN_SEND_DELAY_MS = '0';

const { processText } = await import('../../src/routes/webhook.js');
const { createDebugTrace } = await import('../../src/services/debugTrace.js');
const byId = new Map(conversationCases.map((item) => [item.id, item]));
const snapshots = [];

for (const caseId of caseIds) {
  const conversationCase = byId.get(caseId);
  if (!conversationCase) throw new Error(\`Caso de conversación no encontrado: \${caseId}\`);
  const result = await runConversationCase(conversationCase, {
    processText,
    createDebugTrace,
    assertExpectations: false,
    openAiCalls: []
  });
  snapshots.push(buildParitySnapshot({ caseId, mode, result }));
}

console.log('__LORREN_PARITY__' + JSON.stringify(snapshots));
`);

const parityTestPath = 'test/conversationEngineParity.test.js';
fs.writeFileSync(parityTestPath, `import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCENARIOS = [
  { key: 'initial_greeting_interest', caseId: 'ibague-greeting-interest-does-not-become-name-and-name-correction-advances', coverage: 'text' },
  { key: 'vacancy_selection', caseId: 'funza-bodega-city-does-not-become-name-and-resolves-vacancy', coverage: 'text' },
  { key: 'block_data', caseId: 'bodega-data-block-keeps-name-doc-and-transport', coverage: 'text' },
  { key: 'field_correction', caseId: 'natural-correction-in-confirmation', coverage: 'text' },
  { key: 'pure_question', caseId: 'scheduled-question-uses-context-instead-of-repeating-flow', coverage: 'text' },
  { key: 'question_with_data', caseId: 'answer-question-before-data', coverage: 'text' },
  { key: 'data_confirmation', caseId: 'no-infinite-confirmation', coverage: 'text' },
  { key: 'cv_request', caseId: 'fragmented-data-consolidation', coverage: 'text' },
  { key: 'cv_received', coverage: 'pending_webhook', reason: 'La recepción real de CV ocurre en la rama document del webhook.' },
  { key: 'question_during_ask_cv', caseId: 'ask-cv-out-of-scope-question-pauses-for-dev-review', coverage: 'text' },
  { key: 'interview_offer', caseId: 'future-birthday-keeps-current-age-and-does-not-repeat-transport', coverage: 'text' },
  { key: 'schedule_confirmation', caseId: 'scheduling-offer-reschedule-confirm', coverage: 'text' },
  { key: 'interview_cancellation', coverage: 'pending_webhook', reason: 'Requiere fixture focal de booking activo y cancelación.' },
  { key: 'interview_reschedule', caseId: 'scheduling-offer-reschedule-confirm', coverage: 'text' },
  { key: 'attendance_confirmation', coverage: 'pending_webhook', reason: 'Requiere ventana de recordatorio y booking activo.' },
  { key: 'reminder_logistics_question', caseId: 'scheduled-question-uses-context-instead-of-repeating-flow', coverage: 'text' },
  { key: 'no_available_slots', coverage: 'pending_webhook', reason: 'Requiere fixture de agenda sin slots válidos.' },
  { key: 'inactive_vacancy', caseId: 'inactive-vacancy-offers-registration-for-future-openings', coverage: 'text' },
  { key: 'city_without_vacancies', coverage: 'pending_webhook', reason: 'Requiere operación/ciudad sin vacantes activas en fixture focal.' },
  { key: 'manual_review', caseId: 'document-exception-pauses-for-manual-review', coverage: 'text' },
  { key: 'recent_human_intervention', caseId: 'human-intervention-pauses-bot', coverage: 'text' },
  { key: 'finished_or_rejected_candidate', caseId: 'done-step-followup-about-previous-application-gets-status-ack', coverage: 'text' },
  { key: 'duplicate_or_concurrent_messages', coverage: 'pending_webhook', reason: 'Requiere persistencia de waMessageId y adquisición multiline concurrente.' }
];

const runnerPath = fileURLToPath(new URL('./helpers/runConversationParityCases.js', import.meta.url));
const PII_KEYS = new Set(['phone', 'fullName', 'documentNumber', 'body', 'text', 'prompt', 'inboundPreview']);

function runMode(mode, caseIds) {
  const output = execFileSync(process.execPath, [runnerPath, mode, JSON.stringify(caseIds)], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, USE_CONVERSATION_ENGINE: mode, LORREN_SEND_DELAY_MS: '0' }
  });
  const line = output.split(/\\r?\\n/).findLast((item) => item.startsWith('__LORREN_PARITY__'));
  assert.ok(line, \`No se encontró snapshot de paridad para modo \${mode}\`);
  return JSON.parse(line.slice('__LORREN_PARITY__'.length));
}

function findForbiddenKeys(value, path = '') {
  if (Array.isArray(value)) return value.flatMap((item, index) => findForbiddenKeys(item, \`\${path}[\${index}]\`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const current = path ? \`\${path}.\${key}\` : key;
    return [...(PII_KEYS.has(key) ? [current] : []), ...findForbiddenKeys(child, current)];
  });
}

function domainDifferences(left, right) {
  const keys = ['candidate', 'bookings', 'outbound', 'persistedFields', 'intentionalSilence', 'blockedActions'];
  return keys.filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]));
}

test('el manifiesto conserva los 23 escenarios exactos del plan', () => {
  assert.equal(SCENARIOS.length, 23);
  assert.equal(new Set(SCENARIOS.map((item) => item.key)).size, 23);
  const pending = SCENARIOS.filter((item) => item.coverage !== 'text');
  assert.equal(pending.length, 6);
  for (const item of pending) assert.ok(item.reason, \`\${item.key} debe explicar su cobertura pendiente\`);
});

test('la matriz ejecuta ambos modos en procesos aislados y reporta divergencias de dominio', () => {
  const supported = SCENARIOS.filter((item) => item.coverage === 'text');
  const caseIds = [...new Set(supported.map((item) => item.caseId))];
  const disabled = new Map(runMode('false', caseIds).map((item) => [item.caseId, item]));
  const enabled = new Map(runMode('true', caseIds).map((item) => [item.caseId, item]));
  let enabledEngineCalls = 0;

  for (const scenario of supported) {
    const withoutEngine = disabled.get(scenario.caseId);
    const withEngine = enabled.get(scenario.caseId);
    assert.ok(withoutEngine && withEngine, \`Falta snapshot para \${scenario.key}\`);
    assert.equal(withoutEngine.mode, 'false');
    assert.equal(withEngine.mode, 'true');
    assert.deepEqual(findForbiddenKeys(withoutEngine), []);
    assert.deepEqual(findForbiddenKeys(withEngine), []);
    assert.equal(withoutEngine.openAi.byType.conversation_engine || 0, 0, \`\${scenario.key}: el modo false no debe llamar al engine\`);
    enabledEngineCalls += withEngine.openAi.byType.conversation_engine || 0;
    const differences = domainDifferences(withoutEngine, withEngine);
    console.info('[ENGINE_PARITY_CASE]', JSON.stringify({
      scenario: scenario.key,
      caseId: scenario.caseId,
      domainEqual: differences.length === 0,
      differences,
      openAiFalse: withoutEngine.openAi,
      openAiTrue: withEngine.openAi,
      enginePreviewConsumption: withEngine.engine.previewConsumption
    }));
  }

  assert.ok(enabledEngineCalls > 0, 'El modo true debe demostrar al menos una llamada aislada al engine conversacional.');
});
`);

console.log('Issue #759 aplicado correctamente.');
