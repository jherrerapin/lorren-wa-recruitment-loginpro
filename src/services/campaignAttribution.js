import { extractMessages } from './whatsapp.js';
import { CAMPAIGN_VACANCY_CONFIRMATION_MODE, dataConsentGateMiddleware } from './dataConsentGate.js';

function normalizeCampaignCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '-')
    .replace(/[^A-Z0-9_-]/g, '');
}

function normalizeAttributionToken(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/HTTPS?:\/\//g, '')
    .replace(/WWW\./g, '')
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function compactUnique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function cleanMetaValue(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeSourceType(value = '') {
  return String(value || '').trim().toLowerCase();
}

export function extractReferralFromInboundMessage(message = {}) {
  const referral = message?.referral || message?.context?.referral || message?.metadata?.referral || null;
  if (!referral || typeof referral !== 'object') return null;
  return referral;
}

export function collectReferralAttributionValues(message = {}) {
  const referral = extractReferralFromInboundMessage(message);
  if (!referral) return [];

  return compactUnique([
    referral.source_id || referral.sourceId,
    referral.source_url || referral.sourceUrl,
    referral.source_type || referral.sourceType,
    referral.headline,
    referral.body,
    referral.ctwa_clid || referral.ctwaClid,
    referral.ad_id || referral.adId,
    referral.adgroup_id || referral.adgroupId,
    referral.campaign_id || referral.campaignId,
    referral.campaign_name || referral.campaignName,
    referral.ad_name || referral.adName
  ].map((value) => String(value || '').trim()));
}

export function extractReferralAdIdentity(message = {}) {
  const referral = extractReferralFromInboundMessage(message);
  if (!referral) return { adId: null, mode: null, sourceType: null };

  const sourceType = normalizeSourceType(referral.source_type || referral.sourceType);
  const sourceId = cleanMetaValue(referral.source_id || referral.sourceId);
  const explicitAdId = cleanMetaValue(referral.ad_id || referral.adId);

  // Cloud API documenta source_id como el AD_ID cuando source_type=ad.
  // Si source_type fue omitido por una capa intermedia conservamos compatibilidad,
  // pero la asociación sigue exigiendo igualdad exacta contra Campaign.code.
  if (sourceId && (!sourceType || sourceType === 'ad')) {
    return {
      adId: sourceId,
      mode: sourceType === 'ad' ? 'meta_source_ad_id_exact' : 'meta_source_id_exact_legacy',
      sourceType: sourceType || null
    };
  }

  if (explicitAdId) {
    return { adId: explicitAdId, mode: 'meta_ad_id_exact', sourceType: sourceType || null };
  }

  return { adId: null, mode: null, sourceType: sourceType || null };
}

export function extractMetaAttributionFields(message = {}) {
  const referral = extractReferralFromInboundMessage(message);
  if (!referral) return {};
  const adIdentity = extractReferralAdIdentity(message);
  const fields = {
    metaCtwaClid: cleanMetaValue(referral.ctwa_clid || referral.ctwaClid),
    metaAdId: adIdentity.adId,
    metaCampaignId: cleanMetaValue(referral.campaign_id || referral.campaignId),
    metaCampaignName: cleanMetaValue(referral.campaign_name || referral.campaignName)
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value));
}

function referralObjectiveMetadataTokens(message = {}) {
  const referral = extractReferralFromInboundMessage(message) || {};
  return compactUnique([
    referral.source_id || referral.sourceId,
    referral.ad_id || referral.adId,
    referral.campaign_id || referral.campaignId,
    referral.adgroup_id || referral.adgroupId,
    referral.ctwa_clid || referral.ctwaClid
  ].map(normalizeCampaignCode)).filter((token) => token.length >= 3);
}

function referralDescriptiveTokens(message = {}) {
  const referral = extractReferralFromInboundMessage(message) || {};
  return compactUnique([
    referral.campaign_name || referral.campaignName,
    referral.ad_name || referral.adName,
    referral.headline,
    referral.source_url || referral.sourceUrl
  ].map(normalizeAttributionToken)).filter((token) => token.length >= 3);
}

function scoreLegacyCampaignForReferral(campaign = {}, message = {}) {
  const campaignCode = normalizeCampaignCode(campaign.code);
  const campaignCodeToken = normalizeAttributionToken(campaign.code);
  const campaignName = normalizeAttributionToken(campaign.name);
  const campaignNotes = normalizeAttributionToken(campaign.notes);
  const descriptiveTokens = referralDescriptiveTokens(message);

  if (campaignCode && descriptiveTokens.includes(campaignCode)) {
    return { campaign, score: 8000, mode: 'campaign_code_exact_legacy' };
  }
  if (campaignCodeToken && descriptiveTokens.includes(campaignCodeToken)) {
    return { campaign, score: 7900, mode: 'campaign_code_exact_legacy' };
  }
  if (campaignName && descriptiveTokens.includes(campaignName)) {
    return { campaign, score: 7000, mode: 'campaign_name_exact_legacy' };
  }
  if (campaignNotes && descriptiveTokens.includes(campaignNotes)) {
    return { campaign, score: 6000, mode: 'campaign_notes_exact_legacy' };
  }

  return { campaign, score: 0, mode: null };
}

function buildExactAdMatch(campaigns = [], message = {}) {
  const identity = extractReferralAdIdentity(message);
  if (!identity.adId) return { identity, matches: [] };
  const requestedCode = normalizeCampaignCode(identity.adId);
  const matches = campaigns
    .filter((campaign) => requestedCode && normalizeCampaignCode(campaign?.code) === requestedCode)
    .map((campaign) => ({ campaign, score: 10000, mode: identity.mode || 'meta_ad_id_exact' }));
  return { identity, matches };
}

export function resolveCampaignForReferral(campaigns = [], message = {}) {
  const objectiveTokens = referralObjectiveMetadataTokens(message);
  const descriptiveTokens = referralDescriptiveTokens(message);
  if (!objectiveTokens.length && !descriptiveTokens.length) {
    return { campaign: null, reason: 'no_referral_tokens', matches: [] };
  }

  const exactAd = buildExactAdMatch(campaigns, message);
  if (exactAd.identity.adId) {
    if (exactAd.matches.length === 1) {
      const best = exactAd.matches[0];
      return {
        campaign: best.campaign,
        reason: 'exact_campaign_match',
        matchMode: best.mode,
        matches: [{ campaignId: best.campaign.id, score: best.score, mode: best.mode }]
      };
    }
    if (exactAd.matches.length > 1) {
      return {
        campaign: null,
        reason: 'ambiguous_campaign_match',
        matches: exactAd.matches.map((match) => ({ campaignId: match.campaign.id, score: match.score, mode: match.mode }))
      };
    }

    // Un AD_ID explícito es una señal más fuerte que nombres/headlines. Si no existe
    // el anuncio exacto en el inventario actual, fallamos cerrado para no asociar
    // accidentalmente otra vacante del mismo campaign/adset o con texto parecido.
    return {
      campaign: null,
      reason: 'objective_metadata_without_exact_campaign_match',
      matches: []
    };
  }

  // campaign_id, adgroup_id y ctwa_clid son trazabilidad objetiva, pero Campaign.code
  // representa ad.id. No son identificadores intercambiables y no deben elegir vacante.
  if (objectiveTokens.length) {
    return {
      campaign: null,
      reason: 'objective_metadata_without_exact_campaign_match',
      matches: []
    };
  }

  // Compatibilidad para referrals antiguos sin ID objetivo: únicamente coincidencias
  // exactas descriptivas. Nunca se usa similitud parcial en esta capa persistente.
  const matches = campaigns
    .map((campaign) => scoreLegacyCampaignForReferral(campaign, message))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || String(a.campaign.id).localeCompare(String(b.campaign.id)));

  if (!matches.length) {
    return { campaign: null, reason: 'no_campaign_match', matches: [] };
  }

  const best = matches[0];
  const tied = matches.filter((match) => match.score === best.score);
  if (tied.length > 1) {
    return {
      campaign: null,
      reason: 'ambiguous_campaign_match',
      matches: tied.map((match) => ({ campaignId: match.campaign.id, score: match.score, mode: match.mode }))
    };
  }

  return {
    campaign: best.campaign,
    reason: 'exact_campaign_match',
    matchMode: best.mode,
    matches: [{ campaignId: best.campaign.id, score: best.score, mode: best.mode }]
  };
}

