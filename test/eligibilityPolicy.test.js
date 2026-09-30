import test from 'node:test';
import assert from 'node:assert/strict';
import {
  eligibilityPolicy,
  evaluateEligibility
} from '../src/core/engine/policies/eligibilityPolicy.js';
import { candidateDataPolicy } from '../src/core/engine/policies/candidateDataPolicy.js';
import { parseNaturalData } from '../src/services/candidateData.js';
import { evaluateCandidateEligibility } from '../src/services/candidateReadiness.js';
import { conversationPolicies } from '../src/core/engine/calculateConversationDecision.js';

function input(facts = {}, fields = []) {
  return {
    candidate: {
      facts: {
        dataConsentStatus: 'ACCEPTED',
        vacancyActive: true,
        vacancyAcceptingApplications: true,
        ...facts
      }
    },
    pending: { fields }
  };
}

test('el pipeline evalúa elegibilidad inmediatamente después de chatPolicy', () => {
  assert.equal(conversationPolicies[1], eligibilityPolicy);
});

test('rechaza amablemente una edad inferior al mínimo configurado', () => {
  const decision = evaluateEligibility(input({ age: 17, minAge: 18, maxAge: 45 }));

  assert.equal(decision.transitions.endConversation, true);
  assert.match(decision.reply.text, /edad|futuras oportunidades/i);
});

test('rechaza amablemente una edad superior al máximo configurado', () => {
  const decision = evaluateEligibility(input({ age: 56, minAge: 18, maxAge: 50 }));

  assert.equal(decision.transitions.endConversation, true);
  assert.match(decision.reply.text, /edad|futuras oportunidades/i);
});

test('permite continuar cuando la edad está dentro del rango configurado', () => {
  assert.deepEqual(evaluateEligibility(input({
    age: 30,
    minAge: 18,
    maxAge: 50,
    experienceRequired: 'NO'
  })), {});
});

test('no rechaza por edad mientras ese dato todavía está pendiente', () => {
  assert.deepEqual(evaluateEligibility(input({ minAge: 18 }, ['age'])), {});
});

test('rechaza experiencia negativa cuando la vacante la exige', () => {
  const decision = eligibilityPolicy(input({
    experienceRequired: 'YES',
    experienceInfo: 'No'
  }));

  assert.equal(decision.transitions.endConversation, true);
  assert.match(decision.reply.text, /experiencia|futuras oportunidades/i);
});

test('no inventa incumplimiento cuando la experiencia aún está pendiente', () => {
  assert.deepEqual(eligibilityPolicy(input({ experienceRequired: 'YES' }, ['experienceInfo'])), {});
});

test('envía a revisión manual a una candidata completa en una vacante con agenda', () => {
  assert.deepEqual(eligibilityPolicy(input({
    gender: 'FEMALE',
    schedulingEnabled: true,
    age: 28,
    minAge: 18,
    experienceRequired: 'NO'
  })), {
    reply: { directive: 'INFORM_MANUAL_REVIEW' },
    mutations: {
      fieldsToPersist: {
        gender: 'FEMALE',
        botPaused: true,
        botPauseReason: 'Candidata femenina pendiente de revision humana',
        reminderState: 'SKIPPED',
        reminderScheduledFor: null
      },
      nextStep: 'MANUAL_REVIEW'
    },
    scheduling: { action: 'none' }
  });
});

test('espera a que datos y hoja de vida estén completos antes de revisión manual', () => {
  assert.deepEqual(eligibilityPolicy(input({
    gender: 'FEMALE',
    schedulingEnabled: true
  }, ['documentNumber', 'cv'])), {});
});

test('no intercepta vacantes configuradas como solo postulación', () => {
  assert.deepEqual(eligibilityPolicy(input({
    gender: 'FEMALE',
    schedulingEnabled: false
  })), {});
});

