import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeCandidateCampaignFromMessage } from '../src/services/campaignAttribution.js';
import { CAMPAIGN_VACANCY_CONFIRMATION_MODE } from '../src/services/dataConsentGate.js';

function createPrisma({ candidate, campaigns }) {
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

function referral(sourceId) {
  return {
    referral: {
      source_id: sourceId,
      source_type: 'ad',
      source_url: 'https://fb.me/example',
      headline: 'Convocatoria operativa',
      body: 'Información del proceso',
      ctwa_clid: `clid-${sourceId}`
    }
  };
}

test('un nuevo click CTWA exacto reemplaza una asociación histórica por el anuncio consultado ahora', async () => {
  const previous = {
    id: 'candidate-returning-ctwa',
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
  const target = {
    id: 'campaign-siberia',
    code: '120000000000404',
    name: 'Anuncio Siberia',
    notes: null,
    sourceType: 'META_ADS',
    vacancyId: 'vac-siberia'
  };
  const { prisma, updates } = createPrisma({ candidate: previous, campaigns: [target] });

  const result = await attributeCandidateCampaignFromMessage(prisma, previous.id, referral(target.code));

  assert.equal(result.attributed, true);
  assert.equal(result.reattributed, true);
  assert.equal(result.reason, 'reattributed_referral_campaign_and_vacancy');
  assert.equal(result.campaignId, target.id);
  assert.equal(result.vacancyId, target.vacancyId);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.campaignId, target.id);
  assert.equal(updates[0].data.vacancyId, target.vacancyId);
  assert.equal(updates[0].data.metaAdId, target.code);
  assert.equal(updates[0].data.botResumeMode, CAMPAIGN_VACANCY_CONFIRMATION_MODE);
});

test('un AD_ID exacto sin vacante configurada no rompe la asociación histórica', async () => {
  const previous = {
    id: 'candidate-protected-ctwa',
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
  const unclassified = {
    id: 'campaign-unclassified',
    code: '120000000000505',
    name: 'Anuncio sin clasificar',
    notes: null,
    sourceType: 'META_ADS',
    vacancyId: null
  };
  const { prisma, updates } = createPrisma({ candidate: previous, campaigns: [unclassified] });

  const result = await attributeCandidateCampaignFromMessage(prisma, previous.id, referral(unclassified.code));

  assert.equal(result.attributed, false);
  assert.equal(result.reason, 'exact_ad_without_vacancy_existing_attribution_preserved');
  assert.equal(result.campaignId, previous.campaignId);
  assert.equal(result.vacancyId, previous.vacancyId);
  assert.equal(updates.length, 0);
});