function buildAttributionUpdate(candidate = {}, matchedCampaign = null, campaignCodeRaw = '', metaFields = {}) {
  const update = {
    sourceType: matchedCampaign?.sourceType || 'META_ADS',
    campaignCodeRaw: candidate.campaignCodeRaw || campaignCodeRaw,
    ...metaFields
  };

  if (!matchedCampaign) return update;

  update.campaignId = matchedCampaign.id;
  update.campaignCodeRaw = campaignCodeRaw;

  // La vacante solo se asocia cuando el anuncio exacto tiene una vacante configurada.
  // La confirmación del candidato sigue siendo obligatoria antes de iniciar recolección.
  if (matchedCampaign.vacancyId && !candidate.vacancyId) {
    update.vacancyId = matchedCampaign.vacancyId;
    update.botResumeMode = CAMPAIGN_VACANCY_CONFIRMATION_MODE;
  }

  return update;
}

function onlyNewMetaFields(candidate = {}, metaFields = {}) {
  const update = {};
  for (const [field, value] of Object.entries(metaFields)) {
    if (value && !candidate[field]) update[field] = value;
  }
  return update;
}

export async function attributeCandidateCampaignFromMessage(prisma, candidateId, message = {}) {
  if (!prisma?.campaign?.findMany || !prisma?.candidate?.update || !candidateId) {
    return { attributed: false, reason: 'prisma_not_ready' };
  }

  const referralValues = collectReferralAttributionValues(message);
  if (!referralValues.length) {
    return { attributed: false, reason: 'no_referral_metadata' };
  }

  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: {
      id: true,
      campaignId: true,
      vacancyId: true,
      sourceType: true,
      campaignCodeRaw: true,
      botResumeMode: true,
      metaCtwaClid: true,
      metaAdId: true,
      metaCampaignId: true,
      metaCampaignName: true
    }
  });

  if (!candidate) return { attributed: false, reason: 'candidate_not_found' };

  const metaFields = extractMetaAttributionFields(message);
  const campaignCodeRaw = referralValues.slice(0, 8).join(' | ').slice(0, 1000);

  if (candidate.campaignId) {
    const metadataUpdate = onlyNewMetaFields(candidate, metaFields);
    if (Object.keys(metadataUpdate).length) {
      await prisma.candidate.update({ where: { id: candidateId }, data: metadataUpdate });
    }
    return { attributed: false, reason: 'candidate_already_attributed', campaignId: candidate.campaignId };
  }

  const activeCampaigns = await prisma.campaign.findMany({
    where: { isActive: true },
    select: {
      id: true,
      code: true,
      name: true,
      notes: true,
      sourceType: true,
      vacancyId: true
    }
  });

  const resolution = resolveCampaignForReferral(activeCampaigns, message);
  const matchedCampaign = resolution.campaign;

  if (!matchedCampaign) {
    await prisma.candidate.update({
      where: { id: candidateId },
      data: buildAttributionUpdate(candidate, null, campaignCodeRaw, metaFields)
    });

    return {
      attributed: false,
      reason: resolution.reason === 'ambiguous_campaign_match'
        ? 'ambiguous_referral_campaign'
        : 'metadata_saved_without_campaign_match',
      attributionResolutionReason: resolution.reason,
      campaignCodeRaw,
      metaFields,
      matches: resolution.matches
    };
  }

  const updateData = buildAttributionUpdate(candidate, matchedCampaign, campaignCodeRaw, metaFields);
  await prisma.candidate.update({
    where: { id: candidateId },
    data: updateData
  });

  return {
    attributed: true,
    reason: matchedCampaign.vacancyId ? 'matched_referral_campaign_and_vacancy' : 'matched_referral_campaign_without_vacancy',
    matchMode: resolution.matchMode || resolution.reason,
    campaignId: matchedCampaign.id,
    vacancyId: matchedCampaign.vacancyId || null,
    campaignCodeRaw,
    metaFields
  };
}

