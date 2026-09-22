import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { generateNaturalReply } from '../src/services/naturalReply.js';

const FLOW_DECIDER_PATH = new URL('../src/services/flowDecider.js', import.meta.url);
const NATURAL_REPLY_PATH = new URL('../src/services/naturalReply.js', import.meta.url);

test('flowDecider legacy permanece eliminado y naturalReply no depende de esa autoridad ficticia', async () => {
  await assert.rejects(access(FLOW_DECIDER_PATH));
  const source = await readFile(NATURAL_REPLY_PATH, 'utf8');
  assert.doesNotMatch(source, /flowDecider\.js|FlowDeciderAction/);
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
