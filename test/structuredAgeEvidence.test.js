import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAgeEvidence } from '../src/services/ageEvidence.js';
import {
  normalizeCandidateFields,
  parseNaturalData,
  shouldPreserveStructuredLocalField
} from '../src/services/candidateData.js';
import { sanitizeCandidateFieldsForConversation } from '../src/services/fieldSanitizer.js';

function sanitizeAge(value, text, context = { currentStep: 'COLLECTING_DATA', pendingFields: ['age'] }) {
  return sanitizeCandidateFieldsForConversation({
    fields: { age: value },
    evidence: {
      age: { snippet: String(value), confidence: 0.96, source: 'ai_extraction' }
    },
    text,
    context,
    turnType: 'PROVIDE_DATA'
  });
}

test('parser y sanitizer aceptan edad como línea estructurada dentro de un bloque', () => {
  const text = 'Cedula de ciudadania\n1007788013\n24 anos\nModelia\nNinguna restriccion medica\nMoto';
  const parsed = normalizeCandidateFields(parseNaturalData(text));
  const sanitized = sanitizeAge(parsed.age, text);

  assert.equal(parsed.age, 24);
  assert.equal(sanitized.fields.age, 24);
  assert.deepEqual(sanitized.rejectedFields, []);
});

test('acepta una segunda edad estructurada de dos dígitos en otro bloque', () => {
  const text = 'Cedula\n1082129284\n30 anos\nMoto\nSin restriccion medica';
  const parsed = normalizeCandidateFields(parseNaturalData(text));
  const sanitized = sanitizeAge(parsed.age, text);

  assert.equal(parsed.age, 30);
  assert.equal(sanitized.fields.age, 30);
});

test('parser conserva la edad actual cuando el mensaje anuncia un cumpleaños futuro', () => {
  const text = 'Johan Sebastian Carrillo Aldana, 18 años el otro mes cumplo 19, restricciones medicas ninguna, medio de transporte cicla';
  const parsed = normalizeCandidateFields(parseNaturalData(text));

  assert.equal(parsed.age, 18);
});

test('sanitizer acepta la edad actual y rechaza el número del cumpleaños futuro', () => {
  const text = 'Tengo 18 años, el otro mes cumplo 19';
  const current = sanitizeAge(18, text);
  const future = sanitizeAge(19, text);

  assert.equal(current.fields.age, 18);
  assert.equal(future.fields.age, undefined);
  assert.equal(future.rejectedFields[0].reason, 'future_birthday_not_current_age');
});

test('política de merge conserva edad local estructurada frente a propuesta diferente', () => {
  assert.equal(shouldPreserveStructuredLocalField('age', 18, 19), true);
  assert.equal(shouldPreserveStructuredLocalField('age', 18, 18), false);
  assert.equal(shouldPreserveStructuredLocalField('transportMode', 'Moto', 'Bus'), false);
});

test('una duración laboral, personal y dirección siguen sin ser edad', () => {
  assert.equal(classifyAgeEvidence(22, '22 años de experiencia en logística', { allowStandalone: true }).valid, false);
  assert.equal(classifyAgeEvidence(56, 'Manejo 56 trabajadores por turno', { allowStandalone: true }).valid, false);
  assert.equal(classifyAgeEvidence(80, 'Vivo en la calle 80', { allowStandalone: true }).valid, false);
});

test('una aparición inline arbitraria de años no se convierte en evidencia estructurada', () => {
  const result = classifyAgeEvidence(24, 'Trabajé con el grupo 24 años atrás en otra actividad', { allowStandalone: false });
  assert.equal(result.valid, false);
});
