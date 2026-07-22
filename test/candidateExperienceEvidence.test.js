import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCandidateFieldsForConversation } from '../src/services/fieldSanitizer.js';

function sanitizeExperience({ value, text, context = {}, turnType = 'PROVIDE_DATA' }) {
  return sanitizeCandidateFieldsForConversation({
    fields: { experienceInfo: value },
    evidence: {
      experienceInfo: {
        snippet: String(value),
        confidence: 0.94,
        source: 'local_parser'
      }
    },
    text,
    context,
    turnType
  });
}

test('acepta Sí cuando el mensaje contiene experiencia laboral explícita', () => {
  const result = sanitizeExperience({
    value: 'Sí',
    text: 'En operaciones logísticas llevo más de 12 años y manejo personal por turno',
    context: { currentStep: 'COLLECTING_DATA' }
  });

  assert.equal(result.fields.experienceInfo, 'Sí');
});

test('acepta No cuando el candidato niega explícitamente tener experiencia', () => {
  const result = sanitizeExperience({
    value: 'No',
    text: 'No tengo experiencia laboral todavía',
    context: { currentStep: 'COLLECTING_DATA' }
  });

  assert.equal(result.fields.experienceInfo, 'No');
});

test('acepta respuesta corta cuando experiencia está pendiente', () => {
  const result = sanitizeExperience({
    value: 'Sí',
    text: 'sí',
    context: {
      currentStep: 'COLLECTING_DATA',
      pendingFields: ['experiencia (si o no)'],
      lastBotQuestion: '¿Tienes experiencia para este cargo?'
    },
    turnType: 'CONFIRMATION'
  });

  assert.equal(result.fields.experienceInfo, 'Sí');
});

test('rechaza Sí de interés general sin evidencia de experiencia', () => {
  const result = sanitizeExperience({
    value: 'Sí',
    text: 'sí estoy interesado en la vacante',
    context: { currentStep: 'GREETING_SENT' },
    turnType: 'CONFIRMATION'
  });

  assert.equal(result.fields.experienceInfo, undefined);
});

test('rechaza una propuesta positiva que contradice una negación explícita', () => {
  const result = sanitizeExperience({
    value: 'Sí',
    text: 'no tengo experiencia ni he trabajado antes',
    context: { currentStep: 'COLLECTING_DATA' }
  });

  assert.equal(result.fields.experienceInfo, undefined);
});

test('rechaza una propuesta negativa cuando el candidato describe experiencia', () => {
  const result = sanitizeExperience({
    value: 'No',
    text: 'tengo 3 años de experiencia como auxiliar logístico',
    context: { currentStep: 'COLLECTING_DATA' }
  });

  assert.equal(result.fields.experienceInfo, undefined);
});
