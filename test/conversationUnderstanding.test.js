import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationUnderstanding } from '../src/services/conversationUnderstanding.js';

test('conversationUnderstanding devuelve estructura consistente requerida', async () => {
  const result = await conversationUnderstanding('corrijo: tengo moto, sin experiencia, cc 10203040', {
    aiParser: async () => ({ intent: 'provide_correction' })
  });

  assert.equal(typeof result.intent, 'string');
  assert.equal(typeof result.vacancyDetection, 'object');
  assert.equal(typeof result.cityDetection, 'object');
  assert.equal(typeof result.candidateFields, 'object');
  assert.ok(Array.isArray(result.corrections));
  assert.ok(Array.isArray(result.contradictions));
  assert.ok(Array.isArray(result.missingFields));
  assert.equal(typeof result.suggestedNextAction, 'string');
  assert.equal(typeof result.fieldConfidence, 'object');
  assert.equal(typeof result.replyGuidance, 'object');
  assert.equal(Object.hasOwn(result, 'turnInterpretation'), false);
  assert.equal(result.intent, 'provide_correction');
  assert.equal(result.candidateFields.transportMode, 'Moto');
});

test('conversationUnderstanding sanea campos propuestos por IA antes de persistir', async () => {
  const result = await conversationUnderstanding('buenas tardes', {
    context: { currentStep: 'COLLECTING_DATA' },
    aiResult: {
      status: 'ok',
      intent: 'continue_flow',
      parsedFields: { fullName: 'Buenas Tardes', neighborhood: 'Buenas Tardes' },
      extraction: {
        turnType: 'GREETING',
        fieldEvidence: {
          fullName: { snippet: 'buenas tardes', confidence: 0.91, source: 'ai_extraction' },
          neighborhood: { snippet: 'buenas tardes', confidence: 0.91, source: 'ai_extraction' }
        }
      }
    }
  });

  assert.equal(result.candidateFields.fullName, undefined);
  assert.equal(result.candidateFields.neighborhood, undefined);
  assert.deepEqual(result.rejectedFields.map((item) => item.field).sort(), ['fullName', 'neighborhood']);
});

test('conversationUnderstanding permite género femenino contextual sin crear nombre ni barrio', async () => {
  const result = await conversationUnderstanding('estoy interesada en la vacante', {
    context: { currentStep: 'GREETING_SENT' },
    aiResult: {
      status: 'ok',
      intent: 'apply_intent',
      parsedFields: { gender: 'FEMALE', fullName: 'Estoy Interesada', neighborhood: 'Vacante' },
      extraction: {
        turnType: 'OTHER',
        fieldEvidence: {
          gender: { snippet: 'interesada', confidence: 0.9, source: 'ai_extraction' },
          fullName: { snippet: 'estoy interesada', confidence: 0.82, source: 'ai_extraction' },
          neighborhood: { snippet: 'vacante', confidence: 0.82, source: 'ai_extraction' }
        }
      }
    }
  });

  assert.equal(result.candidateFields.gender, 'FEMALE');
  assert.equal(result.candidateFields.fullName, undefined);
  assert.equal(result.candidateFields.neighborhood, undefined);
});

test('conversationUnderstanding concentra la interpretación runtime en un solo snapshot', async () => {
  const transportEvidence = { snippet: 'moto', confidence: 0.94, source: 'ai_extraction' };
  const result = await conversationUnderstanding('CC 10203040, tengo 21 años, me movilizo en moto y no tengo restricciones médicas', {
    context: { currentStep: 'COLLECTING_DATA', pendingFields: ['documentNumber', 'age', 'transportMode', 'medicalRestrictions'] },
    aiResult: {
      status: 'ok',
      used: true,
      intent: 'provide_data',
      parsedFields: { documentNumber: '99999999', age: 30, transportMode: 'Moto', city: 'Bogota', roleHint: 'Auxiliar' },
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      extraction: { turnType: 'DATA_BLOCK', fieldEvidence: { transportMode: transportEvidence } }
    },
    runtime: {
      localParsedData: { documentType: 'CC', documentNumber: '10203040', age: 21 },
      engineFields: { medicalRestrictions: 'Sin restricciones médicas' },
      engineUsage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 },
      fallbackIntent: 'continue_application',
      enrichFields: (fields) => fields
    }
  });

  const snapshot = result.turnInterpretation;
  assert.ok(snapshot);
  assert.equal(snapshot.intent, 'provide_data');
  assert.equal(snapshot.fields.documentType, 'CC');
  assert.equal(snapshot.fields.documentNumber, '99999999');
  assert.equal(snapshot.fields.age, 21);
  assert.equal(snapshot.fields.transportMode, 'Moto');
  assert.equal(snapshot.fields.medicalRestrictions, 'Sin restricciones médicas');
  assert.equal(snapshot.sourceByField.documentNumber, 'merged');
  assert.equal(snapshot.sourceByField.medicalRestrictions, 'engine');
  assert.deepEqual(snapshot.evidenceByField.transportMode, transportEvidence);
  assert.equal(snapshot.cityHint, 'Bogota');
  assert.equal(snapshot.roleHint, 'Auxiliar');
  assert.equal(snapshot.engineFieldCount, 1);
  assert.deepEqual(snapshot.usage, { input_tokens: 5, output_tokens: 7, total_tokens: 12 });
  assert.deepEqual(result.candidateFields, snapshot.fields);
  assert.ok(Array.isArray(snapshot.rejectedFields));
});

