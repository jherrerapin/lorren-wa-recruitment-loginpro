import fs from 'node:fs';

fs.writeFileSync('test/fixtures/conversationParityCases.js', `import { buildFutureSlot } from '../helpers/mockScheduler.js';

const OP_BOG = {
  id: 'op-bogota-parity',
  name: 'Operacion Bogota Parity',
  city: { id: 'city-bogota-parity', name: 'Bogota' }
};

const VACANCY = {
  id: 'vac-sched-parity',
  title: 'Mensajero Bogota Parity',
  role: 'Mensajero',
  city: 'Bogota',
  operationId: OP_BOG.id,
  operation: OP_BOG,
  operationAddress: 'Calle 80 # 10-20',
  interviewAddress: 'Calle 80 # 10-20',
  requirements: 'Conocimiento de direcciones y disponibilidad',
  conditions: 'Contrato por obra y proceso con entrevista',
  roleDescription: 'Mensajeria y entregas urbanas',
  requiredDocuments: 'Documento y hoja de vida',
  acceptingApplications: true,
  isActive: true,
  schedulingEnabled: true,
  updatedAt: new Date('2026-07-27T12:00:00.000Z')
};

function completeCandidate(overrides = {}) {
  return {
    id: overrides.id || 'candidate-parity-scheduling',
    phone: overrides.phone || '573001119999',
    status: 'REGISTRADO',
    currentStep: 'SCHEDULING',
    vacancyId: VACANCY.id,
    fullName: 'Candidato Agenda Parity',
    documentType: 'CC',
    documentNumber: '1000000009',
    age: 28,
    gender: 'MALE',
    neighborhood: null,
    locality: 'Suba',
    medicalRestrictions: 'Sin restricciones médicas',
    transportMode: 'Moto',
    experienceInfo: null,
    experienceTime: null,
    cvData: Buffer.from('pdf'),
    cvOriginalName: 'hv.pdf',
    cvMimeType: 'application/pdf',
    reminderState: 'SKIPPED',
    reminderScheduledFor: null,
    botPaused: false,
    botPausedAt: null,
    botPausedBy: null,
    botPauseReason: null,
    botResumeMode: null,
    lastInboundAt: new Date(),
    lastOutboundAt: null,
    createdAt: new Date('2026-07-27T10:00:00.000Z'),
    ...overrides
  };
}

function scheduledAtForSlot(slot) {
  const datePart = new Date(slot.specificDate).toISOString().slice(0, 10);
  return new Date(\`\${datePart}T\${slot.startTime}:00-05:00\`);
}

const offeredSlot = buildFutureSlot({
  vacancyId: VACANCY.id,
  id: 'slot-parity-offered',
  hoursFromNow: 8
});
const offeredAt = scheduledAtForSlot(offeredSlot);

const activeSlot = buildFutureSlot({
  vacancyId: VACANCY.id,
  id: 'slot-parity-active',
  hoursFromNow: 8
});
const alternativeSlot = buildFutureSlot({
  vacancyId: VACANCY.id,
  id: 'slot-parity-alternative',
  hoursFromNow: 14
});
const activeAt = scheduledAtForSlot(activeSlot);

export const conversationParityCases = [
  {
    id: 'parity-schedule-confirmation',
    steps: ['ese horario me sirve'],
    candidate: completeCandidate({ currentStep: 'SCHEDULING' }),
    vacancies: [VACANCY],
    operations: [OP_BOG],
    interviewSlots: [offeredSlot],
    preMessages: [{
      direction: 'OUTBOUND',
      body: 'Te puedo ofrecer un horario disponible. Me confirmas si te sirve.',
      rawPayload: {
        source: 'interview_offer',
        slotId: offeredSlot.id,
        scheduledAt: offeredAt.toISOString(),
        formattedDate: 'horario ofrecido'
      },
      createdAt: new Date(Date.now() - 5 * 60 * 1000)
    }]
  },
  {
    id: 'parity-interview-reschedule',
    steps: ['no puedo asistir, necesito otro horario'],
    candidate: completeCandidate({ currentStep: 'SCHEDULED' }),
    vacancies: [VACANCY],
    operations: [OP_BOG],
    interviewSlots: [activeSlot, alternativeSlot],
    interviewBookings: [{
      id: 'booking-parity-active',
      candidateId: 'candidate-parity-scheduling',
      vacancyId: VACANCY.id,
      slotId: activeSlot.id,
      scheduledAt: activeAt,
      status: 'SCHEDULED',
      reminderSentAt: null,
      reminderWindowClosed: false,
      createdAt: new Date(Date.now() - 60 * 60 * 1000)
    }]
  }
];
`);

fs.writeFileSync('test/helpers/runConversationParityCases.js', `import { conversationCases } from '../fixtures/conversationCases.js';
import { conversationParityCases } from '../fixtures/conversationParityCases.js';
import { buildParitySnapshot, runConversationCase } from './conversationHarness.js';

const mode = String(process.argv[2] || 'false');
const caseIds = JSON.parse(process.argv[3] || '[]');

if (Array.isArray(caseIds) && caseIds.length) {
  if (!['true', 'false'].includes(mode)) throw new Error('Modo de engine inválido.');
  process.env.NODE_ENV = 'test';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.USE_CONVERSATION_ENGINE = mode;
  process.env.META_PHONE_NUMBER_ID = 'meta-phone-id';
  process.env.META_ACCESS_TOKEN = 'meta-access-token';
  process.env.LORREN_SEND_DELAY_MS = '0';

  const { processText } = await import('../../src/routes/webhook.js');
  const { createDebugTrace } = await import('../../src/services/debugTrace.js');
  const byId = new Map(
    [...conversationCases, ...conversationParityCases].map((item) => [item.id, item])
  );
  const snapshots = [];

  for (const caseId of caseIds) {
    const conversationCase = byId.get(caseId);
    if (!conversationCase) throw new Error(\`Caso de conversación no encontrado: \${caseId}\`);
    const result = await runConversationCase(conversationCase, {
      processText,
      createDebugTrace,
      assertExpectations: false,
      openAiCalls: [],
      recognizeCurrentEnginePrompt: true
    });
    snapshots.push(buildParitySnapshot({ caseId, mode, result }));
  }

  console.log('__LORREN_PARITY__' + JSON.stringify(snapshots));
}
`);

fs.writeFileSync('test/conversationEngineParity.test.js', `import test from 'node:test';
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
  { key: 'schedule_confirmation', caseId: 'parity-schedule-confirmation', coverage: 'text' },
  { key: 'interview_cancellation', coverage: 'pending_webhook', reason: 'Requiere fixture focal de booking activo y cancelación.' },
  { key: 'interview_reschedule', caseId: 'parity-interview-reschedule', coverage: 'text' },
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

test('confirmación y reprogramación usan fixtures focales independientes', () => {
  const confirmation = SCENARIOS.find((item) => item.key === 'schedule_confirmation');
  const reschedule = SCENARIOS.find((item) => item.key === 'interview_reschedule');
  assert.equal(confirmation.caseId, 'parity-schedule-confirmation');
  assert.equal(reschedule.caseId, 'parity-interview-reschedule');
  assert.notEqual(confirmation.caseId, reschedule.caseId);
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

console.log('Issue #763 aplicado correctamente.');
