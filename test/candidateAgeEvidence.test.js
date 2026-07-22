import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandidateFields, parseNaturalData } from '../src/services/candidateData.js';
import { sanitizeCandidateFieldsForConversation } from '../src/services/fieldSanitizer.js';

const WORK_METRIC_TEXT = 'En operaciones logísticas más de 12 años, y manejo de personal grupos mayores a 56 trabajadores por turno';

function sanitizeAge({ value, text, context = {}, confidence = 0.96 }) {
  return sanitizeCandidateFieldsForConversation({
    fields: { age: value },
    evidence: {
      age: {
        snippet: String(value),
        confidence,
        source: 'ai_extraction'
      }
    },
    text,
    context,
    turnType: 'PROVIDE_DATA'
  });
}

test('parser no convierte duración laboral ni cantidad de personal en edad', () => {
  const normalized = normalizeCandidateFields(parseNaturalData(WORK_METRIC_TEXT));

  assert.equal(normalized.age, undefined);
  assert.equal(normalized.experienceInfo, 'Sí');
  assert.equal(normalized.experienceTime, '12 años');
  assert.match(normalized.experienceSummary, /56 trabajadores/i);
});

test('parser separa edad explícita, experiencia y cantidad de personal', () => {
  const normalized = normalizeCandidateFields(parseNaturalData(
    'Tengo 42 años, cuento con 12 años de experiencia y he manejado 56 trabajadores por turno'
  ));

  assert.equal(normalized.age, 42);
  assert.equal(normalized.experienceInfo, 'Sí');
  assert.equal(normalized.experienceTime, '12 años');
});

test('parser conserva corrección explícita de edad', () => {
  assert.equal(normalizeCandidateFields(parseNaturalData('mi edad es 43')).age, 43);
});

test('parser conserva respuesta numérica corta', () => {
  assert.equal(normalizeCandidateFields(parseNaturalData('42')).age, 42);
});

test('sanitizer rechaza 56 cuando el número está ligado a trabajadores', () => {
  const result = sanitizeAge({ value: 56, text: WORK_METRIC_TEXT });

  assert.equal(result.fields.age, undefined);
  assert.deepEqual(result.rejectedFields, [
    { field: 'age', value: 56, reason: 'work_metric_not_age' }
  ]);
});

test('sanitizer rechaza 12 cuando el número está ligado a experiencia', () => {
  const result = sanitizeAge({ value: 12, text: 'Cuento con 12 años de experiencia en logística' });

  assert.equal(result.fields.age, undefined);
  assert.equal(result.rejectedFields[0].reason, 'experience_number_not_age');
});

test('sanitizer acepta la edad explícita aunque el mensaje incluya experiencia', () => {
  const text = 'Tengo 42 años y cuento con 12 años de experiencia';
  const result = sanitizeAge({ value: 42, text });

  assert.equal(result.fields.age, 42);
  assert.deepEqual(result.rejectedFields, []);
});

test('sanitizer acepta respuesta corta cuando edad está pendiente', () => {
  const result = sanitizeAge({
    value: 42,
    text: '42',
    context: {
      currentStep: 'COLLECTING_DATA',
      pendingFields: ['age'],
      lastBotQuestion: '¿Cuál es tu edad?'
    }
  });

  assert.equal(result.fields.age, 42);
  assert.deepEqual(result.rejectedFields, []);
});

test('sanitizer no acepta un número suelto sin contexto de edad', () => {
  const result = sanitizeAge({
    value: 56,
    text: 'Manejo grupos de 56 personas por turno',
    context: { currentStep: 'COLLECTING_DATA', pendingFields: ['experienceSummary'] }
  });

  assert.equal(result.fields.age, undefined);
  assert.equal(result.rejectedFields[0].reason, 'work_metric_not_age');
});
