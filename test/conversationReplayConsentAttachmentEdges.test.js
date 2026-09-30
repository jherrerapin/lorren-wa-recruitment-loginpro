import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConversationFixtures } from './conversation-replay/fixtureRepository.js';
import { replayFixtureInterpretation } from './conversation-replay/interpretationReplay.js';
import { replayFixturePlanning } from './conversation-replay/planningReplay.js';

function fixtureById(id) {
  const entry = loadConversationFixtures().find(({ fixture }) => fixture.id === id);
  assert.ok(entry, `fixture no encontrado: ${id}`);
  return structuredClone(entry.fixture);
}

test('un botón interactivo usa la forma real y solicita consentimiento', async () => {
  const fixture = fixtureById('consent-interest-is-not-consent-v1');
  fixture.id = 'synthetic-interactive-interest';
  fixture.inbound = {
    messageId: 'test-message-interactive-interest',
    type: 'interactive',
    body: 'Sí, me interesa continuar'
  };

  const interpretation = await replayFixtureInterpretation(fixture);
  const planning = replayFixturePlanning(fixture, interpretation);

  assert.equal(interpretation.interpretation.intent, 'CONTINUE_APPLICATION');
  assert.deepEqual(planning.plan.actions, [{ type: 'ASK_DATA_CONSENT' }]);
  assert.equal(planning.evidence.consentBoundary.reason, 'candidate_wants_to_continue');
});

test('un adjunto previo al consentimiento entra al contrato funcional sin habilitar progresión', async () => {
  const fixture = fixtureById('attachment-document-before-consent-v1');
  const interpretation = await replayFixtureInterpretation(fixture);
  const planning = replayFixturePlanning(fixture, interpretation);

  assert.deepEqual(planning.plan.actions.map((action) => action.type), [
    'functional_core_attachment'
  ]);
  assert.equal(planning.plan.actions[0].payload.consentStatus, 'PENDING');
  assert.equal(planning.finalState.dataConsentStatus, 'PENDING');
  assert.equal(planning.finalState.currentStep, 'GREETING_SENT');
  assert.equal(planning.finalState.botResumeMode, null);
});

test('un pie de adjunto no convierte la persistencia de evidencia en progresión legal', async () => {
  const fixture = fixtureById('attachment-document-before-consent-v1');
  fixture.id = 'synthetic-captioned-document';
  fixture.inbound.caption = 'Sí, autorizo el tratamiento de mis datos';

  const interpretation = await replayFixtureInterpretation(fixture);
  const planning = replayFixturePlanning(fixture, interpretation);

  assert.equal(interpretation.interpretation.consentDecision, 'ACCEPTED');
  assert.equal(planning.plan.actions[0].type, 'functional_core_attachment');
  assert.equal(planning.plan.actions[0].payload.consentStatus, 'PENDING');
  assert.equal(planning.finalState.dataConsentStatus, 'PENDING');
});

test('un adjunto con consentimiento revocado conserva evidencia sin reactivar el proceso', async () => {
  const fixture = fixtureById('attachment-document-before-consent-v1');
  fixture.id = 'synthetic-revoked-consent-attachment';
  fixture.initialState.candidate.dataConsentStatus = 'REVOKED';

  const interpretation = await replayFixtureInterpretation(fixture);
  const planning = replayFixturePlanning(fixture, interpretation);

  assert.equal(planning.plan.actions[0].type, 'functional_core_attachment');
  assert.equal(planning.plan.actions[0].payload.consentStatus, 'REVOKED');
  assert.equal(planning.finalState.dataConsentStatus, 'REVOKED');
  assert.equal(planning.finalState.currentStep, 'GREETING_SENT');
});
