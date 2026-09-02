import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attributeCandidateCampaignFromMessage,
  extractMetaAttributionFields,
  resolveCampaignForReferral
} from '../src/services/campaignAttribution.js';
import { CAMPAIGN_VACANCY_CONFIRMATION_MODE } from '../src/services/dataConsentGate.js';

function metaAd({ id, vacancyId }) {
  return {
    id: `campaign-${id}`,
    code: id,
    name: `Anuncio ${id}`,
    notes: null,
    sourceType: 'META_ADS',
    vacancyId
  };
}

function ctwaMessage(sourceId, overrides = {}) {
  return {
    referral: {
      source_id: sourceId,
      source_type: 'ad',
      source_url: 'https://fb.me/example',
      headline: 'Convocatoria operativa',
      body: 'Información del proceso',
      ctwa_clid: `clid-${sourceId}`,
      ...overrides
    }
  };
}

function prismaMock({ candidate, campaigns }) {
  const updates = [];
  return {
    updates,
    prisma: {
      candidate: {
        async findUnique() {
          return { ...candidate };
        },
        async update(args) {
          updates.push(args);
          return { id: args.where.id, ...args.data };
        }
      },
      campaign: {
        async findMany() {
          return campaigns;
        }
      }
    }
  };
}

test('CTWA usa source_id exacto como ad id y no el headline para elegir la vacante', () => {
  const campaigns = [
    metaAd({ id: '120000000000101', vacancyId: 'vac-siberia' }),
    { ...metaAd({ id: '120000000000202', vacancyId: 'vac-otra' }), name: 'Convocatoria operativa' }
  ];
  const message = ctwaMessage('120000000000101');

  const resolution = resolveCampaignForReferral(campaigns, message);
  const fields = extractMetaAttributionFields(message);

  assert.equal(resolution.campaign.id, 'campaign-120000000000101');
  assert.equal(resolution.matchMode, 'meta_source_ad_id_exact');
  assert.equal(fields.metaAdId, '120000000000101');
  assert.equal(fields.metaCtwaClid, 'clid-120000000000101');
});

test('CTWA falla cerrado cuando source_id no existe aunque headline coincida con otro anuncio', () => {
  const campaigns = [{
    ...metaAd({ id: '120000000000303', vacancyId: 'vac-incorrecta' }),
    name: 'Auxiliar de bodega Siberia'
  }];
  const resolution = resolveCampaignForReferral(campaigns, ctwaMessage('120000000009999', {
    headline: 'Auxiliar de bodega Siberia'
  }));

  assert.equal(resolution.campaign, null);
  assert.equal(resolution.reason, 'objective_metadata_without_exact_campaign_match');
});

test('un nuevo click CTWA exacto reemplaza campaña y vacante históricas por el proceso consultado ahora', async () => {
  const current = {
    id: 'candidate-ctwa-returning',
    campaignId: 'campaign-old',
    vacancyId: 'vac-old',
    sourceType: 'META_ADS',
    campaignCodeRaw: 'old-ad',
    botResumeMode: null,
    metaCtwaClid: 'clid-old',
    metaAdId: '120000000000001',
    metaCampaignId: null,
    metaCampaignName: null
  };
  const target = metaAd({ id: '120000000000404', vacancyId: 'vac-siberia' });
  const { prisma, updates } = prismaMock({ candidate: current, campaigns: [target] });

  const result = await attributeCandidateCampaignFromMessage(
    prisma,
    current.id,
    ctwaMessage('120000000000404')
  );

  assert.equal(result.attributed, true);
  assert.equal(result.reattributed, true);
  assert.equal(result.reason, 'reattributed_referral_campaign_and_vacancy');
  assert.equal(result.campaignId, target.id);
  assert.equal(result.vacancyId, 'vac-siberia');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.campaignId, target.id);
  assert.equal(updates[0].data.vacancyId, 'vac-siberia');
  assert.equal(updates[0].data.metaAdId, '120000000000404');
  assert.equal(updates[0].data.botResumeMode, CAMPAIGN_VACANCY_CONFIRMATION_MODE);
});

test('un anuncio exacto sin vacante configurada no rompe una asociación histórica válida', async () => {
  const current = {
    id: 'candidate-ctwa-protected',
    campaignId: 'campaign-old',
    vacancyId: 'vac-old',
    sourceType: 'META_ADS',
    campaignCodeRaw: 'old-ad',
    botResumeMode: null,
    metaCtwaClid: 'clid-old',
    metaAdId: '120000000000001',
    metaCampaignId: null,
    metaCampaignName: null
  };
  const unclassified = metaAd({ id: '120000000000505', vacancyId: null });
  const { prisma, updates } = prismaMock({ candidate: current, campaigns: [unclassified] });

  const result = await attributeCandidateCampaignFromMessage(
    prisma,
    current.id,
    ctwaMessage('120000000000505')
  );

  assert.equal(result.attributed, false);
  assert.equal(result.reason, 'exact_ad_without_vacancy_existing_attribution_preserved');
  assert.equal(result.campaignId, 'campaign-old');
  assert.equal(result.vacancyId, 'vac-old');
  assert.equal(updates.length, 0);
});

test('source_id de post no se trata como ad id', () => {
  const resolution = resolveCampaignForReferral(
    [metaAd({ id: '120000000000606', vacancyId: 'vac-one' })],
    ctwaMessage('120000000000606', { source_type: 'post' })
  );

  assert.equal(resolution.campaign, null);
  assert.equal(resolution.reason, 'objective_metadata_without_exact_campaign_match');
});
