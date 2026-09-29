import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandidateFields, parseNaturalData } from '../src/services/candidateData.js';

test('bloque corto conserva edad, restricción y más de cuatro años de experiencia', () => {
  const normalized = normalizeCandidateFields(parseNaturalData('28, no tengo restricción médica, sí, más de 4 años'));
  assert.equal(normalized.age, 28);
  assert.equal(normalized.medicalRestrictions, 'Sin restricciones médicas');
  assert.equal(normalized.experienceInfo, 'Sí');
  assert.equal(normalized.experienceTime, '4 años');
});

test('cuatro años nunca se normaliza como tres años', () => {
  const normalized = normalizeCandidateFields(parseNaturalData('Tengo cuatro años de experiencia en logística'));
  assert.equal(normalized.experienceTime, '4 años');
});
