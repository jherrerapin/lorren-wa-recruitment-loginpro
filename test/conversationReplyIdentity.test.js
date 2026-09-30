import test from 'node:test';
import assert from 'node:assert/strict';
import { preventRepeatedReply } from '../src/core/engine/calculateConversationDecision.js';

test('corta un bucle cuando se repite la misma directiva aunque todavía no exista texto final', () => {
  const decision = preventRepeatedReply({
    history: {
      lastBotQuestion: '¿Qué vacante viste?',
      lastBotReplyIdentity: 'directive:ASK_VACANCY_FOR_CITY'
    }
  }, {
    reply: {
      directive: 'ASK_VACANCY_FOR_CITY',
      parameters: { city: 'Bogotá' }
    },
    transitions: { keepCurrentStep: true }
  });

  assert.equal(decision.reply.directive, undefined);
  assert.match(decision.reply.text, /evitar repetirte/i);
  assert.equal(decision.transitions.handoffToHuman, true);
});

test('no confunde una directiva con un texto que tenga el mismo contenido literal', () => {
  const source = {
    reply: { text: 'ASK_VACANCY_FOR_CITY' },
    transitions: { keepCurrentStep: true }
  };
  const decision = preventRepeatedReply({
    history: {
      lastBotQuestion: null,
      lastBotReplyIdentity: 'directive:ASK_VACANCY_FOR_CITY'
    }
  }, source);

  assert.deepEqual(decision, source);
});

test('mantiene compatibilidad con el historial antiguo basado solo en la última pregunta', () => {
  const decision = preventRepeatedReply({
    history: {
      lastBotQuestion: '¿Cuál es tu ciudad?'
    }
  }, {
    reply: { text: ' ¿CUÁL   es tu ciudad? ' },
    transitions: {}
  });

  assert.equal(decision.transitions.handoffToHuman, true);
});