test('campos exclusivos del preview no cambian la intención base del turno', async () => {
  const result = await conversationUnderstanding('no tengo restricciones médicas', {
    context: { currentStep: 'COLLECTING_DATA', pendingFields: ['medicalRestrictions'] },
    aiResult: {
      status: 'disabled',
      parsedFields: {},
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
    },
    runtime: {
      localParsedData: {},
      engineFields: { medicalRestrictions: 'Sin restricciones médicas' },
      engineUsage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      fallbackIntent: 'continue_application',
      enrichFields: (fields) => fields
    }
  });

  assert.equal(result.turnInterpretation.fields.medicalRestrictions, 'Sin restricciones médicas');
  assert.equal(result.turnInterpretation.sourceByField.medicalRestrictions, 'engine');
  assert.equal(result.turnInterpretation.intent, 'unknown');
  assert.equal(result.intent, 'unknown');
});

test('conserva la descripción de experiencia que el parser local ya extrajo', async () => {
  const text = 'He trabajado como coordinador operativo liderando equipos de logística y transporte.';
  const result = await conversationUnderstanding(text, {
    context: {
      currentStep: 'COLLECTING_DATA',
      pendingFields: ['experiencia (si o no)', 'tiempo de experiencia (1 año o mas)', 'en qué tiene experiencia']
    }
  });

  assert.equal(result.candidateFields.experienceInfo, 'Sí');
  assert.equal(result.candidateFields.experienceSummary, text);
});

test('caso auditado: si. 60 personas responde experiencia pendiente sin depender del modelo', async () => {
  const result = await conversationUnderstanding('si. 60 personas', {
    context: {
      currentStep: 'COLLECTING_DATA',
      pendingFields: ['experiencia (si o no)', 'tiempo de experiencia (1 año o mas)', 'en qué tiene experiencia']
    },
    aiResult: {
      status: 'disabled',
      intent: 'unknown',
      parsedFields: {},
      extraction: { turnType: 'CONFIRMATION', fieldEvidence: {} },
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
    },
    runtime: {
      localParsedData: {},
      engineFields: {},
      engineUsage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      fallbackIntent: 'continue_application',
      enrichFields: (fields) => fields
    }
  });

  assert.equal(result.turnInterpretation.fields.experienceInfo, 'Sí');
});

test('respuesta negativa corta solo se convierte en experiencia cuando ese campo está pendiente', async () => {
  const result = await conversationUnderstanding('no', {
    context: { currentStep: 'COLLECTING_DATA', pendingFields: ['experiencia (si o no)'] },
    aiResult: {
      status: 'disabled',
      intent: 'unknown',
      parsedFields: {},
      extraction: { turnType: 'CONFIRMATION', fieldEvidence: {} }
    },
    runtime: {
      localParsedData: {},
      engineFields: {},
      enrichFields: (fields) => fields
    }
  });

  assert.equal(result.turnInterpretation.fields.experienceInfo, 'No');
});

test('respuesta contextual breve conserva también la duración declarada', async () => {
  const result = await conversationUnderstanding('sí, 2 años', {
    context: { currentStep: 'COLLECTING_DATA', pendingFields: ['experiencia (si o no)', 'tiempo de experiencia (1 año o mas)'] },
    aiResult: {
      status: 'disabled',
      intent: 'unknown',
      parsedFields: {},
      extraction: { turnType: 'CONFIRMATION', fieldEvidence: {} }
    },
    runtime: {
      localParsedData: {},
      engineFields: {},
      enrichFields: (fields) => fields
    }
  });

  assert.equal(result.turnInterpretation.fields.experienceInfo, 'Sí');
  assert.equal(result.turnInterpretation.fields.experienceTime, '2 años');
});

test('un sí genérico fuera de contexto no se inventa como experiencia', async () => {
  const result = await conversationUnderstanding('sí', {
    context: { currentStep: 'GREETING_SENT', pendingFields: ['nombre completo'] },
    aiResult: {
      status: 'disabled',
      intent: 'confirm_interest',
      parsedFields: {},
      extraction: { turnType: 'CONFIRMATION', fieldEvidence: {} }
    },
    runtime: {
      localParsedData: {},
      engineFields: {},
      enrichFields: (fields) => fields
    }
  });

  assert.equal(result.turnInterpretation.fields.experienceInfo, undefined);
});