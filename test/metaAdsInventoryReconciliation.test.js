import test from 'node:test';
import assert from 'node:assert/strict';
import {
  associateCandidatesByExactAdId,
  buildCurrentMetaInventory,
  filterCurrentMetaAds,
  isCurrentMetaAd,
  markAdsMissingFromMeta
} from '../src/services/metaAdsInsightsSync.js';

test('descarta anuncios eliminados, archivados o corruptos y conserva estados vigentes', () => {
  const inventory = [
    { id: 'ad-active', status: 'ACTIVE', effective_status: 'ACTIVE' },
    { id: 'ad-paused', status: 'PAUSED', effective_status: 'PAUSED' },
    { id: 'ad-review', status: 'ACTIVE', effective_status: 'PENDING_REVIEW' },
    { id: 'ad-deleted', status: 'DELETED', effective_status: 'DELETED' },
    { id: 'ad-archived', status: 'ARCHIVED', effective_status: 'ARCHIVED' },
    { id: 'ad-inherited-deleted', status: 'PAUSED', effective_status: 'DELETED' },
    null,
    'fila-corrupta'
  ];

  assert.equal(isCurrentMetaAd(inventory[0]), true);
  assert.equal(isCurrentMetaAd(inventory[1]), true);
  assert.equal(isCurrentMetaAd(inventory[2]), true);
  assert.equal(isCurrentMetaAd(inventory[3]), false);
  assert.equal(isCurrentMetaAd(inventory[4]), false);
  assert.equal(isCurrentMetaAd(inventory[5]), false);
  assert.equal(isCurrentMetaAd(inventory[6]), false);
  assert.equal(isCurrentMetaAd(inventory[7]), false);
  assert.deepEqual(filterCurrentMetaAds(inventory).map((ad) => ad.id), [
    'ad-active',
    'ad-paused',
    'ad-review'
  ]);
});

test('un anuncio solo es actual cuando también existen su campaña y conjunto actuales', () => {
  const inventory = buildCurrentMetaInventory({
    campaigns: [
      { id: 'campaign-current', status: 'PAUSED', effective_status: 'PAUSED' },
      { id: 'campaign-deleted', status: 'DELETED', effective_status: 'DELETED' }
    ],
    adsets: [
      { id: 'adset-current', campaign_id: 'campaign-current', status: 'PAUSED', effective_status: 'PAUSED' },
      { id: 'adset-deleted-parent', campaign_id: 'campaign-deleted', status: 'ACTIVE', effective_status: 'CAMPAIGN_PAUSED' },
      { id: 'adset-deleted', campaign_id: 'campaign-current', status: 'DELETED', effective_status: 'DELETED' }
    ],
    ads: [
      { id: 'ad-current', campaign_id: 'campaign-current', adset_id: 'adset-current', status: 'PAUSED', effective_status: 'PAUSED' },
      { id: 'ad-orphan-campaign', campaign_id: 'campaign-deleted', adset_id: 'adset-deleted-parent', status: 'ACTIVE', effective_status: 'CAMPAIGN_PAUSED' },
      { id: 'ad-orphan-adset', campaign_id: 'campaign-current', adset_id: 'adset-deleted', status: 'ACTIVE', effective_status: 'ADSET_PAUSED' }
    ]
  });

  assert.deepEqual(inventory.currentCampaigns.map((row) => row.id), ['campaign-current']);
  assert.deepEqual(inventory.currentAdsets.map((row) => row.id), ['adset-current']);
  assert.deepEqual(inventory.currentAds.map((row) => row.id), ['ad-current']);
});

test('si no existen campañas o conjuntos actuales no conserva anuncios hijos devueltos por Meta', () => {
  const inventory = buildCurrentMetaInventory({
    campaigns: [{ id: 'campaign-deleted', status: 'DELETED', effective_status: 'DELETED' }],
    adsets: [{ id: 'adset-old', campaign_id: 'campaign-deleted', status: 'ACTIVE', effective_status: 'CAMPAIGN_PAUSED' }],
    ads: [{ id: 'ad-old', campaign_id: 'campaign-deleted', adset_id: 'adset-old', status: 'ACTIVE', effective_status: 'CAMPAIGN_PAUSED' }]
  });

  assert.equal(inventory.currentCampaigns.length, 0);
  assert.equal(inventory.currentAdsets.length, 0);
  assert.equal(inventory.currentAds.length, 0);
});

test('marca como finalizado cualquier registro local Meta que ya no está en el inventario', async () => {
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
    endsAt: null,
    code: { notIn: ['ad-current'] }
  });
  assert.equal(received.data.isActive, false);
  assert.equal(received.data.endsAt, syncedAt);
});

test('inventario vacío concilia todos los anuncios Meta vigentes sin depender de su creador', async () => {
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
  assert.deepEqual(received.where, {
    sourceType: 'META_ADS',
    endsAt: null
  });
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
