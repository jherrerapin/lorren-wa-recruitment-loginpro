import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMetaAdsClient,
  getMetaAdsConfig,
  normalizeMetaGraphError
} from '../src/services/metaAdsClient.js';
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

function createClient({ inventoryError = null, insightsError = null, ads = [] } = {}) {
  const calls = [];
  return {
    enabled: true,
    adAccountId: 'act_123',
    calls,
    graphGet: async (path, params = {}) => {
      calls.push({ path, params });
      if (path === 'act_123') {
        return { id: 'act_123', name: 'Cuenta pruebas', currency: 'COP', timezone_name: 'America/Bogota' };
      }
      if (path.endsWith('/ads')) {
        if (inventoryError) throw inventoryError;
        return { data: ads };
      }
      if (path.endsWith('/insights')) {
        if (insightsError) throw insightsError;
        return { data: [] };
      }
      throw new Error(`Ruta inesperada: ${path}`);
    },
    graphGetUrl: async () => ({ data: [] })
  };
}

function currentAd(overrides = {}) {
  return {
    id: 'ad-current',
    name: 'Anuncio actual',
    status: 'ACTIVE',
    effective_status: 'ACTIVE',
    campaign_id: 'campaign-current',
    adset_id: 'adset-current',
    campaign: {
      id: 'campaign-current',
      name: 'Campaña actual',
      status: 'ACTIVE',
      effective_status: 'ACTIVE'
    },
    adset: {
      id: 'adset-current',
      name: 'Conjunto actual',
      campaign_id: 'campaign-current',
      status: 'ACTIVE',
      effective_status: 'ACTIVE'
    },
    ...overrides
  };
}

test('token de WhatsApp no configura Marketing API por accidente', () => {
  const config = getMetaAdsConfig({
    META_ACCESS_TOKEN: 'token-whatsapp',
    META_AD_ACCOUNT_ID: '123'
  });

  assert.equal(config.enabled, false);
  assert.equal(config.credential, null);
  assert.deepEqual(config.missing, ['META_ADS_ACCESS_TOKEN']);
});

test('credencial dedicada configura el cliente de anuncios', () => {
  const config = getMetaAdsConfig({
    META_ADS_ACCESS_TOKEN: 'token-marketing',
    META_AD_ACCOUNT_ID: '123',
    META_API_VERSION: 'v23.0'
  });

  assert.equal(config.enabled, true);
  assert.equal(config.adAccountId, 'act_123');
  assert.equal(config.apiVersion, 'v23.0');
});

test('error Graph conserva código real y elimina el token del endpoint', () => {
  const normalized = normalizeMetaGraphError({
    name: 'AxiosError',
    code: 'ERR_BAD_REQUEST',
    message: 'Request failed with status code 400',
    response: {
      status: 400,
      data: {
        error: {
          message: 'Invalid OAuth access token.',
          type: 'OAuthException',
          code: 190,
          error_subcode: 463,
          fbtrace_id: 'trace-1'
        }
      }
    }
  }, 'https://graph.facebook.com/v23.0/act_123/ads?access_token=secreto');

  assert.equal(normalized.code, 190);
  assert.equal(normalized.metaSubcode, 463);
  assert.equal(normalized.httpStatus, 400);
  assert.equal(normalized.message, 'Invalid OAuth access token.');
  assert.equal(normalized.endpoint.includes('secreto'), false);
  assert.equal(normalized.endpoint.includes('access_token'), false);
});

test('cliente convierte el 400 de Axios en un error Meta útil', async () => {
  const httpClient = {
    get: async () => {
      const error = new Error('Request failed');
      error.code = 'ERR_BAD_REQUEST';
      error.response = {
        status: 400,
        data: { error: { message: 'Permiso ads_read requerido.', code: 200, error_subcode: 10 } }
      };
      throw error;
    }
  };
  const client = createMetaAdsClient({
    META_ADS_ACCESS_TOKEN: 'token-marketing',
    META_AD_ACCOUNT_ID: '123'
  }, httpClient);

  await assert.rejects(
    () => client.graphGet('act_123/ads'),
    (error) => error.name === 'MetaGraphApiError'
      && error.code === 200
      && error.metaSubcode === 10
      && error.endpoint === '/v23.0/act_123/ads'
  );
});

