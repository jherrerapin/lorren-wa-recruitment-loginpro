import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateDataPolicy } from '../src/core/engine/policies/candidateDataPolicy.js';
import { eligibilityPolicy } from '../src/core/engine/policies/eligibilityPolicy.js';
import { parseNaturalData } from '../src/services/candidateData.js';

const CASES = [
  {
    id: 'ibague-flow-name-correction-and-transport-list',
    text: 'Cedula de ciudadania\n1007788013\n24 anos\nModelia\nNinguna restriccion medica\nMoto',
    expectedAge: 24
  },
  {
    id: 'ibague-role-phrase-does-not-become-name-and-name-correction-sticks',
    text: 'Cedula\n1082129284\n30 anos\nMoto\nSin restriccion medica',
    expectedAge: 30
  },
  {
    id: 'future-birthday-keeps-current-age-and-does-not-repeat-transport',
    text: 'Johan Sebastian Carrillo Aldana, 18 años el otro mes cumplo 19, restricciones medicas ninguna,medio de transporte cicla',
    expectedAge: 18
  }
];

for (const scenario of CASES) {
  test(`${scenario.id} conserva la edad explícita correcta en el núcleo funcional`, async () => {
    const interpretedFields = parseNaturalData(scenario.text);
    assert.equal(interpretedFields.age, scenario.expectedAge);

    const mutation = await candidateDataPolicy({
      interpretation: { fields: interpretedFields }
    });
    assert.equal(mutation.mutations?.fieldsToPersist?.age, scenario.expectedAge);

    const eligibility = await eligibilityPolicy({
      candidate: { facts: { age: null } },
      interpretation: { fields: interpretedFields },
      vacancy: { minAge: 18, maxAge: 60 },
      execution: { mayReply: true }
    });
    assert.deepEqual(eligibility, {});
  });
}
