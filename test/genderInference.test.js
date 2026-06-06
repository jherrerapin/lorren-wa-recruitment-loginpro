import test from 'node:test';
import assert from 'node:assert/strict';

import { inferGenderEvidence } from '../src/services/genderInference.js';

test('declaracion directa tiene prioridad', () => {
  const result = inferGenderEvidence({ fullName: 'Gloria Pineda', text: 'soy hombre' });
  assert.equal(result.gender, 'MALE');
  assert.equal(result.source, 'declared');
});

test('marca gramatical femenina se detecta sin preguntar', () => {
  const result = inferGenderEvidence({ text: 'estoy interesada en la vacante' });
  assert.equal(result.gender, 'FEMALE');
  assert.equal(result.source, 'language_cue');
});

test('marca gramatical masculina se detecta sin preguntar', () => {
  const result = inferGenderEvidence({ text: 'quedo atento a la informacion' });
  assert.equal(result.gender, 'MALE');
  assert.equal(result.source, 'language_cue');
});

test('nombre Gloria infiere femenino con evidencia y confianza limitada', () => {
  const result = inferGenderEvidence({ fullName: 'Gloria Pineda' });
  assert.equal(result.gender, 'FEMALE');
  assert.equal(result.source, 'name_pattern');
  assert.equal(result.evidence, 'gloria');
  assert.ok(result.confidence < 0.8);
});
