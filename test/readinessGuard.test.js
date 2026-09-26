import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCandidateEligibility, getCandidateReadiness } from '../src/services/readinessGuard.js';
import {
  alignCandidateLocationFields,
  getCandidateResidenceValue,
  parseNaturalData
} from '../src/services/candidateData.js';

const baseCandidate = {
  id: 'candidate-1',
  vacancyId: 'vacancy-1',
  fullName: 'Andres Perez Gomez',
  documentType: 'CC',
  documentNumber: '1234567890',
  locality: 'Suba',
  medicalRestrictions: 'Sin restricciones médicas',
  transportMode: 'Publico'
};

const baseVacancy = {
  id: 'vacancy-1',
  city: 'Bogota',
  minAge: 18,
  maxAge: 50,
  experienceRequired: 'NO'
};

test('eligibilidad bloquea candidato menor al mínimo configurado en la vacante', () => {
  const candidate = { ...baseCandidate, age: 16 };
  const readiness = getCandidateReadiness(candidate, baseVacancy, { requireCv: false });

  assert.equal(readiness.coreDataComplete, false);
  assert.equal(readiness.readyForCvRequest, false);
  assert.equal(readiness.readyForScheduling, false);
  assert.equal(readiness.readyForDone, false);
  assert.equal(readiness.eligibility.eligible, false);
  assert.equal(readiness.eligibilityFailures[0].code, 'age_below_min');
  assert.match(readiness.blockedReasons.join('|'), /eligibility_age_below_min:age/);
});

test('eligibilidad bloquea candidato mayor al máximo configurado en la vacante', () => {
  const candidate = { ...baseCandidate, age: 56 };
  const readiness = getCandidateReadiness(candidate, baseVacancy, { requireCv: false });

  assert.equal(readiness.coreDataComplete, false);
  assert.equal(readiness.readyForCvRequest, false);
  assert.equal(readiness.readyForScheduling, false);
  assert.equal(readiness.readyForDone, false);
  assert.equal(readiness.eligibility.eligible, false);
  assert.equal(readiness.eligibilityFailures[0].code, 'age_above_max');
  assert.match(readiness.blockedReasons.join('|'), /eligibility_age_above_max:age/);
});

test('eligibilidad permite candidato dentro del rango configurado en la vacante', () => {
  const candidate = { ...baseCandidate, age: 30 };
  const readiness = getCandidateReadiness(candidate, baseVacancy, { requireCv: false });

  assert.equal(readiness.coreDataComplete, true);
  assert.equal(readiness.readyForDone, true);
  assert.equal(readiness.eligibility.eligible, true);
  assert.deepEqual(readiness.eligibilityFailures, []);
  assert.deepEqual(readiness.blockedReasons, []);
});

test('evaluateCandidateEligibility soporta vacantes solo con edad mínima o solo con edad máxima', () => {
  assert.equal(evaluateCandidateEligibility({ age: 17 }, { minAge: 18 }).failures[0].code, 'age_below_min');
  assert.equal(evaluateCandidateEligibility({ age: 51 }, { maxAge: 50 }).failures[0].code, 'age_above_max');
  assert.equal(evaluateCandidateEligibility({ age: 25 }, { minAge: 18 }).eligible, true);
  assert.equal(evaluateCandidateEligibility({ age: 25 }, { maxAge: 50 }).eligible, true);
});

test('replay #901: un municipio explícito satisface la residencia de una vacante de Bogotá sin pasar por webhook', () => {
  const vacancy = { ...baseVacancy, minAge: null, maxAge: null };
  const parsed = alignCandidateLocationFields(
    parseNaturalData('Localidad: Villa Prueba Cundinamarca'),
    vacancy
  );
  const candidate = {
    ...baseCandidate,
    age: 29,
    locality: parsed.locality ?? null,
    neighborhood: parsed.neighborhood ?? null
  };
  const readiness = getCandidateReadiness(candidate, vacancy, { requireCv: false });

  assert.equal(candidate.locality, null);
  assert.equal(candidate.neighborhood, 'Villa Prueba Cundinamarca');
  assert.equal(getCandidateResidenceValue(candidate, vacancy), 'Villa Prueba Cundinamarca');
  assert.equal(readiness.missingFields.includes('locality'), false);
  assert.equal(readiness.coreDataComplete, true);
});

test('la residencia municipal explícita no depende de una lista cerrada ni acepta un cargo como municipio', () => {
  const vacancy = { city: 'Bogota' };
  for (const text of ['Localidad: Villa Prueba Cundinamarca', 'Villa Prueba Cundinamarca']) {
    const fields = alignCandidateLocationFields(parseNaturalData(text), vacancy);
    assert.equal(getCandidateResidenceValue(fields, vacancy), 'Villa Prueba Cundinamarca', text);
  }

  const invalid = alignCandidateLocationFields(parseNaturalData('Auxiliar Cundinamarca'), vacancy);
  assert.equal(getCandidateResidenceValue(invalid, vacancy), null);
});
