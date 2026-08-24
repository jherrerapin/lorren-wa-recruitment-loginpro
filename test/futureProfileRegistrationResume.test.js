import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FUTURE_PROFILE_CAPTURE_MODE,
  FUTURE_PROFILE_OFFER_MODE,
  VacancyFirstGateAction,
  resolveVacancyFirstGate
} from '../src/services/vacancyFirstGate.js';

// Replay seudonimizado de #1414: la oferta persistida debe bastar aunque el outbound ya no esté en la ventana reciente.
function futureProfileCandidate(overrides = {}) {
  return {
    id: 'cand-future-profile-replay',
    status: 'NUEVO',
    currentStep: 'GREETING_SENT',
    vacancyId: null,
    botResumeMode: FUTURE_PROFILE_OFFER_MODE,
    dataConsentStatus: 'ACCEPTED',
    ...overrides
  };
}

async function decide(text, { recentMessages = [], candidate = futureProfileCandidate() } = {}) {
  return resolveVacancyFirstGate({
    prisma: null,
    candidate,
    currentVacancy: null,
    inboundText: text,
    currentStep: candidate.currentStep,
    recentMessages,
    vacancyHints: {
      allVacancies: [],
      activeVacancies: []
    }
  });
}

test('replay: sí simple retoma registro futuro aunque la oferta ya no esté en historial reciente', async () => {
  const decision = await decide('Sí');

  assert.equal(decision.action, VacancyFirstGateAction.ENTER_FUTURE_PROFILE_CONSENT);
  assert.equal(decision.reason, 'NO_ACTIVE_VACANCY_FUTURE_PROFILE_ACCEPTED');
  assert.equal(decision.candidateUpdates.currentStep, 'COLLECTING_DATA');
  assert.equal(decision.candidateUpdates.botResumeMode, FUTURE_PROFILE_CAPTURE_MODE);
  assert.equal(decision.candidateUpdates.vacancyId, undefined);
  assert.match(decision.reply, /registro para futuras aperturas/i);
});

test('una pregunta sigue teniendo prioridad y no autoriza registro futuro', async () => {
  const decision = await decide('Sí, pero ¿qué vacantes hay?');

  assert.notEqual(decision.action, VacancyFirstGateAction.ENTER_FUTURE_PROFILE_CONSENT);
});

test('un acuse pasivo no inicia captura aunque falte el outbound de la oferta', async () => {
  const decision = await decide('Bueno');

  assert.equal(decision.action, VacancyFirstGateAction.SUPPRESS_REPLY);
  assert.equal(decision.reason, 'PASSIVE_ACK_AFTER_FUTURE_PROFILE_OFFER');
});
