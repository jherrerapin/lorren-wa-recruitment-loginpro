import fs from 'node:fs';
import assert from 'node:assert/strict';

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  const count = source.split(before).length - 1;
  assert.equal(count, 1, `${label}: se esperaba una coincidencia y se encontraron ${count}`);
  return source.replace(before, after);
}

const webhookPath = 'src/routes/webhook.js';
let webhook = fs.readFileSync(webhookPath, 'utf8');
const oldPrimaryEngineGate = `  if (!shouldPreferVacancyContextReply && !shouldPreferStructuredFieldReply && !hasDataIntent && await tryPrimaryEngineReply(candidate, currentVacancy)) {
    return;
  }`;
const newPrimaryEngineGate = `  const shouldDeferSchedulingConfirmationToDeterministicGuard = Boolean(
    candidate.currentStep === ConversationStep.SCHEDULING
    && currentVacancy
    && isSchedulingEligibleCandidate(candidate, currentVacancy)
    && isSchedulingConfirmationIntent(cleanText)
  );

  if (
    !shouldDeferSchedulingConfirmationToDeterministicGuard
    && !shouldPreferVacancyContextReply
    && !shouldPreferStructuredFieldReply
    && !hasDataIntent
    && await tryPrimaryEngineReply(candidate, currentVacancy)
  ) {
    return;
  }`;
webhook = replaceOnce(
  webhook,
  oldPrimaryEngineGate,
  newPrimaryEngineGate,
  'precedencia del guard determinístico de agenda'
);
fs.writeFileSync(webhookPath, webhook);

const parityPath = 'test/conversationEngineParity.test.js';
let parity = fs.readFileSync(parityPath, 'utf8');
const anchor = `test('la matriz ejecuta ambos modos en procesos aislados y reporta divergencias de dominio', () => {`;
const regression = `test('agenda sin horarios conserva la autoridad determinística en ambos modos', () => {
  const [withoutEngine] = runMode('false', ['parity-no-available-slots']);
  const [withEngine] = runMode('true', ['parity-no-available-slots']);

  assert.deepEqual(domainDifferences(withoutEngine, withEngine), []);
  for (const snapshot of [withoutEngine, withEngine]) {
    assert.equal(snapshot.candidate.currentStep, 'SCHEDULING');
    assert.equal(snapshot.candidate.botPaused, true);
    assert.match(String(snapshot.candidate.botPauseReason || ''), /missing_valid_slot/);
    assert.equal(snapshot.candidate.reminderState, 'CANCELLED');
    assert.deepEqual(snapshot.bookings, []);
    assert.deepEqual(snapshot.outbound.sources, ['bot_flow']);
  }
  assert.equal(withEngine.openAi.byType.conversation_engine || 0, 0);
});

${anchor}`;
parity = replaceOnce(
  parity,
  anchor,
  regression,
  'regresión focal de agenda sin horarios'
);
fs.writeFileSync(parityPath, parity);

console.log('Issue #771 aplicado correctamente.');
