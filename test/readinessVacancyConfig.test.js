import test from 'node:test';
import assert from 'node:assert/strict';
import { getCandidateReadiness, getMissingFieldLabels, getRequiredCandidateFieldKeys } from '../src/services/readinessGuard.js';

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
  assert.deepEqual(getCandidateReadiness(baseCandidate, withExperience, { requireCv: false }).missingFields, ['experienceInfo', 'experienceTime']);
  assert.deepEqual(getMissingFieldLabels(baseCandidate, withExperience), ['experiencia (si o no)', 'tiempo de experiencia (mínimo 6 meses)']);
});

test('readiness usa localidad para vacantes de Bogota y barrio para otras ciudades', () => {
  const bogota = { id: 'vac-bog', city: 'Bogota', experienceRequired: 'NO' };
  const ibague = { id: 'vac-iba', city: 'Ibague', experienceRequired: 'NO' };

  assert.equal(getRequiredCandidateFieldKeys(bogota).includes('locality'), true);
  assert.equal(getRequiredCandidateFieldKeys(bogota).includes('neighborhood'), false);
  assert.equal(getRequiredCandidateFieldKeys(ibague).includes('neighborhood'), true);
});
