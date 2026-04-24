import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alignCandidateLocationFields,
  getCandidateResidenceValue,
  getResidenceFieldConfig,
  normalizeCandidateFields,
  parseNaturalData
} from '../src/services/candidateData.js';
import { conversationUnderstanding } from '../src/services/conversationUnderstanding.js';

const BOGOTA_VACANCY = {
  city: 'Bogota',
  operation: {
    city: {
      name: 'Bogota'
    }
  }
};

test('regresion real: fragmento conversacional aislado no produce ubicacion candidata', () => {
  const parsed = parseNaturalData('Tardes');
  const normalized = normalizeCandidateFields(parsed);

  assert.equal(normalized.neighborhood, undefined);
  assert.equal(normalized.locality, undefined);
  assert.equal(normalized.zone, undefined);
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

test('regresion real: si la IA entiende una respuesta contextual, el parser local no la bloquea', async () => {
  const understanding = await conversationUnderstanding('respuesta corta del candidato sobre su estado de salud', {
    context: {
      currentStep: 'COLLECTING_DATA',
      pendingFields: ['medicalRestrictions'],
      lastBotQuestion: 'Indica si tienes alguna restricción médica.'
    },
    aiResult: {
      status: 'ok',
      intent: 'continue_flow',
      parsedFields: {
        medicalRestrictions: 'Sin restricciones médicas'
      },
      extraction: {
        fieldEvidence: {
          medicalRestrictions: {
            snippet: 'respuesta corta del candidato sobre su estado de salud',
            confidence: 0.93,
            source: 'model_context'
          }
        }
      }
    }
  });

  assert.equal(understanding.candidateFields.medicalRestrictions, 'Sin restricciones médicas');
  assert.equal(understanding.intent, 'provide_data');
  assert.equal(understanding.fieldConfidence.medicalRestrictions, 0.93);
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
