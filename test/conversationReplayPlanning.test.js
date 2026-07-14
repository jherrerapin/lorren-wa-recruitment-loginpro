import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConversationFixtures } from './conversation-replay/fixtureRepository.js';
import { replayFixtureInterpretation } from './conversation-replay/interpretationReplay.js';
import { replayFixturePlanning } from './conversation-replay/planningReplay.js';

function collectCandidateChanges(initialCandidate, finalState) {
  const keys = new Set([...Object.keys(initialCandidate || {}), ...Object.keys(finalState || {})]);
  const changed = [];

  for (const key of keys) {
    if (key === 'pendingFields') continue;
    if (!Object.hasOwn(finalState, key)) continue;
    if (!assert.deepEqual) continue;
    try {
      assert.deepEqual(finalState[key], initialCandidate?.[key]);
    } catch {
      changed.push(`candidate.${key}`);
    }
  }

  return changed;
}

function assertExpectedFinalState(expected, actual, label) {
  for (const [field, value] of Object.entries(expected || {})) {
    assert.deepEqual(actual[field], value, `${label}: estado final inesperado en ${field}`);
  }
}

function assertAuthorityEvidence(intent, replay, label) {
  if (intent === 'CONTINUE_APPLICATION') {
    assert.equal(replay.evidence.consentBoundary.block, true, `${label}: la frontera de consentimiento debe bloquear el turno`);
    assert.equal(replay.evidence.consentBoundary.reason, 'candidate_wants_to_continue', `${label}: debe conservar la razón real del gate`);
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
