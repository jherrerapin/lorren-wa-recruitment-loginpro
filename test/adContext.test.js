import test from 'node:test';
import assert from 'node:assert/strict';

import { extractMessages } from '../src/services/whatsapp.js';
import { consolidateTextMessages } from '../src/services/multiline.js';

test('extractMessages conserva referral CTWA como contexto descriptivo sin mapa paralelo de vacante', () => {
  process.env.META_AD_CONTEXT_MAP = JSON.stringify({
    '120000000000701': {
      city: 'Ciudad equivocada',
      vacancy: 'Vacante equivocada'
    }
  });

  const payload = {
    entry: [{
      changes: [{
        value: {
          messages: [{
            id: 'wamid-ctwa-context',
            from: '573000000701',
            type: 'text',
            text: { body: 'Hola, información' },
            referral: {
              source_id: '120000000000701',
              source_type: 'ad',
              headline: 'Auxiliar de bodega Siberia',
              body: 'Proceso operativo'
            }
          }]
        }
      }]
    }]
  };

  const [message] = extractMessages(payload);

  assert.equal(message.lorrenAdContext.adId, '120000000000701');
  assert.equal(message.lorrenAdContext.mapped, false);
  assert.match(message.lorrenAdContext.text, /Auxiliar de bodega Siberia/i);
  assert.doesNotMatch(message.lorrenAdContext.text, /Vacante equivocada/i);
  assert.doesNotMatch(message.lorrenAdContext.text, /Ciudad equivocada/i);

  delete process.env.META_AD_CONTEXT_MAP;
});

test('consolidateTextMessages marca referral como contexto descriptivo y no como autoridad de vacante', () => {
  const text = consolidateTextMessages([
    {
      body: 'Hola, información',
      rawPayload: {
        lorrenAdContext: {
          text: 'Auxiliar de bodega Siberia | ad | 120000000000702',
          mapped: false,
          reason: 'referral_context'
        }
      }
    }
  ]);

  assert.match(text, /Contexto descriptivo recibido desde Meta Ads/i);
  assert.match(text, /la asociación persistida del anuncio es la autoridad/i);
  assert.match(text, /Auxiliar de bodega Siberia/i);
  assert.match(text, /Hola, información/i);
});

test('source_id de una publicación no se expone como adId', () => {
  const payload = {
    entry: [{
      changes: [{
        value: {
          messages: [{
            id: 'wamid-post-context',
            from: '573000000703',
            type: 'text',
            text: { body: 'Hola' },
            referral: {
              source_id: '120000000000703',
              source_type: 'post',
              headline: 'Publicación orgánica'
            }
          }]
        }
      }]
    }]
  };

  const [message] = extractMessages(payload);

  assert.equal(message.lorrenAdContext.adId, null);
  assert.equal(message.lorrenAdContext.mapped, false);
  assert.match(message.lorrenAdContext.text, /Publicación orgánica/i);
});

test('extractMessages no cambia el flujo organico si no hay referral', () => {
  const payload = {
    entry: [{
      changes: [{
        value: {
          messages: [{
            id: 'wamid-organic-context',
            from: '573000000704',
            type: 'text',
            text: { body: 'Vengo referido por un amigo' }
          }]
        }
      }]
    }]
  };

  const [message] = extractMessages(payload);
  const text = consolidateTextMessages([{ body: message.text.body, rawPayload: message }]);

  assert.equal(message.lorrenAdContext, undefined);
  assert.equal(text, 'Vengo referido por un amigo');
});
