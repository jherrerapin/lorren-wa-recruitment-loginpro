import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getMissingProfileFields,
  isProfileComplete,
  shouldConfirmOnce
} from '../src/services/profileConfirmPolicy.js';

const requiredFields = [
  'fullName',
  'documentType',
  'documentNumber',
  'age',
  'residence',
  'medicalRestrictions',
  'transportMode',
  'experienceInfo',
  'experienceTime'
];

const completeProfile = {
  fullName: 'Gloria Pineda',
  documentType: 'CC',
  documentNumber: '28951218',
  age: 44,
  neighborhood: 'Arkala',
  medicalRestrictions: 'Sin restricciones médicas',
  transportMode: 'Moto',
  experienceInfo: 'Sí',
  experienceTime: '1 año'
};

test('no confirma mientras falten datos del perfil', () => {
  const profile = { ...completeProfile, medicalRestrictions: null };

  assert.equal(isProfileComplete(profile, requiredFields), false);
  assert.deepEqual(getMissingProfileFields(profile, requiredFields), ['medicalRestrictions']);
  assert.equal(shouldConfirmOnce({ profile, requiredFields }), false);
});

test('confirma una sola vez cuando el perfil esta completo', () => {
  assert.equal(isProfileComplete(completeProfile, requiredFields), true);
  assert.equal(shouldConfirmOnce({ profile: completeProfile, requiredFields }), true);
  assert.equal(shouldConfirmOnce({ profile: completeProfile, requiredFields, alreadyConfirming: true }), false);
  assert.equal(shouldConfirmOnce({ profile: completeProfile, requiredFields, confirmationAccepted: true }), false);
});

test('residencia puede venir como barrio localidad o zona', () => {
  const withLocality = { ...completeProfile, neighborhood: null, locality: 'Kennedy' };
  const withZone = { ...completeProfile, neighborhood: null, locality: null, zone: 'Soacha Cundinamarca' };

  assert.equal(isProfileComplete(withLocality, requiredFields), true);
  assert.equal(isProfileComplete(withZone, requiredFields), true);
});
