import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCandidateFieldsForConversation } from '../src/services/fieldSanitizer.js';
import { buildCandidateDataCollectionMessage } from '../src/services/readinessGuard.js';

const bogotaVacancyWithExperience = Object.freeze({
  id: 'vac-bog-exp',
  title: 'Auxiliar de Bodega Bogota',
  role: 'Auxiliar de bodega',
  city: 'Bogota',
  experienceRequired: 'YES',
  experienceTimeText: 'mínimo 6 meses',
  isActive: true,
  acceptingApplications: true
});

test('mensaje de recolección masiva usa campos reales requeridos por la vacante', () => {
  const message = buildCandidateDataCollectionMessage({}, bogotaVacancyWithExperience);

  assert.match(message, /nombre completo/i);
  assert.match(message, /tipo de documento/i);
  assert.match(message, /numero de documento/i);
  assert.match(message, /edad/i);
  assert.match(message, /localidad/i);
  assert.match(message, /restricciones medicas/i);
  assert.match(message, /medio de transporte/i);
  assert.match(message, /experiencia \(si o no\)/i);
  assert.match(message, /tiempo de experiencia \(mínimo 6 meses\)/i);
  assert.doesNotMatch(message, /correo|email|telefono|teléfono|direccion|dirección/i);
});

test('mensaje de recolección masiva respeta campos configurados en la vacante', () => {
  const message = buildCandidateDataCollectionMessage({}, {
    id: 'vac-custom-fields',
    city: 'Ibague',
    requiredCandidateFields: ['fullName', 'age', 'transportMode']
  });

  assert.match(message, /nombre completo/i);
  assert.match(message, /edad/i);
  assert.match(message, /medio de transporte/i);
  assert.doesNotMatch(message, /tipo de documento|numero de documento|restricciones medicas|barrio|localidad/i);
});

test('mensaje de recolección masiva no repite datos ya conocidos del candidato', () => {
  const message = buildCandidateDataCollectionMessage({
    fullName: 'Laura Perez',
    age: 29,
    locality: 'Suba',
    transportMode: 'Bus'
  }, bogotaVacancyWithExperience);

  assert.doesNotMatch(message, /nombre completo/i);
  assert.doesNotMatch(message, /edad/i);
  assert.doesNotMatch(message, /localidad/i);
  assert.doesNotMatch(message, /medio de transporte/i);
  assert.match(message, /tipo de documento/i);
  assert.match(message, /numero de documento/i);
  assert.match(message, /restricciones medicas/i);
  assert.match(message, /experiencia/i);
});

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

