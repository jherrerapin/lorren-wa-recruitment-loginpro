import test from 'node:test';
import assert from 'node:assert/strict';
import {
  associateCandidatesByExactAdId,
  buildCurrentMetaInventory,
  filterCurrentMetaAds,
  isCurrentMetaAd,
  markAdsMissingFromMeta,
  syncMetaAdsInsights
} from '../src/services/metaAdsInsightsSync.js';

function createPrismaStub({ missingCount = 0 } = {}) {
  const calls = {
    accountUpserts: [],
    campaignDeletes: [],
    campaignUpdates: [],
    campaignUpserts: [],
    candidateUpdates: [],
    campaignSnapshots: [],
    adSnapshots: []
  };
  const prisma = {
    metaAdAccount: {
      upsert: async (args) => {
        calls.accountUpserts.push(args);
        return args.create;
      }
    },
    campaign: {
      deleteMany: async (args) => {
        calls.campaignDeletes.push(args);
        return { count: 0 };
      },
      updateMany: async (args) => {
        calls.campaignUpdates.push(args);
        return { count: missingCount };
      },
      upsert: async (args) => {
        calls.campaignUpserts.push(args);
        return { id: `row-${args.where.code}`, code: args.where.code, vacancyId: null };
      }
    },
    candidate: {
      updateMany: async (args) => {
        calls.candidateUpdates.push(args);
        return { count: 0 };
      }
    },
    metaCampaignSnapshot: {
      upsert: async (args) => {
        calls.campaignSnapshots.push(args);
        return args.create;
      }
    },
    metaAdSnapshot: {
      upsert: async (args) => {
        calls.adSnapshots.push(args);
        return args.create;
      }
    }
  };
  return { prisma, calls };
}

function createClient({ inventoryError = null, insightsError = null, campaigns = [], adsets = [], ads = [] } = {}) {
  return {
    enabled: true,
    adAccountId: 'act_123',
    graphGet: async (path) => {
      if (path === 'act_123') {
        return { id: 'act_123', name: 'Cuenta pruebas', currency: 'COP', timezone_name: 'America/Bogota' };
      }
      if (path.endsWith('/campaigns')) {
        if (inventoryError) throw inventoryError;
        return { data: campaigns };
      }
      if (path.endsWith('/adsets')) return { data: adsets };
      if (path.endsWith('/ads')) return { data: ads };
      if (path.endsWith('/insights')) {
        if (insightsError) throw insightsError;
        return { data: [] };
      }
      throw new Error(`Ruta inesperada: ${path}`);
    },
    graphGetUrl: async () => ({ data: [] })
  };
}

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

test('inventario vacío finaliza todos los anuncios Meta abiertos', async () => {
  let received = null;
  const prisma = {
    campaign: {
      updateMany: async (args) => {
        received = args;
        return { count: 4 };
      }
    }
  };

  const count = await markAdsMissingFromMeta(prisma, [], new Date('2026-07-13T12:00:00.000Z'));
  assert.equal(count, 4);
  assert.deepEqual(received.where, {
    sourceType: 'META_ADS',
    endsAt: null
  });
});

test('fallo de Insights no bloquea la conciliación del inventario actual', async () => {
  const { prisma, calls } = createPrismaStub({ missingCount: 6 });
  const insightsError = new Error('Insights temporalmente no disponible');
  insightsError.code = 190;
  const client = createClient({ insightsError });

  const result = await syncMetaAdsInsights(
    prisma,
    { since: '2026-07-01', until: '2026-07-13' },
    { client }
  );

  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.equal(result.currentAds, 0);
  assert.equal(result.missingAds, 6);
  assert.equal(result.insights.ok, false);
  assert.equal(calls.campaignUpdates.length, 1);
  assert.deepEqual(calls.campaignUpdates[0].where, {
    sourceType: 'META_ADS',
    endsAt: null
  });
  assert.equal(calls.accountUpserts.length, 1);
});

test('fallo al obtener inventario conserva las filas locales y reporta la etapa', async () => {
  const { prisma, calls } = createPrismaStub({ missingCount: 9 });
  const inventoryError = new Error('Permiso insuficiente');
  inventoryError.code = 200;
  const client = createClient({ inventoryError });

  const result = await syncMetaAdsInsights(prisma, {}, { client });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'inventory_fetch');
  assert.equal(result.error.code, 200);
  assert.equal(calls.campaignUpdates.length, 0);
  assert.equal(calls.accountUpserts.length, 0);
});

test('sin configuración retorna un error estructurado y no lanza excepción', async () => {
  const { prisma } = createPrismaStub();
  const client = { enabled: false, missing: ['META_ADS_ACCESS_TOKEN'] };

  const result = await syncMetaAdsInsights(prisma, {}, { client });

  assert.equal(result.ok, false);
  assert.equal(result.enabled, false);
  assert.equal(result.stage, 'configuration');
  assert.equal(result.error.code, 'META_ADS_NOT_CONFIGURED');
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
