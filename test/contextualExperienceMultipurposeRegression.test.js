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

test('el sanitizador rechaza un bloque completo de perfil propuesto como experienceSummary', () => {
  const text = 'Persona Ejemplo cédula de ciudadanía 100000001 edad 22 localidad de Usme transporte público sí tengo experiencia laboral 6 meses en cargue y descargue';
  const result = sanitizeCandidateFieldsForConversation({
    fields: { experienceSummary: text },
    evidence: {
      experienceSummary: {
        snippet: text,
        confidence: 0.99,
        source: 'ai_extraction'
      }
    },
    text,
    context: MULTIPURPOSE_CONTEXT,
    turnType: null
  });

  assert.equal(result.fields.experienceSummary, undefined);
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

test('una respuesta multipropósito de una sola línea no usa afirmación y duración como resumen laboral', async () => {
  const text = 'Persona Ejemplo cédula de ciudadanía 100000001 edad 22 localidad de Usme transporte público sí tengo experiencia laboral 6 meses';

  const result = await conversationUnderstanding(text, {
    context: MULTIPURPOSE_CONTEXT,
    aiResult: disabledAiResult()
  });

  assert.equal(result.candidateFields.experienceInfo, 'Sí');
  assert.equal(result.candidateFields.experienceTime, '6 meses');
  assert.equal(result.candidateFields.experienceSummary, undefined);
});

test('una respuesta multipropósito de una sola línea conserva solo el detalle laboral real', async () => {
  const text = 'Persona Ejemplo cédula de ciudadanía 100000001 edad 22 localidad de Usme transporte público sí tengo experiencia laboral 6 meses en cargue y descargue';

  const result = await conversationUnderstanding(text, {
    context: MULTIPURPOSE_CONTEXT,
    aiResult: disabledAiResult()
  });

  assert.match(result.candidateFields.experienceSummary || '', /cargue y descargue/i);
  assert.doesNotMatch(
    result.candidateFields.experienceSummary || '',
    /persona ejemplo|c[eé]dula|100000001|edad|usme|transporte p[uú]blico/i
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

test('interés por el trabajo no se convierte en experiencia aunque la IA lo proponga', () => {
  const text = 'Buenas tardes un favor interesado en el trabajo gracias';
  const result = sanitizeCandidateFieldsForConversation({
    fields: {
      experienceInfo: 'Sí',
      experienceSummary: text
    },
    evidence: {
      experienceInfo: {
        snippet: text,
        confidence: 0.99,
        source: 'ai_extraction'
      },
      experienceSummary: {
        snippet: text,
        confidence: 0.99,
        source: 'ai_extraction'
      }
    },
    text,
    context: MULTIPURPOSE_CONTEXT,
    turnType: 'PROVIDE_DATA'
  });

  assert.equal(result.fields.experienceInfo, undefined);
  assert.equal(result.fields.experienceSummary, undefined);
});

test('una declaración laboral explícita conserva experiencia real', () => {
  const text = 'Tengo 6 meses de experiencia en bodega';
  const result = sanitizeCandidateFieldsForConversation({
    fields: {
      experienceInfo: 'Sí',
      experienceSummary: 'experiencia en bodega'
    },
    evidence: {
      experienceInfo: {
        snippet: 'Tengo 6 meses de experiencia',
        confidence: 0.98,
        source: 'ai_extraction'
      },
      experienceSummary: {
        snippet: 'experiencia en bodega',
        confidence: 0.98,
        source: 'ai_extraction'
      }
    },
    text,
    context: MULTIPURPOSE_CONTEXT,
    turnType: 'PROVIDE_DATA'
  });

  assert.equal(result.fields.experienceInfo, 'Sí');
  assert.equal(result.fields.experienceSummary, 'experiencia en bodega');
});

test('saludo abreviado no se acepta como nombre aunque nombre esté pendiente', () => {
  const text = 'Bnas tardes';
  const result = sanitizeCandidateFieldsForConversation({
    fields: { fullName: 'Bnas Tardes' },
    evidence: {
      fullName: {
        snippet: text,
        confidence: 0.99,
        source: 'ai_extraction'
      }
    },
    text,
    context: {
      currentStep: 'COLLECTING_DATA',
      pendingFields: ['fullName'],
      lastBotQuestion: 'Confírmame por favor nombre completo.'
    },
    turnType: 'PROVIDE_DATA'
  });

  assert.equal(result.fields.fullName, undefined);
});

test('nombre real sigue siendo válido cuando responde a nombre pendiente', () => {
  const text = 'Andrés Felipe Henao Patiño';
  const result = sanitizeCandidateFieldsForConversation({
    fields: { fullName: text },
    evidence: {
      fullName: {
        snippet: text,
        confidence: 0.99,
        source: 'ai_extraction'
      }
    },
    text,
    context: {
      currentStep: 'COLLECTING_DATA',
      pendingFields: ['fullName'],
      lastBotQuestion: 'Confírmame por favor nombre completo.'
    },
    turnType: 'PROVIDE_DATA'
  });

  assert.equal(result.fields.fullName, text);
});