test('acepta género femenino por postulacion lingüística auto-referida', () => {
  const fields = { gender: 'FEMALE' };
  const result = sanitize({
    text: 'Hola, ya estoy postulada para el cargo',
    fields,
    evidence: evidenceFor(fields, { gender: { snippet: 'estoy postulada', confidence: 0.94 } }),
    context: { currentStep: 'GREETING_SENT' },
    turnType: 'OTHER'
  });

  assert.equal(result.fields.gender, 'FEMALE');
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

test('no marca mujer por tratamiento de cortesía: Sii Señora claro', () => {
  const fields = { gender: 'FEMALE' };
  const result = sanitize({
    text: 'Sii Señora claro',
    fields,
    evidence: evidenceFor(fields, { gender: { snippet: 'Señora', confidence: 0.95 } }),
    context: { currentStep: 'COLLECTING_DATA' },
    turnType: 'CONFIRMATION'
  });

  assert.equal(result.fields.gender, undefined);
  assert.equal(result.rejectedFields.find((item) => item.field === 'gender').reason, 'courtesy_treatment_is_not_candidate_gender');
});

test('no marca mujer por gracias señorita', () => {
  const fields = { gender: 'FEMALE' };
  const result = sanitize({
    text: 'gracias señorita',
    fields,
    evidence: evidenceFor(fields, { gender: { snippet: 'señorita', confidence: 0.95 } }),
    context: { currentStep: 'COLLECTING_DATA' },
    turnType: 'OTHER'
  });

  assert.equal(result.fields.gender, undefined);
});

test('rechaza saludos y cortesías como valores de cualquier campo de texto', () => {
  const fields = {
    fullName: 'Buenas Tardes',
    transportMode: 'Ok',
    medicalRestrictions: 'Gracias'
  };
  const result = sanitize({
    text: 'buenas tardes ok gracias',
    fields,
    context: { currentStep: 'COLLECTING_DATA', pendingFields: ['fullName', 'transportMode', 'medicalRestrictions'] },
    turnType: 'GREETING'
  });

  assert.equal(result.fields.fullName, undefined);
  assert.equal(result.fields.transportMode, undefined);
  assert.equal(result.fields.medicalRestrictions, undefined);
  assert.equal(result.rejectedFields.find((item) => item.field === 'fullName')?.reason, 'non_data_text');
});

test('acepta valores legítimos después de la validación semántica', () => {
  const fields = {
    fullName: 'Laura Marcela Perez',
    age: 32,
    transportMode: 'Bus',
    medicalRestrictions: 'Sin restricciones medicas'
  };
  const result = sanitize({
    text: 'mi nombre es Laura Marcela Perez, tengo 32 años, me movilizo en bus y no tengo restricciones medicas',
    fields,
    evidence: evidenceFor(fields, {
      fullName: { snippet: 'Laura Marcela Perez', confidence: 0.96 },
      age: { snippet: '32 años', confidence: 0.95 },
      transportMode: { snippet: 'bus', confidence: 0.94 },
      medicalRestrictions: { snippet: 'no tengo restricciones medicas', confidence: 0.94 }
    }),
    context: { currentStep: 'COLLECTING_DATA', pendingFields: ['fullName', 'age', 'transportMode', 'medicalRestrictions'] }
  });

  assert.equal(result.fields.fullName, 'Laura Marcela Perez');
  assert.equal(result.fields.age, 32);
  assert.equal(result.fields.transportMode, 'Bus');
  assert.equal(result.fields.medicalRestrictions, 'Sin restricciones medicas');
});

import { applyFieldPolicy } from '../src/services/policyLayer.js';
import { buildGenderEvidencePromptText, hasStrongGenderEvidence } from '../src/services/genderEvidencePolicy.js';

const genderCases = {
  FEMALE: ['soy mujer', 'soy candidata', 'estoy interesada en la vacante', 'quedo atenta', 'me postulo como candidata'],
  MALE: ['soy hombre', 'soy candidato', 'estoy interesado en la vacante', 'quedo atento'],
  ambiguous: [
    'sí señora',
    'gracias señorita',
    'la señorita me dijo',
    'mi esposa está interesada',
    'es para mi hermana',
    'quedo atento a la respuesta de la señora',
    'candidata es la vacante que vi'
  ]
};

function sanitizeGenderCase(value, text, source = 'responses_extractor') {
  return sanitize({
    text,
    fields: { gender: value },
    evidence: { gender: { snippet: text, confidence: 0.95, source } }
  });
}

function applyGenderPolicyCase(value, text, source = 'responses_extractor') {
  return applyFieldPolicy({
    fields: { gender: value },
    fieldEvidence: { gender: { snippet: text, confidence: 0.95, source } }
  });
}

test('caracterización género: positivos FEMALE usan evidencia fuerte compartida', () => {
  for (const text of genderCases.FEMALE) {
    assert.equal(hasStrongGenderEvidence('FEMALE', text), true, text);
    assert.equal(sanitizeGenderCase('FEMALE', text).fields.gender, 'FEMALE', text);
    assert.equal(applyGenderPolicyCase('FEMALE', text).persistedFields.gender, 'FEMALE', text);
  }
});

test('caracterización género: positivos MALE usan evidencia fuerte compartida', () => {
  for (const text of genderCases.MALE) {
    assert.equal(hasStrongGenderEvidence('MALE', text), true, text);
    assert.equal(sanitizeGenderCase('MALE', text).fields.gender, 'MALE', text);
    assert.equal(applyGenderPolicyCase('MALE', text).persistedFields.gender, 'MALE', text);
  }
});

test('caracterización género: negativos y ambiguos no se aceptan como género del candidato', () => {
  for (const text of genderCases.ambiguous) {
    assert.equal(hasStrongGenderEvidence('FEMALE', text), false, text);
    assert.equal(hasStrongGenderEvidence('MALE', text), false, text);
    assert.equal(sanitizeGenderCase('FEMALE', text).fields.gender, undefined, text);
    assert.equal(applyGenderPolicyCase('FEMALE', text).persistedFields.gender, undefined, text);
  }
});

test('caracterización género: no se infiere por nombre', () => {
  const sanitizerResult = sanitizeGenderCase('FEMALE', 'María Fernanda Pérez', 'name_inference');
  const policyResult = applyGenderPolicyCase('FEMALE', 'María Fernanda Pérez', 'name_inference');

  assert.equal(sanitizerResult.fields.gender, undefined);
  assert.equal(sanitizerResult.rejectedFields.find((item) => item.field === 'gender')?.reason, 'gender_inferred_from_name');
  assert.equal(policyResult.persistedFields.gender, undefined);
  assert.equal(policyResult.reviewQueue[0]?.reason, 'weak_gender_inference');
});

test('caracterización género: prompt, sanitizador y policy conservan la misma evidencia base', () => {
  const promptText = buildGenderEvidencePromptText();

  for (const [value, cases] of Object.entries({ FEMALE: genderCases.FEMALE, MALE: genderCases.MALE })) {
    for (const text of cases) {
      assert.match(promptText, new RegExp(text.normalize('NFD').replace(/[\u0300-\u036f]/g, ''), 'i'), text);
      assert.equal(sanitizeGenderCase(value, text).fields.gender, value, text);
      assert.equal(applyGenderPolicyCase(value, text).persistedFields.gender, value, text);
    }
  }

  for (const text of genderCases.ambiguous) {
    assert.match(promptText, new RegExp(text.normalize('NFD').replace(/[\u0300-\u036f]/g, ''), 'i'), text);
    assert.equal(sanitizeGenderCase('FEMALE', text).fields.gender, undefined, text);
    assert.equal(applyGenderPolicyCase('FEMALE', text).persistedFields.gender, undefined, text);
  }
});
