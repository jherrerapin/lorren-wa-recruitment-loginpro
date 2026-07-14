import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConsentPendingMode } from '../src/services/dataConsentGate.js';
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

test('un pie de adjunto que parece autorizar no salta la protección del archivo', async () => {
  const fixture = fixtureById('attachment-document-before-consent-v1');
  fixture.id = 'synthetic-captioned-document';
  fixture.inbound.caption = 'Sí, autorizo el tratamiento de mis datos';

  const interpretation = await replayFixtureInterpretation(fixture);
  const planning = replayFixturePlanning(fixture, interpretation);

  assert.equal(interpretation.interpretation.consentDecision, 'ACCEPTED');
  assert.deepEqual(planning.plan.actions.map((action) => action.type), [
    'REJECT_PRECONSENT_ATTACHMENT',
    'ASK_DATA_CONSENT'
  ]);
  assert.equal(planning.finalState.dataConsentStatus, 'PENDING');
  assert.equal(planning.evidence.consentBoundary.reason, 'attachment_before_consent');
});

test('un adjunto conserva el contexto de perfil futuro y marca reenvío', async () => {
  const fixture = fixtureById('attachment-document-before-consent-v1');
  fixture.id = 'synthetic-future-profile-attachment';
  fixture.initialState.candidate.botResumeMode = 'future_profile_offer';

  const interpretation = await replayFixtureInterpretation(fixture);
  const planning = replayFixturePlanning(fixture, interpretation);
  const pending = parseConsentPendingMode(planning.finalState.botResumeMode);

  assert.equal(planning.evidence.consentBoundary.reason, 'attachment_before_consent');
  assert.equal(pending.pending, true);
  assert.equal(pending.resumeMode, 'future_profile_offer');
  assert.equal(pending.cvResendRequired, true);
});

test('un adjunto en modo de captura conserva ese modo al pedir autorización', async () => {
  const fixture = fixtureById('attachment-document-before-consent-v1');
  fixture.id = 'synthetic-capture-mode-attachment';
  fixture.initialState.candidate.botResumeMode = 'future_profile_capture';

  const interpretation = await replayFixtureInterpretation(fixture);
  const planning = replayFixturePlanning(fixture, interpretation);
  const pending = parseConsentPendingMode(planning.finalState.botResumeMode);

  assert.equal(planning.evidence.consentBoundary.reason, 'capture_mode_without_consent');
  assert.equal(pending.resumeMode, 'future_profile_capture');
  assert.equal(pending.cvResendRequired, true);
});

test('un adjunto posterior a revocatoria sigue protegido y permite nueva autorización', async () => {
  const fixture = fixtureById('attachment-document-before-consent-v1');
  fixture.id = 'synthetic-revoked-consent-attachment';
  fixture.initialState.candidate.dataConsentStatus = 'REVOKED';

  const interpretation = await replayFixtureInterpretation(fixture);
  const planning = replayFixturePlanning(fixture, interpretation);
  const pending = parseConsentPendingMode(planning.finalState.botResumeMode);

  assert.equal(planning.evidence.consentBoundary.reason, 'consent_revoked');
  assert.deepEqual(planning.plan.actions.map((action) => action.type), [
    'REJECT_PRECONSENT_ATTACHMENT',
    'ASK_DATA_CONSENT'
  ]);
  assert.equal(pending.pending, true);
  assert.equal(pending.cvResendRequired, true);
});
