import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConsentQuestionReply } from '../src/services/consentFaq.js';
import { buildVacancyQuestionReply } from '../src/services/dataConsentGate.js';

test('una pregunta por la empresa de la oferta no es absorbida por la FAQ de consentimiento', () => {
  const vacancy = {
    operation: { name: 'Operación Prueba' }
  };

  assert.equal(
    buildConsentQuestionReply('¿Cómo se llama la empresa de la oferta?'),
    ''
  );
  assert.match(
    buildVacancyQuestionReply(vacancy, '¿Cómo se llama la empresa de la oferta?'),
    /Operación Prueba|LoginPro/i
  );
});

test('una pregunta por quién trata los datos sigue siendo FAQ de consentimiento', () => {
  assert.match(
    buildConsentQuestionReply('¿Qué empresa va a tratar mis datos?'),
    /LoginPro/i
  );
});
