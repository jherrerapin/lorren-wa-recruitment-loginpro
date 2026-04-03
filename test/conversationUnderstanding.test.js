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
