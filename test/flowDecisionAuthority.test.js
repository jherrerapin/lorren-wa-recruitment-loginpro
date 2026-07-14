import test from 'node:test';
import assert from 'node:assert/strict';
import * as flowDeciderModule from '../src/services/flowDecider.js';
import { generateNaturalReply } from '../src/services/naturalReply.js';

test('flowDecider conserva etiquetas pero ya no decide el avance conversacional', () => {
  assert.deepEqual(Object.keys(flowDeciderModule), ['FlowDeciderAction']);
  assert.equal(flowDeciderModule.decideNextAction, undefined);
});

test('naturalReply redacta una acción recibida sin calcular un camino de flujo', async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    const reply = await generateNaturalReply({
      vacancy: { title: 'Auxiliar de Bodega', city: 'Bogotá' },
      candidate: {},
      inboundText: '¿Qué información tienen de la vacante?',
      conversationContext: 'La política del turno ya autorizó responder desde la vacante.',
      flowDecision: { action: 'ANSWER_FROM_VACANCY', payload: null }
    });

    assert.match(reply, /Auxiliar de Bodega/i);
    assert.doesNotMatch(reply, /hoja de vida|entrevista|dato pendiente/i);
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  }
});
