import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMPAIGN_VACANCY_CONFIRMATION_MODE } from '../src/services/dataConsentGate.js';
import { attributeCandidateCampaignFromMessage } from '../src/services/campaignAttribution.js';

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
          return { ...candidate, ...args.data };
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

test('CTWA exacto completa una atribución histórica sin vacante persistida', async () => {
  const candidate = {
    id: 'candidate-history-without-vacancy',
    campaignId: 'campaign-history',
    vacancyId: null,
    sourceType: 'META_ADS',
    campaignCodeRaw: 'ad-history',
    botResumeMode: null,
    metaCtwaClid: 'clid-history',
    metaAdId: 'ad-history',
    metaCampaignId: null,
    metaCampaignName: null
  };
  const target = {
    id: 'campaign-current',
    code: 'ad-current',
    name: 'Anuncio operación prueba',
    notes: null,
    sourceType: 'META_ADS',
    vacancyId: 'vacancy-current'
  };
  const { prisma, updates } = createPrisma({ candidate, campaigns: [target] });

  const result = await attributeCandidateCampaignFromMessage(prisma, candidate.id, {
    referral: {
      source_type: 'ad',
      source_id: target.code,
      ctwa_clid: 'clid-current'
    }
  });

  assert.equal(result.attributed, true);
  assert.equal(result.campaignId, target.id);
  assert.equal(result.vacancyId, target.vacancyId);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.campaignId, target.id);
  assert.equal(updates[0].data.vacancyId, target.vacancyId);
  assert.equal(updates[0].data.metaAdId, target.code);
  assert.equal(updates[0].data.botResumeMode, CAMPAIGN_VACANCY_CONFIRMATION_MODE);
});
