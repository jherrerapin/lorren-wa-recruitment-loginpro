import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNaturalData } from '../src/services/candidateData.js';
import { sanitizeCandidateFieldsForConversation } from '../src/services/fieldSanitizer.js';
import { splitFieldDecisions } from '../src/services/debugTrace.js';
import { NON_NAME_PROFILE_REPLAYS } from './conversation-replay/nonNameProfileReplay.js';

function normalize(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function evidenceFor(fields = {}, text = '', source = 'responses_extractor') {
  const normalizedText = normalize(text);
  return Object.fromEntries(
    Object.entries(fields).map(([field, value]) => {
      const valueText = String(value);
      const snippet = normalizedText.includes(normalize(valueText)) ? valueText : String(text);
      return [field, { snippet, confidence: 0.97, source }];
    })
  );
}

function sanitize({ text, fields, context = {}, turnType = 'PROVIDE_DATA', evidence = null }) {
  return sanitizeCandidateFieldsForConversation({
    text,
    fields,
    context,
    turnType,
    evidence: evidence || evidenceFor(fields, text)
  });
}

test('replay CONV-032: una profesión propuesta por el motor no cruza la compuerta de nombre', () => {
  const replay = NON_NAME_PROFILE_REPLAYS.find((item) => item.id === 'conv-032-profession-is-not-name-v1');
  const sanitized = sanitize({
    text: replay.inbound,
    fields: replay.proposedFields,
    evidence: replay.evidence,
    turnType: replay.turnType,
    context: { currentStep: 'COLLECTING_DATA', pendingFields: ['fullName'] }
  });

  assert.equal(sanitized.fields.fullName ?? null, replay.expected.fullName);
  assert.equal(sanitized.rejectedFields.find((item) => item.field === 'fullName')?.field, 'fullName');
});

test('replay CONV-064: un rasgo personal después de “soy” no se extrae como nombre', () => {
  const replay = NON_NAME_PROFILE_REPLAYS.find((item) => item.id === 'conv-064-trait-is-not-name-v1');
  const parsed = parseNaturalData(replay.inbound);
  assert.equal(parsed.fullName ?? null, replay.expected.parsedFullName);
});

test('un nombre explícito real sigue siendo válido', () => {
  const replay = NON_NAME_PROFILE_REPLAYS.find((item) => item.id === 'valid-explicit-name-remains-supported-v1');
  const parsed = parseNaturalData(replay.inbound);
  assert.equal(parsed.fullName, replay.expected.parsedFullName);
});

test('persistencia no juzga semántica y solo reemplaza nombre mediante overwrite explícito', () => {
  const replay = NON_NAME_PROFILE_REPLAYS.find((item) => item.id === 'valid-name-corrects-invalid-persisted-value-v1');
  const decision = splitFieldDecisions(replay.proposedFields, replay.candidate, {
    allowOverwriteFields: ['fullName']
  });

  assert.equal(decision.persistedData.fullName, replay.expected.persistedFullName);
  assert.deepEqual(decision.consolidatedFields, replay.expected.consolidatedFields);
  assert.deepEqual(decision.rejectedFields, []);
});

test('preguntas sobre requisitos o vacante no se convierten en entidades personales', () => {
  const cases = [
    { text: '¿Necesito CC para aplicar?', fields: { documentType: 'CC' }, expectedRejected: 'documentType' },
    { text: '¿Puedo ir en moto?', fields: { transportMode: 'Moto' }, expectedRejected: 'transportMode' },
    { text: '¿Aceptan personas con restricciones médicas?', fields: { medicalRestrictions: 'Restricciones médicas' }, expectedRejected: 'medicalRestrictions' },
    { text: '¿La vacante queda en el barrio El Salado?', fields: { neighborhood: 'El Salado' }, expectedRejected: 'neighborhood' },
    { text: '¿Cuentan con alguna vacante administrativa disponible?', fields: { fullName: 'Cuentan Con Alguna' }, expectedRejected: 'fullName' }
  ];

  for (const item of cases) {
    const result = sanitize({
      text: item.text,
      fields: item.fields,
      turnType: 'ASK_QUESTION',
      context: { currentStep: 'COLLECTING_DATA' },
      evidence: evidenceFor(item.fields, item.text)
    });
    assert.deepEqual(result.fields, {}, item.text);
    assert.ok(result.rejectedFields.some((entry) => entry.field === item.expectedRejected), item.text);
  }
});

test('afirmaciones equivalentes sí se guardan como atributos del candidato', () => {
  const cases = [
    {
      text: 'Mi CC es 1234567890.',
      fields: { documentType: 'CC', documentNumber: '1234567890' },
      expected: { documentType: 'CC', documentNumber: '1234567890' }
    },
    { text: 'Me movilizo en moto.', fields: { transportMode: 'Moto' }, expected: { transportMode: 'Moto' } },
    { text: 'No tengo restricciones médicas.', fields: { medicalRestrictions: 'Sin restricciones medicas' }, expected: { medicalRestrictions: 'Sin restricciones medicas' } },
    { text: 'Vivo en el barrio El Salado.', fields: { neighborhood: 'El Salado' }, expected: { neighborhood: 'El Salado' } }
  ];

  for (const item of cases) {
    const result = sanitize({
      text: item.text,
      fields: item.fields,
      turnType: 'PROVIDE_DATA',
      context: { currentStep: 'COLLECTING_DATA' },
      evidence: evidenceFor(item.fields, item.text)
    });
    assert.deepEqual(result.fields, item.expected, item.text);
    assert.deepEqual(result.rejectedFields, [], item.text);
  }
});

test('un turno mixto conserva el dato personal explícito y rechaza la mención interrogativa', () => {
  const text = 'Mi CC es 1234567890. ¿Puedo ir en moto?';
  const fields = {
    documentType: 'CC',
    documentNumber: '1234567890',
    transportMode: 'Moto'
  };
  const result = sanitize({
    text,
    fields,
    turnType: 'ASK_QUESTION',
    context: { currentStep: 'COLLECTING_DATA' },
    evidence: {
      documentType: { snippet: 'Mi CC es', confidence: 0.98, source: 'responses_extractor' },
      documentNumber: { snippet: '1234567890', confidence: 0.99, source: 'responses_extractor' },
      transportMode: { snippet: 'moto', confidence: 0.98, source: 'responses_extractor' }
    }
  });

  assert.equal(result.fields.documentType, 'CC');
  assert.equal(result.fields.documentNumber, '1234567890');
  assert.equal(result.fields.transportMode, undefined);
  assert.equal(result.rejectedFields.find((item) => item.field === 'transportMode')?.reason, 'transportMode_mentioned_only_in_question');
});

test('un apellido que coincide con una ciudad no se rechaza por listas léxicas', () => {
  const fields = { fullName: 'Carlos Madrid' };
  const sanitized = sanitize({
    text: 'Mi nombre es Carlos Madrid',
    fields,
    context: { currentStep: 'COLLECTING_DATA', pendingFields: ['fullName'] },
    evidence: { fullName: { snippet: 'Carlos Madrid', confidence: 0.99, source: 'responses_extractor' } }
  });

  assert.equal(sanitized.fields.fullName, 'Carlos Madrid');
  const decision = splitFieldDecisions(sanitized.fields, { fullName: null });
  assert.equal(decision.persistedData.fullName, 'Carlos Madrid');
});
