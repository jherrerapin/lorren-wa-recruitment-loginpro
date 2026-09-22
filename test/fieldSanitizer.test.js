import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCandidateFieldsForConversation } from '../src/services/fieldSanitizer.js';
import { parseNaturalData } from '../src/services/candidateData.js';
import { buildCandidateDataCollectionMessage } from '../src/services/readinessGuard.js';
import { buildGenderEvidencePromptText, hasStrongGenderEvidence } from '../src/services/genderEvidencePolicy.js';

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

function evidenceFor(fields = {}, overrides = {}) {
  return Object.fromEntries(
    Object.keys(fields).map((field) => [
      field,
      {
        snippet: String(fields[field]),
        confidence: 0.91,
        source: 'responses_extractor',
        ...(overrides[field] || {})
      }
    ])
  );
}

function sanitize({ text, fields, context = {}, turnType = 'PROVIDE_DATA', evidence = evidenceFor(fields) }) {
  return sanitizeCandidateFieldsForConversation({ fields, evidence, text, context, turnType });
}

test('recolección pide solo campos requeridos y pendientes por la vacante', () => {
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

test('recolección no vuelve a pedir campos ya conocidos', () => {
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
});

test('parser local no adivina nombres por forma o por una pregunta', () => {
  assert.equal(parseNaturalData('cuentan con alguna vacante administrativa disponible ?').fullName, undefined);
  assert.equal(parseNaturalData('Manejan beneficios adicionales actualmente').fullName, undefined);
  assert.equal(parseNaturalData('José Ángel Peña').fullName, undefined);
});

test('parser local conserva identidad únicamente con señal determinística fuerte', () => {
  assert.equal(parseNaturalData('Nombre completo: María Fernanda López Ruiz').fullName, 'María Fernanda López Ruiz');
  assert.equal(parseNaturalData('Juan David Perez CC 1012345678').fullName, 'Juan David Perez');
});

test('pregunta de vacante no puede convertirse en fullName aunque una fuente lo proponga', () => {
  const text = '¿Cuentan con alguna vacante administrativa disponible?';
  const fields = { fullName: 'Cuentan Con Alguna' };
  const result = sanitize({
    text,
    fields,
    context: { currentStep: 'GREETING_SENT' },
    turnType: 'ASK_QUESTION',
    evidence: evidenceFor(fields, {
      fullName: { snippet: 'Cuentan con alguna', confidence: 0.99 }
    })
  });
  assert.equal(result.fields.fullName, undefined);
  assert.equal(result.rejectedFields.find((item) => item.field === 'fullName')?.reason, 'question_without_identity_evidence');
});

test('nombre desnudo solo se acepta con contexto activo y fuente semántica', () => {
  const text = 'Andrés Felipe Henao Patiño';
  const fields = { fullName: text };
  const context = {
    currentStep: 'COLLECTING_DATA',
    pendingFields: ['fullName'],
    lastBotQuestion: 'Confírmame por favor tu nombre completo'
  };

  const local = sanitize({
    text,
    fields,
    context,
    evidence: evidenceFor(fields, { fullName: { snippet: text, confidence: 0.99, source: 'local_parser' } })
  });
  const semantic = sanitize({
    text,
    fields,
    context,
    evidence: evidenceFor(fields, { fullName: { snippet: text, confidence: 0.99, source: 'responses_extractor' } })
  });

  assert.equal(local.fields.fullName, undefined);
  assert.equal(semantic.fields.fullName, text);
});

test('nombre explícito y apellido coincidente con una ciudad siguen siendo válidos', () => {
  const fields = { fullName: 'Carlos Madrid' };
  const result = sanitize({
    text: 'Mi nombre es Carlos Madrid',
    fields,
    evidence: evidenceFor(fields, { fullName: { snippet: 'Carlos Madrid', confidence: 0.99 } })
  });
  assert.equal(result.fields.fullName, 'Carlos Madrid');
});

test('documento mencionado como requisito no se vuelve dato personal', () => {
  const result = sanitize({
    text: '¿Necesito CC para aplicar?',
    fields: { documentType: 'CC' },
    turnType: 'ASK_QUESTION',
    evidence: { documentType: { snippet: 'CC', confidence: 0.99, source: 'responses_extractor' } }
  });
  assert.equal(result.fields.documentType, undefined);
});

test('documento explícito se acepta y normaliza con evidencia anclada', () => {
  const text = 'Mi CC es 1234567890';
  const fields = { documentType: 'CC', documentNumber: '1234567890' };
  const result = sanitize({
    text,
    fields,
    evidence: {
      documentType: { snippet: 'Mi CC', confidence: 0.99, source: 'responses_extractor' },
      documentNumber: { snippet: '1234567890', confidence: 0.99, source: 'responses_extractor' }
    }
  });
  assert.deepEqual(result.fields, fields);
});

test('un documento corto puede aceptarse como respuesta al campo realmente pendiente', () => {
  const text = 'CC 1020304050';
  const fields = { documentType: 'CC', documentNumber: '1020304050' };
  const result = sanitize({
    text,
    fields,
    context: { pendingFields: ['documentType', 'documentNumber'] },
    evidence: {
      documentType: { snippet: text, confidence: 1, source: 'local_parser' },
      documentNumber: { snippet: text, confidence: 1, source: 'local_parser' }
    }
  });
  assert.deepEqual(result.fields, fields);
});

test('transporte preguntado no se persiste, transporte auto-referido sí', () => {
  const question = sanitize({
    text: '¿Puedo ir en moto?',
    fields: { transportMode: 'Moto' },
    turnType: 'ASK_QUESTION',
    evidence: { transportMode: { snippet: 'moto', confidence: 0.99, source: 'responses_extractor' } }
  });
  const assertion = sanitize({
    text: 'Me movilizo en moto',
    fields: { transportMode: 'Moto' },
    evidence: { transportMode: { snippet: 'moto', confidence: 0.99, source: 'responses_extractor' } }
  });
  assert.equal(question.fields.transportMode, undefined);
  assert.equal(assertion.fields.transportMode, 'Moto');
});

test('restricción médica preguntada no se persiste, declaración propia sí', () => {
  const question = sanitize({
    text: '¿Aceptan personas con restricciones médicas?',
    fields: { medicalRestrictions: 'Restricciones médicas' },
    turnType: 'ASK_QUESTION',
    evidence: { medicalRestrictions: { snippet: 'restricciones médicas', confidence: 0.99, source: 'responses_extractor' } }
  });
  const assertion = sanitize({
    text: 'No tengo restricciones médicas',
    fields: { medicalRestrictions: 'Sin restricciones medicas' },
    evidence: { medicalRestrictions: { snippet: 'No tengo restricciones médicas', confidence: 0.99, source: 'responses_extractor' } }
  });
  assert.equal(question.fields.medicalRestrictions, undefined);
  assert.equal(assertion.fields.medicalRestrictions, 'Sin restricciones medicas');
});

test('respuesta corta de restricciones requiere que ese sea el campo activo', () => {
  const withoutContext = sanitize({
    text: 'No',
    fields: { medicalRestrictions: 'No' },
    evidence: { medicalRestrictions: { snippet: 'No', confidence: 0.99, source: 'responses_extractor' } }
  });
  const withContext = sanitize({
    text: 'No',
    fields: { medicalRestrictions: 'No' },
    context: { lastBotQuestion: '¿Tienes restricciones médicas?' },
    evidence: { medicalRestrictions: { snippet: 'No', confidence: 0.99, source: 'responses_extractor' } }
  });
  assert.equal(withoutContext.fields.medicalRestrictions, undefined);
  assert.equal(withContext.fields.medicalRestrictions, 'No');
});

test('ubicación de la vacante no se confunde con residencia del candidato', () => {
  const question = sanitize({
    text: '¿La vacante queda en el barrio El Salado?',
    fields: { neighborhood: 'El Salado' },
    turnType: 'ASK_QUESTION',
    evidence: { neighborhood: { snippet: 'El Salado', confidence: 0.99, source: 'responses_extractor' } }
  });
  const assertion = sanitize({
    text: 'Vivo en el barrio El Salado',
    fields: { neighborhood: 'El Salado' },
    evidence: { neighborhood: { snippet: 'El Salado', confidence: 0.99, source: 'responses_extractor' } }
  });
  assert.equal(question.fields.neighborhood, undefined);
  assert.equal(assertion.fields.neighborhood, 'El Salado');
});

test('edad no se confunde con duración laboral', () => {
  const result = sanitize({
    text: 'tengo 12 años de experiencia',
    fields: { age: 12, experienceTime: '12 años' },
    context: { currentStep: 'COLLECTING_DATA' },
    evidence: {
      age: { snippet: '12 años de experiencia', confidence: 0.95, source: 'responses_extractor' },
      experienceTime: { snippet: '12 años de experiencia', confidence: 0.95, source: 'responses_extractor' }
    }
  });
  assert.equal(result.fields.age, undefined);
  assert.equal(result.fields.experienceTime, '12 años');
});

test('género solo se acepta con evidencia lingüística fuerte y nunca por nombre o cortesía', () => {
  assert.equal(hasStrongGenderEvidence('FEMALE', 'soy mujer'), true);
  assert.equal(hasStrongGenderEvidence('MALE', 'estoy interesado en la vacante'), true);

  const explicit = sanitize({
    text: 'Soy mujer',
    fields: { gender: 'FEMALE' },
    evidence: { gender: { snippet: 'Soy mujer', confidence: 0.99, source: 'responses_extractor' } }
  });
  const courtesy = sanitize({
    text: 'Sí señora, claro',
    fields: { gender: 'FEMALE' },
    turnType: 'CONFIRMATION',
    evidence: { gender: { snippet: 'señora', confidence: 0.99, source: 'responses_extractor' } }
  });
  const nameInference = sanitize({
    text: 'María Fernanda Pérez',
    fields: { gender: 'FEMALE' },
    evidence: { gender: { snippet: 'María Fernanda Pérez', confidence: 0.99, source: 'name_inference' } }
  });

  assert.equal(explicit.fields.gender, 'FEMALE');
  assert.equal(courtesy.fields.gender, undefined);
  assert.equal(nameInference.fields.gender, undefined);
});

test('prompt de género usa la misma evidencia fuerte que el sanitizador', () => {
  const promptText = buildGenderEvidencePromptText();
  for (const example of ['soy mujer', 'estoy interesada en la vacante', 'soy hombre', 'estoy interesado en la vacante']) {
    assert.match(promptText, new RegExp(example, 'i'));
  }
});

test('experiencia preguntada no se guarda como experiencia propia', () => {
  const result = sanitize({
    text: '¿Necesito 6 meses de experiencia?',
    fields: { experienceInfo: 'Sí', experienceTime: '6 meses' },
    turnType: 'ASK_QUESTION',
    evidence: {
      experienceInfo: { snippet: 'experiencia', confidence: 0.99, source: 'responses_extractor' },
      experienceTime: { snippet: '6 meses', confidence: 0.99, source: 'responses_extractor' }
    }
  });
  assert.equal(result.fields.experienceInfo, undefined);
  assert.equal(result.fields.experienceTime, undefined);
});

test('experiencia propia explícita conserva afirmación y duración', () => {
  const result = sanitize({
    text: 'Tengo 6 meses de experiencia en bodega',
    fields: { experienceInfo: 'Sí', experienceTime: '6 meses' },
    evidence: {
      experienceInfo: { snippet: 'Tengo 6 meses de experiencia', confidence: 0.99, source: 'responses_extractor' },
      experienceTime: { snippet: '6 meses', confidence: 0.99, source: 'responses_extractor' }
    }
  });
  assert.equal(result.fields.experienceInfo, 'Sí');
  assert.equal(result.fields.experienceTime, '6 meses');
});

test('turno mixto conserva dato explícito y rechaza la mención interrogativa independiente', () => {
  const text = 'Mi CC es 1234567890. ¿Puedo ir en moto?';
  const result = sanitize({
    text,
    fields: { documentType: 'CC', documentNumber: '1234567890', transportMode: 'Moto' },
    turnType: 'ASK_QUESTION',
    evidence: {
      documentType: { snippet: 'Mi CC', confidence: 0.99, source: 'responses_extractor' },
      documentNumber: { snippet: '1234567890', confidence: 0.99, source: 'responses_extractor' },
      transportMode: { snippet: 'moto', confidence: 0.99, source: 'responses_extractor' }
    }
  });
  assert.equal(result.fields.documentType, 'CC');
  assert.equal(result.fields.documentNumber, '1234567890');
  assert.equal(result.fields.transportMode, undefined);
});
