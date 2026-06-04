import test from 'node:test';
import assert from 'node:assert/strict';

import { extractMessages } from '../src/services/whatsapp.js';
import { consolidateTextMessages } from '../src/services/multiline.js';

const OLD_META_AD_CONTEXT_MAP = process.env.META_AD_CONTEXT_MAP;

test.afterEach(() => {
  if (OLD_META_AD_CONTEXT_MAP === undefined) {
    delete process.env.META_AD_CONTEXT_MAP;
  } else {
    process.env.META_AD_CONTEXT_MAP = OLD_META_AD_CONTEXT_MAP;
  }
});

test('extractMessages adjunta contexto de publicidad si Meta envia referral', () => {
  process.env.META_AD_CONTEXT_MAP = JSON.stringify({
    AD_IBAGUE_AUX: {
      city: 'Ibague',
      vacancy: 'Auxiliar de cargue y descargue',
      zone: 'Aeropuerto'
    }
  });

  const payload = {
    entry: [{
      changes: [{
        value: {
          messages: [{
            id: 'wamid-1',
            from: '573001112233',
            type: 'text',
            text: { body: 'Hola, información' },
            referral: {
              ad_id: 'AD_IBAGUE_AUX',
              headline: 'Trabajo en Ibagué'
            }
          }]
        }
      }]
    }]
  };

  const [message] = extractMessages(payload);

  assert.equal(message.lorrenAdContext.adId, 'AD_IBAGUE_AUX');
  assert.equal(message.lorrenAdContext.mapped, true);
  assert.match(message.lorrenAdContext.text, /Ibague/i);
  assert.match(message.lorrenAdContext.text, /Auxiliar de cargue y descargue/i);
});

test('consolidateTextMessages usa la publicidad como pista interna sin borrar el texto del candidato', () => {
  const text = consolidateTextMessages([
    {
      body: 'Hola, información',
      rawPayload: {
        lorrenAdContext: {
          text: 'Ciudad: Ibague | Vacante: Auxiliar de cargue y descargue',
          mapped: true,
          reason: 'mapped_ad_context'
        }
      }
    }
  ]);

  assert.match(text, /Pista interna de origen Meta Ads/i);
  assert.match(text, /Ciudad: Ibague/i);
  assert.match(text, /Hola, información/i);
});

test('extractMessages no cambia el flujo organico si no hay referral', () => {
  const payload = {
    entry: [{
      changes: [{
        value: {
          messages: [{
            id: 'wamid-2',
            from: '573001112233',
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
