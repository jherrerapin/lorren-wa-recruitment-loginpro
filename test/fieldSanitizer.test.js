import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCandidateFieldsForConversation } from '../src/services/fieldSanitizer.js';

function evidenceFor(fields = {}, overrides = {}) {
  return Object.fromEntries(
    Object.keys(fields).map((field) => [
      field,
      {
        snippet: String(fields[field]),
        confidence: 0.91,
        source: 'ai_extraction',
        ...(overrides[field] || {})
      }
    ])
  );
}

function sanitize({ text, fields, context = {}, turnType = 'PROVIDE_DATA', evidence = evidenceFor(fields) }) {
  return sanitizeCandidateFieldsForConversation({ fields, evidence, text, context, turnType });
}

test('rechaza saludos propuestos erróneamente como nombre y barrio', () => {
  const result = sanitize({
    text: 'buenas tardes',
    fields: { fullName: 'Buenas Tardes', neighborhood: 'Buenas Tardes' },
    context: { currentStep: 'COLLECTING_DATA' },
    turnType: 'GREETING'
  });

  assert.equal(result.fields.fullName, undefined);
  assert.equal(result.fields.neighborhood, undefined);
  assert.deepEqual(result.rejectedFields.map((item) => item.field).sort(), ['fullName', 'neighborhood']);
  assert.ok(result.rejectedFields.every((item) => item.reason));
});

test('rechaza confirmación simple como nombre', () => {
  const result = sanitize({
    text: 'si por favor',
    fields: { fullName: 'Si Por Favor' },
    context: { currentStep: 'GREETING_SENT' },
    turnType: 'CONFIRMATION'
  });

  assert.equal(result.fields.fullName, undefined);
  assert.equal(result.rejectedFields[0].field, 'fullName');
});

test('rechaza frase de vacante como nombre', () => {
  const result = sanitize({
    text: 'para informacion de la vacante',
    fields: { fullName: 'Para Informacion' },
    context: { currentStep: 'GREETING_SENT' },
    turnType: 'OTHER'
  });

  assert.equal(result.fields.fullName, undefined);
  assert.equal(result.rejectedFields[0].field, 'fullName');
});

test('acepta nombre real con evidencia explícita de identidad', () => {
  const fields = { fullName: 'Luis Eduardo Rodriguez Villalba' };
  const result = sanitize({
    text: 'mi nombre es Luis Eduardo Rodriguez Villalba',
    fields,
    context: { currentStep: 'COLLECTING_DATA', pendingFields: ['fullName'] },
    evidence: evidenceFor(fields, { fullName: { snippet: 'Luis Eduardo Rodriguez Villalba', confidence: 0.96 } })
  });

  assert.equal(result.fields.fullName, 'Luis Eduardo Rodriguez Villalba');
  assert.deepEqual(result.rejectedFields, []);
});

test('acepta nombre solo cuando responde al campo pendiente de nombre', () => {
  const fields = { fullName: 'Yilber antonio gonzalez ospina' };
  const result = sanitize({
    text: 'Yilber antonio gonzalez ospina',
    fields,
    context: {
      currentStep: 'COLLECTING_DATA',
      pendingFields: ['fullName'],
      lastBotQuestion: 'Por favor compárteme tu nombre completo'
    }
  });

  assert.equal(result.fields.fullName, 'Yilber antonio gonzalez ospina');
});

test('acepta barrio real con evidencia de residencia', () => {
  const fields = { neighborhood: 'Salado' };
  const result = sanitize({
    text: 'vivo en el salado',
    fields,
    evidence: evidenceFor(fields, { neighborhood: { snippet: 'salado', confidence: 0.94 } }),
    context: { currentStep: 'COLLECTING_DATA' }
  });

  assert.equal(result.fields.neighborhood, 'Salado');
});

test('rechaza cargo propuesto como barrio', () => {
  const result = sanitize({
    text: 'auxiliar de cargue y descargue',
    fields: { neighborhood: 'Auxiliar De Cargue' },
    context: { currentStep: 'GREETING_SENT' }
  });

  assert.equal(result.fields.neighborhood, undefined);
  assert.equal(result.rejectedFields[0].field, 'neighborhood');
});

test('acepta género femenino explícito con evidencia lingüística', () => {
  const fields = { gender: 'FEMALE', documentType: 'PPT' };
  const result = sanitize({
    text: 'soy mujer y tengo ppt',
    fields,
    evidence: evidenceFor(fields, { gender: { snippet: 'soy mujer', confidence: 0.95 }, documentType: { snippet: 'ppt' } }),
    context: { currentStep: 'COLLECTING_DATA' }
  });

  assert.equal(result.fields.gender, 'FEMALE');
  assert.equal(result.fields.documentType, 'PPT');
});

test('acepta género femenino contextual y no convierte interés en nombre o barrio', () => {
  const fields = { gender: 'FEMALE', fullName: 'Estoy Interesada', neighborhood: 'Vacante' };
  const result = sanitize({
    text: 'estoy interesada en la vacante',
    fields,
    evidence: evidenceFor(fields, { gender: { snippet: 'interesada', confidence: 0.9 } }),
    context: { currentStep: 'GREETING_SENT' },
    turnType: 'OTHER'
  });

  assert.equal(result.fields.gender, 'FEMALE');
  assert.equal(result.fields.fullName, undefined);
  assert.equal(result.fields.neighborhood, undefined);
});

test('rechaza género inferido solo por nombre y conserva nombre pendiente', () => {
  const fields = { fullName: 'Maria Perez', gender: 'FEMALE' };
  const result = sanitize({
    text: 'Maria Perez',
    fields,
    evidence: evidenceFor(fields, {
      fullName: { snippet: 'Maria Perez', confidence: 0.94 },
      gender: { snippet: '', confidence: 0.8, source: 'name_inference' }
    }),
    context: { currentStep: 'COLLECTING_DATA', pendingFields: ['fullName'] }
  });

  assert.equal(result.fields.fullName, 'Maria Perez');
  assert.equal(result.fields.gender, undefined);
  assert.equal(result.rejectedFields.find((item) => item.field === 'gender').reason, 'gender_inferred_from_name');
});

test('rechaza número de dirección como edad', () => {
  const result = sanitize({
    text: 'Desde Bogota calle 80',
    fields: { age: 80 },
    context: { currentStep: 'GREETING_SENT' }
  });

  assert.equal(result.fields.age, undefined);
  assert.equal(result.rejectedFields[0].reason, 'address_number_not_age');
});

test('rechaza número de experiencia como edad y conserva experienceTime', () => {
  const result = sanitize({
    text: 'tengo 12 años de experiencia',
    fields: { age: 12, experienceTime: '12 años' },
    context: { currentStep: 'COLLECTING_DATA' }
  });

  assert.equal(result.fields.age, undefined);
  assert.equal(result.fields.experienceTime, '12 años');
  assert.equal(result.rejectedFields[0].field, 'age');
});
