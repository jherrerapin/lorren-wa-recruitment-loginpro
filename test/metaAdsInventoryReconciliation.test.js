import test from 'node:test';
import assert from 'node:assert/strict';
import {
  associateCandidatesByExactAdId,
  markAdsMissingFromMeta
} from '../src/services/metaAdsInsightsSync.js';

test('marca como histórico el anuncio sincronizado que ya no aparece en Meta', async () => {
  let received = null;
  const prisma = {
    campaign: {
      updateMany: async (args) => {
        received = args;
        return { count: 2 };
      }
    }
  };
  const syncedAt = new Date('2026-07-13T12:00:00.000Z');
  const count = await markAdsMissingFromMeta(prisma, [{ id: 'ad-current' }], syncedAt);

  assert.equal(count, 2);
  assert.deepEqual(received.where, {
    sourceType: 'META_ADS',
    createdByUsername: 'meta-ads-sync',
    endsAt: null,
    code: { notIn: ['ad-current'] }
  });
  assert.equal(received.data.isActive, false);
  assert.equal(received.data.endsAt, syncedAt);
});

test('inventario vacío concilia todos los anuncios sincronizados vigentes', async () => {
  let received = null;
  const prisma = {
    campaign: {
      updateMany: async (args) => {
        received = args;
        return { count: 4 };
      }
    }
  };

  await markAdsMissingFromMeta(prisma, [], new Date('2026-07-13T12:00:00.000Z'));
  assert.equal(Object.hasOwn(received.where, 'code'), false);
});

test('asocia candidato únicamente por ad_id exacto y completa vacante solo si falta', async () => {
  const calls = [];
  const prisma = {
    candidate: {
      updateMany: async (args) => {
        calls.push(args);
        return { count: 1 };
      }
    }
  };

  const result = await associateCandidatesByExactAdId(prisma, [{
    id: 'campaign-1',
    code: 'ad-123',
    vacancyId: 'vacancy-1'
  }]);

  assert.deepEqual(result, { associated: 1, vacancyFilled: 1 });
  assert.deepEqual(calls[0], {
    where: {
      sourceType: 'META_ADS',
      metaAdId: 'ad-123',
      campaignId: null
    },
    data: { campaignId: 'campaign-1' }
  });
  assert.deepEqual(calls[1], {
    where: {
      sourceType: 'META_ADS',
      metaAdId: 'ad-123',
      vacancyId: null
    },
    data: { vacancyId: 'vacancy-1' }
  });
});
