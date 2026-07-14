import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { parseConsentPendingMode } from '../src/services/dataConsentGate.js';
import { loadConversationFixtures } from './conversation-replay/fixtureRepository.js';
import { replayFixtureInterpretation } from './conversation-replay/interpretationReplay.js';
import { replayFixturePlanning } from './conversation-replay/planningReplay.js';

function collectCandidateChanges(initialCandidate, finalState) {
  const keys = new Set([...Object.keys(initialCandidate), ...Object.keys(finalState)]);
  const changed = [];

  for (const key of keys) {
    if (key === 'pendingFields' || !Object.hasOwn(finalState, key)) continue;
    const initialValue = Object.hasOwn(initialCandidate, key) ? initialCandidate[key] : undefined;
    if (!isDeepStrictEqual(finalState[key], initialValue)) changed.push(`candidate.${key}`);
  }

  return changed;
}

function assertForbiddenWriteWasNotApplied(forbiddenWrite, fixture, finalState, label) {
  if (!forbiddenWrite.startsWith('candidate.')) return;
  const field = forbiddenWrite.slice('candidate.'.length);
  const actual = Object.hasOwn(finalState, field) ? finalState[field] : undefined;
  const initialCandidate = fixture.initialState.candidate;
  const expected = Object.hasOwn(initialCandidate, field) ? initialCandidate[field] : undefined;
  assert.deepEqual(
    actual,
    expected,
    `${label}: una escritura prohibida modificó candidate.${field}`
  );
}

function assertExpectedFinalState(expected, actual, label) {
  for (const [field, value] of Object.entries(expected)) {
    assert.deepEqual(actual[field], value, `${label}: estado final inesperado en ${field}`);
  }
}

function assertConsentDecisionEvidence(intent, replay, label) {
  const expectedStatus = intent === 'ACCEPT_DATA_CONSENT' ? 'ACCEPTED' : 'REVOKED';
  const expectedStep = expectedStatus === 'ACCEPTED' ? 'COLLECTING_DATA' : 'DONE';
  assert.equal(replay.evidence.consentDecision, expectedStatus, `${label}: decisión de consentimiento incorrecta`);
  assert.equal(replay.evidence.consentUpdate.dataConsentStatus, expectedStatus, `${label}: estado persistido incorrecto`);
  assert.equal(replay.evidence.consentUpdate.currentStep, expectedStep, `${label}: transición de consentimiento incorrecta`);
  assert.equal(replay.evidence.consentEvent.status, expectedStatus, `${label}: evento de consentimiento incorrecto`);
  assert.equal(replay.evidence.consentEvent.version, 'lorren-v2-2026-07-v3', `${label}: versión de consentimiento incorrecta`);
}

function assertAuthorityEvidence(intent, replay, label) {
  if (intent === 'CONTINUE_APPLICATION') {
    assert.equal(replay.evidence.consentBoundary.block, true, `${label}: la frontera de consentimiento debe bloquear el turno`);
    assert.equal(replay.evidence.consentBoundary.reason, 'candidate_wants_to_continue', `${label}: debe conservar la razón real del gate`);
  }

  if (intent === 'ACCEPT_DATA_CONSENT' || intent === 'REJECT_DATA_CONSENT') {
    assertConsentDecisionEvidence(intent, replay, label);
  }

  if (intent === 'SEND_ATTACHMENT') {
    assert.equal(replay.evidence.consentBoundary.block, true, `${label}: el adjunto debe quedar bloqueado antes del consentimiento`);
    assert.equal(replay.evidence.consentBoundary.reason, 'attachment_before_consent', `${label}: razón de bloqueo incorrecta`);
    const pending = parseConsentPendingMode(replay.finalState.botResumeMode);
    assert.equal(pending.pending, true, `${label}: debe quedar consentimiento pendiente`);
    assert.equal(pending.cvResendRequired, true, `${label}: debe solicitarse reenvío del archivo después de autorizar`);
  }

  if (intent === 'ASK_VACANCY_SCHEDULE') {
    assert.equal(replay.evidence.contextualDecision.allowedAction, 'CONTINUE_FLOW', `${label}: el gate contextual debe permitir continuar`);
    assert.match(replay.evidence.vacancyAnswer, /turnos rotativos/i, `${label}: la respuesta debe salir de las condiciones registradas`);
  }

  if (intent === 'CORRECT_CANDIDATE_DATA') {
    assert.deepEqual(replay.evidence.fieldPolicy.persistedFields, { locality: 'Engativá' }, `${label}: la política debe autorizar solo la corrección sustentada`);
    assert.deepEqual(replay.evidence.fieldPolicy.blocked, [], `${label}: la corrección no debe quedar bloqueada`);
    assert.deepEqual(replay.evidence.fieldPolicy.reviewQueue, [], `${label}: la corrección no debe ir a revisión por baja confianza`);
  }
}

test('el replay determinístico reproduce acciones, escrituras y transiciones protegidas', async (t) => {
  for (const { fixture, relativePath } of loadConversationFixtures()) {
    await t.test(relativePath, async () => {
      const interpretation = await replayFixtureInterpretation(fixture);
      const replay = replayFixturePlanning(fixture, interpretation);
      const expectedPlan = fixture.expected.plan;

      assert.deepEqual(replay.plan.actions, expectedPlan.actions, `${relativePath}: cambió la secuencia de acciones`);
      assert.deepEqual(replay.plan.allowedWrites, expectedPlan.allowedWrites, `${relativePath}: cambiaron las escrituras permitidas`);
      assert.equal(replay.plan.nextStep, expectedPlan.nextStep, `${relativePath}: cambió la transición esperada`);

      if (Object.hasOwn(expectedPlan, 'pendingField')) {
        assert.equal(replay.plan.pendingField, expectedPlan.pendingField, `${relativePath}: cambió el campo pendiente`);
      }

      for (const forbiddenWrite of expectedPlan.forbiddenWrites) {
        assert.ok(
          !replay.plan.allowedWrites.includes(forbiddenWrite),
          `${relativePath}: una escritura prohibida fue autorizada: ${forbiddenWrite}`
        );
        assertForbiddenWriteWasNotApplied(forbiddenWrite, fixture, replay.finalState, relativePath);
      }

      const changedCandidatePaths = collectCandidateChanges(fixture.initialState.candidate, replay.finalState);
      for (const changedPath of changedCandidatePaths) {
        assert.ok(
          replay.plan.allowedWrites.includes(changedPath),
          `${relativePath}: el estado cambió sin permiso explícito: ${changedPath}`
        );
      }

      assertExpectedFinalState(fixture.expected.finalState, replay.finalState, relativePath);
      assertAuthorityEvidence(fixture.expected.interpretation.intent, replay, relativePath);
    });
  }
});
