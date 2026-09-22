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

function eligibleCandidate() {
  return {
    id: 'candidate-1',
    campaignId: null,
    sourceType: null,
    referrerName: null
  };
}

test('un candidato ya atribuido se descarta antes del clasificador de origen IA', async () => {
  const calls = { findUnique: 0, classify: 0, update: 0, next: 0 };
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
  const middleware = runtime(prisma, {
    classifyLeadOrigin: async () => {
      calls.classify += 1;
      return null;
    }
  });

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
  assert.equal(calls.classify, 0);
  assert.equal(calls.update, 0);
  assert.equal(calls.next, 1);
});

test('una clasificación PERSON sin evidencia literal no persiste referidor', async () => {
  const calls = { update: 0, next: 0 };
  const prisma = {
    candidate: {
      findUnique: async () => eligibleCandidate(),
      update: async () => { calls.update += 1; }
    }
  };
  const middleware = runtime(prisma, {
    classifyLeadOrigin: async () => ({
      kind: 'PERSON',
      score: 0.93,
      label: 'Juan Pérez',
      evidence: 'Juan Pérez me recomendó la vacante'
    })
  });

  await middleware(
    {
      body: webhookPayload({
        from: '3000000000',
        type: 'text',
        text: { body: 'Estoy interesado en auxiliar de bodega y tengo experiencia como conductor' }
      })
    },
    {},
    () => { calls.next += 1; }
  );

  assert.equal(calls.update, 0);
  assert.equal(calls.next, 1);
});

test('una referencia explícita y sustentada sí puede persistirse', async () => {
  const calls = { update: [], next: 0 };
  const prisma = {
    candidate: {
      findUnique: async () => eligibleCandidate(),
      update: async (args) => { calls.update.push(args); }
    }
  };
  const middleware = runtime(prisma, {
    classifyLeadOrigin: async () => ({
      kind: 'PERSON',
      score: 0.96,
      label: 'Juan Pérez',
      evidence: 'Juan Pérez me recomendó esta vacante'
    })
  });

  await middleware(
    {
      body: webhookPayload({
        from: '3000000000',
        type: 'text',
        text: { body: 'Juan Pérez me recomendó esta vacante y me compartió el número' }
      })
    },
    {},
    () => { calls.next += 1; }
  );

  assert.equal(calls.update.length, 1);
  assert.deepEqual(calls.update[0], {
    where: { id: 'candidate-1' },
    data: { referrerName: 'Juan Pérez' }
  });
  assert.equal(calls.next, 1);
});
