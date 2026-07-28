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
webhook = replaceOnce(
  webhook,
  `  if (candidate.currentStep === ConversationStep.GREETING_SENT && !candidate.vacancyId) {\n    return Boolean(Object.keys(localParsedData || {}).length || Object.keys(aiFields || {}).length);\n  }`,
  `  if (candidate.currentStep === ConversationStep.GREETING_SENT && !candidate.vacancyId) {\n    return hasParsedCandidateData;\n  }`,
  'elegibilidad del preview inicial'
);
fs.writeFileSync(webhookPath, webhook);

const parityPath = 'test/conversationEngineParity.test.js';
let parity = fs.readFileSync(parityPath, 'utf8');
parity = replaceOnce(
  parity,
  `  for (const snapshot of [withoutEngine, withEngine]) {\n    assert.equal(snapshot.candidate.currentStep, 'GREETING_SENT');\n    assert.equal(snapshot.candidate.vacancyId, null);\n    assert.equal(snapshot.candidate.botResumeMode, 'future_profile_offer');\n    assert.deepEqual(snapshot.candidate.capturedFields, []);\n    assert.equal(snapshot.candidate.hasCv, false);\n    assert.deepEqual(snapshot.outbound.sources, ['vacancy_first_gate']);\n    assert.deepEqual(snapshot.bookings, []);\n  }\n});`,
  `  for (const snapshot of [withoutEngine, withEngine]) {\n    assert.equal(snapshot.candidate.currentStep, 'GREETING_SENT');\n    assert.equal(snapshot.candidate.vacancyId, null);\n    assert.equal(snapshot.candidate.botResumeMode, 'future_profile_offer');\n    assert.deepEqual(snapshot.candidate.capturedFields, []);\n    assert.equal(snapshot.candidate.hasCv, false);\n    assert.deepEqual(snapshot.outbound.sources, ['vacancy_first_gate']);\n    assert.deepEqual(snapshot.bookings, []);\n  }\n  assert.equal(withEngine.openAi.byType.conversation_engine || 0, 0);\n  assert.deepEqual(withEngine.engine.previewConsumption, ['none']);\n});`,
  'regresión de ciudad sin preview'
);
parity = replaceOnce(
  parity,
  `test('la matriz ejecuta ambos modos en procesos aislados y reporta divergencias de dominio', () => {`,
  `test('datos personales tempranos conservan el preview útil antes de asociar vacante', () => {\n  const [withoutEngine] = runMode('false', ['ibague-greeting-interest-does-not-become-name-and-name-correction-advances']);\n  const [withEngine] = runMode('true', ['ibague-greeting-interest-does-not-become-name-and-name-correction-advances']);\n\n  assert.deepEqual(domainDifferences(withoutEngine, withEngine), []);\n  assert.ok((withEngine.openAi.byType.conversation_engine || 0) > 0);\n  assert.ok(withEngine.engine.previewConsumption.some((value) => value === 'fields' || value === 'fields_and_plan'));\n});\n\ntest('la matriz ejecuta ambos modos en procesos aislados y reporta divergencias de dominio', () => {`,
  'regresión de captura temprana útil'
);
fs.writeFileSync(parityPath, parity);

console.log('Issue #777 aplicado correctamente.');
