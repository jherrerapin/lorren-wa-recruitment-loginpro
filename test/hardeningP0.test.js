import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFieldPolicy } from '../src/services/policyLayer.js';
import { buildPolicyReply } from '../src/services/responsePolicy.js';

test('policy bloquea saludo como nombre', () => {
  const result = applyFieldPolicy({
    fields: { fullName: 'buenas tardes' },
    fieldEvidence: { fullName: { snippet: 'buenas tardes', confidence: 0.91, source: 'model' } }
  });

  assert.equal(result.persistedFields.fullName, undefined);
  assert.equal(result.blocked[0]?.reason, 'greeting_as_name');
});

test('policy bloquea calle 80 como edad', () => {
  const result = applyFieldPolicy({
    fields: { age: 80 },
    fieldEvidence: { age: { snippet: 'vivo en calle 80', confidence: 0.88, source: 'model' } }
  });

  assert.equal(result.persistedFields.age, undefined);
  assert.equal(result.blocked[0]?.reason, 'address_as_age');
});

test('campo crítico ambiguo no dispara descarte automático', () => {
  const result = applyFieldPolicy({
    fields: { age: 17 },
    fieldEvidence: { age: { snippet: 'creo que 17', confidence: 0.4, source: 'model' } }
  });

  assert.equal(result.shouldPreventAutoDiscard, true);
  assert.deepEqual(result.protectedDiscardFields, ['age']);
});

test('género femenino explícito se persiste con evidencia sólida', () => {
  const result = applyFieldPolicy({
    fields: { gender: 'FEMALE' },
    fieldEvidence: { gender: { snippet: 'soy mujer', confidence: 0.95, source: 'responses_extractor' } }
  });

  assert.equal(result.persistedFields.gender, 'FEMALE');
});

test('responsePolicy evita repetición fuerte en consecutivos', () => {
  const repeated = 'Gracias por enviarlo. Para continuar necesito tu hoja de vida en PDF o DOCX.';
  const reply = buildPolicyReply({
    replyIntent: 'request_cv_pdf_word',
    recentOutbound: [{ body: repeated }]
  });

  assert.notEqual(reply.text, repeated);
  assert.match(reply.text, /PDF|DOCX/i);
  assert.equal(reply.intent, 'request_cv_pdf_word');
});
