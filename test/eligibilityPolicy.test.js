import test from 'node:test';
import assert from 'node:assert/strict';
import {
  eligibilityPolicy,
  evaluateEligibility
} from '../src/core/engine/policies/eligibilityPolicy.js';
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
