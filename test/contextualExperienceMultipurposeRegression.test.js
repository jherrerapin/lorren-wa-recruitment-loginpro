import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationUnderstanding } from '../src/services/conversationUnderstanding.js';
import { sanitizeCandidateFieldsForConversation } from '../src/services/fieldSanitizer.js';

function disabledAiResult() {
  return {
    status: 'disabled',
    intent: null,
    parsedFields: {},
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
  };
}

function runtime() {
  return {
    localParsedData: {},
    engineFields: {},
    engineUsage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    fallbackIntent: 'continue_application',
    enrichFields: (fields) => fields
  };
}

// El contexto reproduce una sola pregunta del bot que solicita varios campos a la vez.
const MULTIPURPOSE_CONTEXT = Object.freeze({
  currentStep: 'COLLECTING_DATA',
  pendingFields: [
    'nombre completo',
    'tipo y número de documento',
    'edad',
    'localidad',
    'restricciones médicas',
    'medio de transporte',
    'experiencia laboral',
    'tiempo de experiencia',
    'en qué labores tiene experiencia'
  ],
  lastBotQuestion: 'Compárteme nombre completo, tipo y número de documento, edad, localidad, restricciones médicas, medio de transporte y experiencia laboral: si tienes, cuánto tiempo y en qué labores.'
});

test('la autoridad semántica reconoce labores de cargue y descargue como experiencia contextual', () => {
  const result = sanitizeCandidateFieldsForConversation({
    fields: { experienceSummary: 'Cargue y descargue' },
    evidence: {
      experienceSummary: {
        snippet: 'Cargue y descargue',
        confidence: 0.95,
        source: 'contextual_answer'
      }
    },
    text: 'Cargue y descargue',
    context: MULTIPURPOSE_CONTEXT,
    turnType: null
  });

  assert.equal(result.fields.experienceSummary, 'Cargue y descargue');
});

test('una respuesta multipropósito no se guarda completa como experienceSummary', async () => {
  const text = [
    'Nombre de Prueba',
    'CC: 100000001',
    'Años: 32',
    'Suba',
    'Cargue y descargue'
  ].join('\n');

  const result = await conversationUnderstanding(text, {
    context: MULTIPURPOSE_CONTEXT,
    aiResult: disabledAiResult(),
    runtime: runtime()
  });

  assert.notEqual(result.candidateFields.experienceSummary, text.replace(/\s+/g, ' ').trim());
  assert.equal(result.candidateFields.experienceSummary, 'Cargue y descargue');
  assert.doesNotMatch(
    result.candidateFields.experienceSummary || '',
    /nombre de prueba|\bcc\b|100000001|a[nñ]os|suba/i
  );
});

test('una pregunta estrecha de labores conserva una respuesta corta como experiencia', async () => {
  const result = await conversationUnderstanding('Cargue y descargue', {
    context: {
      currentStep: 'COLLECTING_DATA',
      pendingFields: ['en qué labores tiene experiencia'],
      lastBotQuestion: '¿En qué labores tienes experiencia?'
    },
    aiResult: disabledAiResult(),
    runtime: runtime()
  });

  assert.equal(result.candidateFields.experienceSummary, 'Cargue y descargue');
});

test('evidencia técnica de otro turno no queda incrustada en experiencia', async () => {
  const text = [
    '[CONSENT_ACCEPTED]',
    'Nombre de Prueba',
    'CC: 100000001',
    'Años: 32',
    'Suba',
    'Cargue y descargue'
  ].join('\n');

  const result = await conversationUnderstanding(text, {
    context: MULTIPURPOSE_CONTEXT,
    aiResult: disabledAiResult(),
    runtime: runtime()
  });

  assert.equal(result.candidateFields.experienceSummary, 'Cargue y descargue');
  assert.doesNotMatch(result.candidateFields.experienceSummary || '', /CONSENT/i);
});
