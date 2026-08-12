import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandidateFields, parseNaturalData } from '../src/services/candidateData.js';
import { getCandidateReadiness } from '../src/services/readinessGuard.js';

const vacancy = Object.freeze({
  id: 'vacancy-replay-neiva',
  city: 'Neiva',
  experienceRequired: 'YES',
  experienceTimeText: '6 meses o más'
});

const completeBaseCandidate = Object.freeze({
  vacancyId: vacancy.id,
  fullName: 'Persona Ejemplo',
  documentType: 'CC',
  documentNumber: '10000000',
  age: 34,
  neighborhood: 'Barrio Ejemplo',
  medicalRestrictions: 'Sin restricciones médicas',
  transportMode: 'Moto'
});

test('replay seudonimizado Aug-8: una declaración multilínea conserva tiempo y contenido real de experiencia', () => {
  const parsed = normalizeCandidateFields(parseNaturalData(
    'Experiencia sí\nMás de 6 años en consumo masivo'
  ));

  assert.equal(parsed.experienceInfo, 'Sí');
  assert.equal(parsed.experienceTime, '6 años');
  assert.match(parsed.experienceSummary || '', /consumo masivo/i);
  assert.notEqual(parsed.experienceSummary, 'Experiencia sí');

  const readiness = getCandidateReadiness({
    ...completeBaseCandidate,
    ...parsed
  }, vacancy, { requireCv: false });

  assert.deepEqual(
    readiness.missingFields.filter((field) => field.startsWith('experience')),
    []
  );
});

test('una afirmación de experiencia no convierte una pregunta siguiente en resumen laboral', () => {
  const parsed = normalizeCandidateFields(parseNaturalData(
    'Experiencia sí\n¿Qué horario manejan?'
  ));

  assert.equal(parsed.experienceInfo, 'Sí');
  assert.equal(parsed.experienceSummary, undefined);
});

test('una afirmación de experiencia no convierte otro dato de perfil en resumen laboral', () => {
  const parsed = normalizeCandidateFields(parseNaturalData(
    'Experiencia sí\nBarrio Ejemplo'
  ));

  assert.equal(parsed.experienceInfo, 'Sí');
  assert.equal(parsed.experienceSummary, undefined);
});

test('una continuación inmediata con duración y contexto laboral sí conserva el resumen', () => {
  const parsed = normalizeCandidateFields(parseNaturalData(
    'Experiencia sí\n6 meses en bodega'
  ));

  assert.equal(parsed.experienceInfo, 'Sí');
  assert.equal(parsed.experienceTime, '6 meses');
  assert.match(parsed.experienceSummary || '', /bodega/i);
});
