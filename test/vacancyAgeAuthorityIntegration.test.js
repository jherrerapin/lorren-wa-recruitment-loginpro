import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateDataPolicy } from '../src/core/engine/policies/candidateDataPolicy.js';
import { eligibilityPolicy } from '../src/core/engine/policies/eligibilityPolicy.js';
import { parseNaturalData } from '../src/services/candidateData.js';
import { evaluateCandidateEligibility } from '../src/services/readinessGuard.js';

async function evaluateTurn({ text, persistedAge = null, vacancy }) {
  const interpretedFields = parseNaturalData(text);
  const mutation = await candidateDataPolicy({
    interpretation: { fields: interpretedFields }
  });
  const decision = await eligibilityPolicy({
    candidate: { facts: { age: persistedAge } },
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
