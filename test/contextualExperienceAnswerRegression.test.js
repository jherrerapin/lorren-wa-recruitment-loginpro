import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCandidateFieldsForConversation } from '../src/services/fieldSanitizer.js';
import { conversationUnderstanding } from '../src/services/conversationUnderstanding.js';

const EXPERIENCE_CONTEXT = Object.freeze({
  currentStep: 'COLLECTING_DATA',
  pendingFields: [
    'experiencia (si o no)',
    'tiempo de experiencia (1 año o más)',
    'en qué tiene experiencia'
  ],
  lastBotQuestion: '¿Tienes experiencia laboral? Si sí, ¿cuánto tiempo?'
});

function sanitize(text, fields, evidence, context = EXPERIENCE_CONTEXT, turnType = 'DATA') {
  return sanitizeCandidateFieldsForConversation({ text, fields, evidence, context, turnType });
}

function evidence(snippet) {
  return { snippet, confidence: 0.99, source: 'responses_extractor' };
}

function disabledAiResult() {
  return {
    status: 'disabled',
    intent: null,
    parsedFields: {},
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
  };
}

function emptyRuntime() {
  return {
    localParsedData: {},
    engineFields: {},
    engineUsage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    fallbackIntent: 'continue_application',
    enrichFields: (fields) => fields
  };
}

test('sí responde experiencia cuando la última pregunta del bot pide experiencia', () => {
  const result = sanitize(
    'sí',
    { experienceInfo: 'Sí' },
    { experienceInfo: evidence('sí') },
    EXPERIENCE_CONTEXT,
    'CONFIRMATION'
  );

  assert.equal(result.fields.experienceInfo, 'Sí');
});

test('no responde experiencia cuando la última pregunta del bot pide experiencia', () => {
  const result = sanitize(
    'no',
    { experienceInfo: 'No' },
    { experienceInfo: evidence('no') },
    EXPERIENCE_CONTEXT,
    'CONFIRMATION'
  );

  assert.equal(result.fields.experienceInfo, 'No');
});

test('sí, 2 años conserva afirmación y tiempo cuando responde la pregunta activa', () => {
  const result = sanitize(
    'sí, 2 años',
    { experienceInfo: 'Sí', experienceTime: '2 años' },
    {
      experienceInfo: evidence('sí'),
      experienceTime: evidence('2 años')
    }
  );

  assert.equal(result.fields.experienceInfo, 'Sí');
  assert.equal(result.fields.experienceTime, '2 años');
});

test('sí. 60 personas conserva experiencia sin convertir la métrica laboral en edad', () => {
  const result = sanitize(
    'sí. 60 personas',
    { experienceInfo: 'Sí', age: 60 },
    {
      experienceInfo: evidence('sí'),
      age: evidence('60')
    },
    {
      ...EXPERIENCE_CONTEXT,
      lastBotQuestion: '¿Tienes experiencia coordinando personal?'
    }
  );

  assert.equal(result.fields.experienceInfo, 'Sí');
  assert.equal(result.fields.age, undefined);
});

test('sí o no no se atribuyen a experiencia cuando la última pregunta era de otro campo', () => {
  const context = {
    ...EXPERIENCE_CONTEXT,
    lastBotQuestion: '¿En qué barrio vives?'
  };

  for (const [text, value] of [['sí', 'Sí'], ['no', 'No']]) {
    const result = sanitize(
      text,
      { experienceInfo: value },
      { experienceInfo: evidence(text) },
      context,
      'CONFIRMATION'
    );

    assert.equal(result.fields.experienceInfo, undefined, text);
  }
});

test('el pipeline recupera sí/no contextual aun con IA deshabilitada', async () => {
  for (const [text, expected] of [['sí', 'Sí'], ['no', 'No']]) {
    const result = await conversationUnderstanding(text, {
      context: EXPERIENCE_CONTEXT,
      aiResult: disabledAiResult(),
      runtime: emptyRuntime()
    });

    assert.equal(result.candidateFields.experienceInfo, expected, text);
  }
});

test('el pipeline recupera afirmación y duración contextual con IA deshabilitada', async () => {
  const result = await conversationUnderstanding('sí, 2 años', {
    context: EXPERIENCE_CONTEXT,
    aiResult: disabledAiResult(),
    runtime: emptyRuntime()
  });

  assert.equal(result.candidateFields.experienceInfo, 'Sí');
  assert.equal(result.candidateFields.experienceTime, '2 años');
});

test('el pipeline recupera sí. 60 personas como experiencia contextual sin fabricar edad', async () => {
  const result = await conversationUnderstanding('sí. 60 personas', {
    context: {
      ...EXPERIENCE_CONTEXT,
      lastBotQuestion: '¿Tienes experiencia coordinando personal?'
    },
    aiResult: disabledAiResult(),
    runtime: emptyRuntime()
  });

  assert.equal(result.candidateFields.experienceInfo, 'Sí');
  assert.equal(result.candidateFields.age, undefined);
});

test('el pipeline no usa pendingFields para robar una respuesta dirigida a otro campo', async () => {
  for (const text of ['sí', 'no', 'sí, 2 años', 'sí. 60 personas']) {
    const result = await conversationUnderstanding(text, {
      context: {
        ...EXPERIENCE_CONTEXT,
        lastBotQuestion: '¿En qué barrio vives?'
      },
      aiResult: disabledAiResult(),
      runtime: emptyRuntime()
    });

    assert.equal(result.candidateFields.experienceInfo, undefined, text);
    assert.equal(result.candidateFields.experienceTime, undefined, text);
  }
});
