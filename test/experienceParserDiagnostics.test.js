import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandidateFields, parseNaturalData } from '../src/services/candidateData.js';

const samples = [
  'He trabajado como coordinador operativo liderando equipos de logística y transporte.',
  'Experiencia en operaciones logísticas y coordinación de equipos.',
  'Coordinación de operaciones logísticas durante la jornada.',
  'En operaciones logísticas más de 12 años, y manejo de personal grupos mayores a 56 trabajadores por turno'
];

const diagnostic = samples.map((text) => ({ text, parsed: normalizeCandidateFields(parseNaturalData(text)) }));

test(`DIAGNOSTICO_TEMPORAL ${JSON.stringify(diagnostic)}`, () => {
  assert.fail('diagnostico temporal; retirar antes de merge');
});
