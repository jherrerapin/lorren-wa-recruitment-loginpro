import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '../src/services/originRuntime.js';

function webhookPayload(message) {
  return {
    entry: [{
      changes: [{
        value: {
          messages: [message]
        }
      }]
    }]
  };
}

test('un candidato ya atribuido se descarta antes del clasificador de origen IA', async () => {
  const calls = { findUnique: 0, update: 0, next: 0 };
  const prisma = {
    candidate: {
      findUnique: async () => {
        calls.findUnique += 1;
        return {
          id: 'candidate-1',
          campaignId: 'campaign-1',
          sourceType: 'META_ADS',
          referrerName: null
        };
      },
      update: async () => {
        calls.update += 1;
        throw new Error('update_not_expected');
      }
    }
  };
  const middleware = runtime(prisma);

  await middleware(
    {
      body: webhookPayload({
        from: '3000000000',
        type: 'text',
        text: { body: 'Hola, quiero información' }
      })
    },
    {},
    () => { calls.next += 1; }
  );

  assert.equal(calls.findUnique, 1);
  assert.equal(calls.update, 0);
  assert.equal(calls.next, 1);
});
