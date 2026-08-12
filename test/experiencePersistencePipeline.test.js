import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationUnderstanding } from '../src/services/conversationUnderstanding.js';
import { getCandidateReadiness } from '../src/services/readinessGuard.js';

const EXPERIENCE_VACANCY = Object.freeze({
  id: 'vacancy-experience-test',
  experienceRequired: 'YES',
  experienceTimeText: '1 año o más'
});

const COMPLETE_BASE_CANDIDATE = Object.freeze({
  vacancyId: EXPERIENCE_VACANCY.id,
  fullName: 'Persona Ejemplo',
  documentType: 'CC',
  documentNumber: '10000000',
  age: 30,
  neighborhood: 'Barrio Ejemplo',
  medicalRestrictions: 'Sin restricciones médicas',
  transportMode: 'Moto'
});

test('la experiencia explícita atraviesa interpretación y sanitización sin volver a quedar pendiente', async () => {
  const text = 'He trabajado como coordinador operativo liderando equipos de logística y transporte.';
  const pendingFields = [
    'experiencia (si o no)',
    'tiempo de experiencia (1 año o más)',
    'en qué tiene experiencia'
  ];

  const result = await conversationUnderstanding(text, {
    context: {
      currentStep: 'COLLECTING_DATA',
      pendingFields
    }
  });

  assert.equal(result.candidateFields.experienceInfo, 'Sí');
  assert.equal(result.candidateFields.experienceSummary, text);

  const readiness = getCandidateReadiness({
    ...COMPLETE_BASE_CANDIDATE,
    ...result.candidateFields,
    experienceTime: '3 años'
  }, EXPERIENCE_VACANCY, { requireCv: false });

  assert.equal(readiness.missingFields.includes('experienceSummary'), false);
  assert.deepEqual(readiness.missingFields, []);
});