test('descarta anuncios eliminados, archivados o corruptos y conserva estados vigentes', () => {
  const inventory = [
    currentAd({ id: 'ad-active' }),
    currentAd({ id: 'ad-paused', status: 'PAUSED', effective_status: 'PAUSED' }),
    currentAd({ id: 'ad-review', effective_status: 'PENDING_REVIEW' }),
    currentAd({ id: 'ad-deleted', status: 'DELETED', effective_status: 'DELETED' }),
    currentAd({ id: 'ad-archived', status: 'ARCHIVED', effective_status: 'ARCHIVED' }),
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
  assert.deepEqual(filterCurrentMetaAds(inventory).map((ad) => ad.id), [
    'ad-active',
    'ad-paused',
    'ad-review'
  ]);
});

test('inventario se construye desde anuncios y sus relaciones campaña y conjunto', () => {
  const inventory = buildCurrentMetaInventory({
    ads: [
      currentAd(),
      currentAd({
        id: 'ad-deleted-parent',
        campaign: {
          id: 'campaign-current',
          status: 'DELETED',
          effective_status: 'DELETED'
        }
      }),
      currentAd({
        id: 'ad-deleted-adset',
        adset: {
          id: 'adset-current',
          campaign_id: 'campaign-current',
          status: 'ARCHIVED',
          effective_status: 'ARCHIVED'
        }
      })
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

test('sincronización consulta una sola fuente de inventario y vacía filas anteriores', async () => {
  const { prisma, calls } = createPrismaStub({ missingCount: 8 });
  const client = createClient({ ads: [] });

  const result = await syncMetaAdsInsights(
    prisma,
    { since: '2026-07-01', until: '2026-07-13' },
    { client }
  );

  assert.equal(result.ok, true);
  assert.equal(result.currentAds, 0);
  assert.equal(result.missingAds, 8);
  assert.equal(calls.campaignUpdates.length, 1);
  assert.equal(calls.campaignUpserts.length, 0);
  assert.equal(client.calls.some((call) => call.path.endsWith('/campaigns')), false);
  assert.equal(client.calls.some((call) => call.path.endsWith('/adsets')), false);
  assert.equal(client.calls.filter((call) => call.path.endsWith('/ads')).length, 1);
  const adsCall = client.calls.find((call) => call.path.endsWith('/ads'));
  assert.match(adsCall.params.fields, /campaign\{id,name,status,effective_status\}/);
  assert.match(adsCall.params.fields, /adset\{id,name,status,effective_status,campaign_id\}/);
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
  assert.equal(calls.accountUpserts.length, 1);
});

test('fallo al obtener anuncios conserva filas y reporta error real y etapa exacta', async () => {
  const { prisma, calls } = createPrismaStub({ missingCount: 9 });
  const inventoryError = new Error('Permiso ads_read requerido.');
  inventoryError.name = 'MetaGraphApiError';
  inventoryError.code = 200;
  inventoryError.metaCode = 200;
  inventoryError.metaSubcode = 10;
  inventoryError.endpoint = '/v23.0/act_123/ads';
  inventoryError.httpStatus = 400;
  const client = createClient({ inventoryError });

  const result = await syncMetaAdsInsights(prisma, {}, { client });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'ads_fetch');
  assert.equal(result.error.code, 200);
  assert.equal(result.error.subcode, 10);
  assert.equal(result.error.endpoint, '/v23.0/act_123/ads');
  assert.equal(result.error.message, 'Permiso ads_read requerido.');
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