async function runCampaignAttribution(prisma, req) {
  const messages = extractMessages(req.body);
  if (!messages.length) return;

  for (const message of messages) {
    const from = message?.from;
    if (!from || !collectReferralAttributionValues(message).length) continue;

    const candidate = await prisma.candidate.upsert({
      where: { phone: from },
      update: {},
      create: { phone: from }
    });

    const result = await attributeCandidateCampaignFromMessage(prisma, candidate.id, message);
    if (result.attributed || ['metadata_saved_without_campaign_match', 'ambiguous_referral_campaign'].includes(result.reason)) {
      console.info('[CAMPAIGN_ATTRIBUTION]', JSON.stringify({
        candidateId: candidate.id,
        attributed: result.attributed,
        reason: result.reason,
        attributionResolutionReason: result.attributionResolutionReason || null,
        matchMode: result.matchMode || null,
        campaignId: result.campaignId || null,
        vacancyId: result.vacancyId || null,
        metaAdId: result.metaFields?.metaAdId || null,
        metaCampaignId: result.metaFields?.metaCampaignId || null
      }));
    }
  }
}

export function campaignAttributionMiddleware(prisma) {
  const consentGate = dataConsentGateMiddleware(prisma);
  return async (req, res, next) => {
    try {
      // Primero se guarda la señal objetiva de Meta Ads. Luego se aplica el gate
      // conversacional. Así el bot confirma la vacante del anuncio exacto antes de
      // pedir autorización o datos personales.
      await runCampaignAttribution(prisma, req);
      return consentGate(req, res, next);
    } catch (error) {
      console.warn('[CAMPAIGN_ATTRIBUTION_ERROR]', error?.message || error);
      return consentGate(req, res, next);
    }
  };
}
