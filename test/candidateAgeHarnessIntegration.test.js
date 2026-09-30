import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateDataPolicy } from '../src/core/engine/policies/candidateDataPolicy.js';
import { eligibilityPolicy } from '../src/core/engine/policies/eligibilityPolicy.js';
import { parseNaturalData } from '../src/services/candidateData.js';

test('métricas laborales no sobrescriben la edad existente ni disparan rechazo', async () => {
  const rawText = 'En operaciones logisticas mas de 12 años, y manejo de personal grupos mayores a 56 trabajadores por turno';
  const interpretedFields = parseNaturalData(rawText);

  assert.equal(interpretedFields.age ?? null, null);

  const mutation = await candidateDataPolicy({
    interpretation: { fields: interpretedFields }
  });
  assert.equal(mutation.mutations?.fieldsToPersist?.age, undefined);

  const eligibility = await eligibilityPolicy({
    candidate: { facts: { age: 42 } },
    interpretation: { fields: interpretedFields },
    vacancy: { minAge: 18, maxAge: 55 },
    execution: { mayReply: true }
  });

  assert.deepEqual(eligibility, {});
});
