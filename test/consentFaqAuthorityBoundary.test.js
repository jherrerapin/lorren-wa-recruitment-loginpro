import test from 'node:test';
import assert from 'node:assert/strict';

import { buildConsentQuestionReply } from '../src/services/consentFaq.js';
import { buildVacancyQuestionReply } from '../src/services/dataConsentGate.js';

const vacancy = {
  title: 'Auxiliar de Cargue y Descargue',
  city: 'Bogotá',
  companyName: 'LoginPro Service',
  operationName: 'Operación Bogotá',
  description: 'Apoyo en cargue y descargue de mercancía.'
};

test('una pregunta sobre la empresa de la oferta no pertenece a la autoridad de consentimiento', () => {
  const text = '¿Cómo se llama la empresa de la oferta?';

  assert.equal(buildConsentQuestionReply(text), '');
});

test('una pregunta sobre quién trata los datos sí pertenece a la autoridad de consentimiento', () => {
  const reply = buildConsentQuestionReply('¿Qué empresa va a tratar mis datos?');

  assert.match(reply, /LoginPro/i);
  assert.match(reply, /postulación/i);
});

test('la pregunta de empresa queda disponible para la autoridad de vacante existente', () => {
  const text = '¿Para qué empresa u operación es?';

  assert.equal(buildConsentQuestionReply(text), '');
  assert.match(buildVacancyQuestionReply(vacancy, text), /LoginPro Service/i);
});
