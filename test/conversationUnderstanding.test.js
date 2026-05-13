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
