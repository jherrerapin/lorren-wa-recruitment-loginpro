import test from 'node:test';
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
  const line = output.split(/\r?\n/).findLast((item) => item.startsWith('__LORREN_PARITY__'));
  assert.ok(line, `No se encontró snapshot de paridad para modo ${mode}`);
  return JSON.parse(line.slice('__LORREN_PARITY__'.length));
}

function findForbiddenKeys(value, path = '') {
  if (Array.isArray(value)) return value.flatMap((item, index) => findForbiddenKeys(item, `${path}[${index}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const current = path ? `${path}.${key}` : key;
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
  for (const item of pending) assert.ok(item.reason, `${item.key} debe explicar su cobertura pendiente`);
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
    assert.ok(withoutEngine && withEngine, `Falta snapshot para ${scenario.key}`);
    assert.equal(withoutEngine.mode, 'false');
    assert.equal(withEngine.mode, 'true');
    assert.deepEqual(findForbiddenKeys(withoutEngine), []);
    assert.deepEqual(findForbiddenKeys(withEngine), []);
    assert.equal(withoutEngine.openAi.byType.conversation_engine || 0, 0, `${scenario.key}: el modo false no debe llamar al engine`);
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