test('el consentimiento y el banco de talento conservan prioridad sobre elegibilidad', () => {
  assert.deepEqual(evaluateEligibility(input({
    dataConsentStatus: 'PENDING',
    age: 17,
    minAge: 18
  }, ['dataConsent'])), {});

  assert.deepEqual(evaluateEligibility(input({
    vacancyAcceptingApplications: false,
    age: 17,
    minAge: 18
  })), {});
});

async function evaluateTurn({ text, persistedAge = null, vacancy }) {
  const interpretedFields = parseNaturalData(text);
  const mutation = await candidateDataPolicy({
    interpretation: { fields: interpretedFields }
  });
  const decision = await eligibilityPolicy({
    candidate: {
      facts: {
        age: persistedAge,
        dataConsentStatus: 'ACCEPTED',
        vacancyActive: true,
        vacancyAcceptingApplications: true
      }
    },
    interpretation: { fields: interpretedFields },
    vacancy,
    execution: { mayReply: true }
  });
  const effectiveAge = mutation.mutations?.fieldsToPersist?.age ?? persistedAge;

  return {
    interpretedFields,
    mutation,
    decision,
    readinessEligibility: evaluateCandidateEligibility({ age: effectiveAge }, vacancy)
  };
}

test('una vacante sin edad máxima permite una edad mayor de 50', async () => {
  const result = await evaluateTurn({
    text: 'Tengo 56 años',
    vacancy: { minAge: 18, maxAge: null }
  });

  assert.equal(result.mutation.mutations?.fieldsToPersist?.age, 56);
  assert.equal(result.readinessEligibility.eligible, true);
  assert.deepEqual(result.decision, {});
});

test('un rango personalizado permite edades válidas por encima del antiguo máximo global', async () => {
  const result = await evaluateTurn({
    text: 'Tengo 56 años',
    vacancy: { minAge: 21, maxAge: 60 }
  });

  assert.equal(result.mutation.mutations?.fieldsToPersist?.age, 56);
  assert.equal(result.readinessEligibility.eligible, true);
  assert.deepEqual(result.decision, {});
});

test('una edad superior al máximo configurado usa el código y rango canónicos', async () => {
  const result = await evaluateTurn({
    text: 'Tengo 56 años',
    vacancy: { minAge: 18, maxAge: 55 }
  });
  const failure = result.readinessEligibility.failures[0];

  assert.equal(result.mutation.mutations?.fieldsToPersist?.age, 56);
  assert.equal(failure.code, 'age_above_max');
  assert.match(failure.message, /entre 18 y 55 años/i);
  assert.match(failure.details, /Edad detectada: 56/i);
  assert.match(failure.details, /Rango requerido: entre 18 y 55 años/i);
  assert.equal(result.decision.transitions?.endConversation, true);
  assert.match(result.decision.reply?.text, /no es posible continuar con tu postulación/i);
});

test('una edad inferior al mínimo personalizado usa la misma autoridad', async () => {
  const result = await evaluateTurn({
    text: 'Tengo 20 años',
    vacancy: { minAge: 21, maxAge: 60 }
  });
  const failure = result.readinessEligibility.failures[0];

  assert.equal(failure.code, 'age_below_min');
  assert.match(failure.details, /Rango requerido: entre 21 y 60 años/i);
  assert.equal(result.decision.transitions?.endConversation, true);
});

test('direcciones y cantidades laborales no se convierten en edad de rechazo', async () => {
  const result = await evaluateTurn({
    text: 'Vivo en la calle 56 y manejé grupos mayores a 60 trabajadores por turno',
    persistedAge: 42,
    vacancy: { minAge: 18, maxAge: 55 }
  });

  assert.equal(result.interpretedFields.age ?? null, null);
  assert.equal(result.mutation.mutations?.fieldsToPersist?.age, undefined);
  assert.equal(result.readinessEligibility.age, 42);
  assert.equal(result.readinessEligibility.eligible, true);
  assert.deepEqual(result.decision, {});
});
