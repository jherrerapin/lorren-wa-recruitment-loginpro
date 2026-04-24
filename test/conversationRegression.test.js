import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFieldPolicy } from '../src/services/policyLayer.js';
import {
  alignCandidateLocationFields,
  getCandidateResidenceValue,
  getResidenceFieldConfig,
  looksLikeNoMedicalRestrictionsText,
  normalizeCandidateFields,
  parseNaturalData
} from '../src/services/candidateData.js';

const BOGOTA_VACANCY = {
  city: 'Bogota',
  operation: {
    city: {
      name: 'Bogota'
    }
  }
};

test('regresion real: no guarda saludos como barrio/localidad', () => {
  const policyResult = applyFieldPolicy({
    fields: {
      neighborhood: 'Tardes',
      locality: 'Tardes',
      zone: 'Tardes'
    },
    fieldEvidence: {
      neighborhood: { confidence: 0.95, snippet: 'Tardes', source: 'model' },
      locality: { confidence: 0.95, snippet: 'Tardes', source: 'model' },
      zone: { confidence: 0.95, snippet: 'Tardes', source: 'model' }
    }
  });

  assert.equal(policyResult.persistedFields.neighborhood, undefined);
  assert.equal(policyResult.persistedFields.locality, undefined);
  assert.equal(policyResult.persistedFields.zone, undefined);
  assert.deepEqual(
    policyResult.blocked.map((item) => item.reason),
    [
      'conversational_noise_as_location',
      'conversational_noise_as_location',
      'conversational_noise_as_location'
    ]
  );
});

test('regresion real: Bogota usa localidad como residencia principal', () => {
  assert.equal(getResidenceFieldConfig(BOGOTA_VACANCY).field, 'locality');

  const aligned = alignCandidateLocationFields(
    { neighborhood: 'Suba' },
    BOGOTA_VACANCY,
    { clearAlternate: true }
  );

  assert.equal(aligned.locality, 'Suba');
  assert.equal(aligned.neighborhood, null);
  assert.equal(getCandidateResidenceValue(aligned, BOGOTA_VACANCY), 'Suba');
});

test('regresion real: respuesta informal de salud se entiende como sin restricciones medicas', () => {
  const examples = [
    'No tengo q pena',
    'No tengo qué pena',
    'Estoy BN de salud',
    'Estoy bien de salud',
    'bien de salud'
  ];

  for (const example of examples) {
    const parsed = parseNaturalData(example);
    const normalized = normalizeCandidateFields(parsed);
    const detected = normalized.medicalRestrictions
      || (looksLikeNoMedicalRestrictionsText(example, { allowImplicit: true }) ? 'Sin restricciones médicas' : undefined);

    assert.equal(detected, 'Sin restricciones médicas', example);
  }
});

test('regresion real: bloque de datos del candidato queda normalizado', () => {
  const input = `Héctor José Benítez pájaro
Cc 1068736539
Edad 21
Transporte bicicleta`;

  const parsed = parseNaturalData(input);
  const normalized = normalizeCandidateFields(parsed);

  assert.equal(normalized.fullName, 'Héctor José Benítez Pájaro');
  assert.equal(normalized.documentType, 'CC');
  assert.equal(normalized.documentNumber, '1068736539');
  assert.equal(normalized.age, 21);
  assert.equal(normalized.transportMode, 'Bicicleta');
});
