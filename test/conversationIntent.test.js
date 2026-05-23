import test from 'node:test';
import assert from 'node:assert/strict';
import { detectConversationIntent, isPostCompletionAck } from '../src/services/conversationIntent.js';

test('detecta intención apply y faq', () => {
  assert.equal(detectConversationIntent('me interesa continuar con la vacante'), 'apply_intent');
  assert.equal(detectConversationIntent('cuando es la entrevista?'), 'faq');
});

test('detecta confirmaciones y correcciones en contexto', () => {
  assert.equal(detectConversationIntent('si, todo está correcto', { currentStep: 'CONFIRMING_DATA' }), 'confirmation_yes');
  assert.equal(detectConversationIntent('no, corrijo el barrio', { currentStep: 'CONFIRMING_DATA' }), 'confirmation_no_or_correction');
});

test('saludo puro solo inicia saludo al comienzo, no reinicia en medio del flujo', () => {
  assert.equal(detectConversationIntent('hola', { currentStep: 'MENU' }), 'greeting');
  assert.equal(detectConversationIntent('hola', { currentStep: 'COLLECTING_DATA' }), 'provide_data');
  assert.equal(detectConversationIntent('hola', { currentStep: 'DONE', isDoneStep: true }), 'post_completion_ack');
});

test('saludo con contenido no tapa datos ni preguntas posteriores', () => {
  assert.equal(detectConversationIntent('hola mi cedula es 1234567890', { currentStep: 'COLLECTING_DATA' }), 'provide_data');
  assert.equal(detectConversationIntent('hola cuanto pagan?', { currentStep: 'COLLECTING_DATA' }), 'faq');
});

test('detecta agradecimiento post cierre', () => {
  assert.equal(detectConversationIntent('ok gracias', { isDoneStep: true }), 'post_completion_ack');
  assert.equal(isPostCompletionAck('bien gracias'), true);
});

test('detecta intención de CV y fallback a provide_data', () => {
  assert.equal(detectConversationIntent('te envío mi hoja de vida'), 'cv_intent');
  assert.equal(detectConversationIntent('CC 1234567890, barrio jordán'), 'provide_data');
});
