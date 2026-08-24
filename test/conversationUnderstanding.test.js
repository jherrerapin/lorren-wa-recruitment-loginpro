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

test('conversationUnderstanding no pierde entidades correctas ante propuestas conflictivas sin evidencia propia', async () => {
  const input = 'Ana Sofia Perez, CC 10203040, 31 años, barrio San Javier, transporte público';
  const result = await conversationUnderstanding(input, {
    context: {
      currentStep: 'COLLECTING_DATA',
      pendingFields: ['fullName', 'documentNumber', 'age', 'neighborhood', 'transportMode']
    },
    aiResult: {
      status: 'ok',
      used: true,
      intent: 'provide_data',
      parsedFields: {
        fullName: 'San Javier',
        documentNumber: '99999999',
        age: 44,
        neighborhood: 'Ana Sofia Perez',
        transportMode: 'Moto'
      },
      extraction: {
        turnType: 'PROVIDE_DATA',
        fieldEvidence: {
          fullName: { snippet: 'San Javier', confidence: 0.93, source: 'ai_extraction' },
          documentNumber: { snippet: '10203040', confidence: 0.93, source: 'ai_extraction' },
          age: { snippet: '31 años', confidence: 0.93, source: 'ai_extraction' },
          neighborhood: { snippet: 'Ana Sofia Perez', confidence: 0.93, source: 'ai_extraction' },
          transportMode: { snippet: 'transporte público', confidence: 0.93, source: 'ai_extraction' }
        }
      }
    },
    runtime: {
      localParsedData: {
        fullName: 'Ana Sofia Perez',
        documentType: 'CC',
        documentNumber: '10203040',
        age: 31,
        neighborhood: 'San Javier',
        transportMode: 'Publico'
      },
      engineFields: {},
      enrichFields: (fields) => fields
    }
  });

  assert.equal(result.candidateFields.fullName, 'Ana Sofia Perez');
  assert.equal(result.candidateFields.documentNumber, '10203040');
  assert.equal(result.candidateFields.age, 31);
  assert.equal(result.candidateFields.neighborhood, 'San Javier');
  assert.equal(result.candidateFields.transportMode, 'Publico');
  assert.equal(result.turnInterpretation.sourceByField.fullName, 'local');
  assert.equal(result.turnInterpretation.sourceByField.documentNumber, 'local');
  assert.equal(result.turnInterpretation.sourceByField.age, 'local');
  assert.equal(result.turnInterpretation.sourceByField.neighborhood, 'local');
  assert.equal(result.turnInterpretation.sourceByField.transportMode, 'local');
});

test('conversationUnderstanding conserva fallback aceptado si una propuesta IA posterior es rechazada', async () => {
  const input = 'Buenas tardes. Mi nombre es Ana Sofia Perez, CC 10203040';
  const result = await conversationUnderstanding(input, {
    context: { currentStep: 'COLLECTING_DATA', pendingFields: ['fullName', 'documentNumber'] },
    aiResult: {
      status: 'ok',
      used: true,
      intent: 'provide_data',
      parsedFields: { fullName: 'Buenas Tardes' },
      extraction: {
        turnType: 'PROVIDE_DATA',
        fieldEvidence: {
          fullName: { snippet: 'Buenas tardes', confidence: 0.94, source: 'ai_extraction' }
        }
      }
    },
    runtime: {
      localParsedData: { fullName: 'Ana Sofia Perez', documentType: 'CC', documentNumber: '10203040' },
      engineFields: {},
      enrichFields: (fields) => fields
    }
  });

  assert.equal(result.candidateFields.fullName, 'Ana Sofia Perez');
  assert.equal(result.candidateFields.documentNumber, '10203040');
  assert.equal(result.turnInterpretation.sourceByField.fullName, 'local');
});

test('conversationUnderstanding permite a IA completar un valor local cuando su evidencia sí respalda la mejora', async () => {
  const input = 'Ana Sofia Perez Lopez, CC 10203040';
  const result = await conversationUnderstanding(input, {
    context: { currentStep: 'COLLECTING_DATA', pendingFields: ['fullName', 'documentNumber'] },
    aiResult: {
      status: 'ok',
      used: true,
      intent: 'provide_data',
      parsedFields: { fullName: 'Ana Sofia Perez Lopez' },
      extraction: {
        turnType: 'PROVIDE_DATA',
        fieldEvidence: {
          fullName: { snippet: 'Ana Sofia Perez Lopez', confidence: 0.96, source: 'ai_extraction' }
        }
      }
    },
    runtime: {
      localParsedData: { fullName: 'Ana Sofia Perez', documentType: 'CC', documentNumber: '10203040' },
      engineFields: {},
      enrichFields: (fields) => fields
    }
  });

  assert.equal(result.candidateFields.fullName, 'Ana Sofia Perez Lopez');
  assert.equal(result.turnInterpretation.sourceByField.fullName, 'merged');
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
  assert.equal(snapshot.fields.documentNumber, '10203040');
  assert.equal(snapshot.fields.age, 21);
  assert.equal(snapshot.fields.transportMode, 'Moto');
  assert.equal(snapshot.fields.medicalRestrictions, 'Sin restricciones médicas');
  assert.equal(snapshot.sourceByField.documentNumber, 'local');
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
