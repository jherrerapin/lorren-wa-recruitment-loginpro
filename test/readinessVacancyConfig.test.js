import test from 'node:test';
import assert from 'node:assert/strict';
import { getCandidateReadiness, getMissingFieldLabels, getRequiredCandidateFieldKeys } from '../src/services/candidateReadiness.js';

const baseCandidate = {
  fullName: 'Ana Perez',
  documentType: 'CC',
  documentNumber: '123',
  age: 25,
  medicalRestrictions: 'Ninguna',
  transportMode: 'Moto',
  neighborhood: 'Centro'
};

test('readiness pide experiencia solo cuando la vacante la exige', () => {
  const withExperience = { id: 'vac-1', city: 'Ibague', experienceRequired: 'YES', experienceTimeText: 'mínimo 6 meses' };
  const withoutExperience = { id: 'vac-2', city: 'Ibague', experienceRequired: 'NO' };

  assert.deepEqual(getCandidateReadiness(baseCandidate, withoutExperience, { requireCv: false }).missingFields, []);
  assert.deepEqual(
    getCandidateReadiness(baseCandidate, withExperience, { requireCv: false }).missingFields,
    ['experienceInfo', 'experienceTime', 'experienceSummary']
  );
  assert.deepEqual(
    getMissingFieldLabels(baseCandidate, withExperience),
    ['experiencia (si o no)', 'tiempo de experiencia (mínimo 6 meses)', 'en qué tiene experiencia']
  );
});

test('readiness usa localidad para vacantes de Bogota y barrio para otras ciudades', () => {
  const bogota = { id: 'vac-bog', city: 'Bogota', experienceRequired: 'NO' };
  const ibague = { id: 'vac-iba', city: 'Ibague', experienceRequired: 'NO' };

  assert.equal(getRequiredCandidateFieldKeys(bogota).includes('locality'), true);
  assert.equal(getRequiredCandidateFieldKeys(bogota).includes('neighborhood'), false);
  assert.equal(getRequiredCandidateFieldKeys(ibague).includes('neighborhood'), true);
});

test('una configuración antigua no puede convertir género en campo obligatorio', () => {
  const vacancy = {
    id: 'vac-gender',
    city: 'Ibague',
    requiredCandidateFields: ['fullName', 'gender', 'Gender', 'age']
  };

  assert.deepEqual(getRequiredCandidateFieldKeys(vacancy), ['fullName', 'age']);
  assert.equal(
    getCandidateReadiness({ fullName: 'Ana Pérez', age: 25 }, vacancy, { requireCv: false })
      .missingFields.includes('gender'),
    false
  );
});
