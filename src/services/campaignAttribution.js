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

export function extractReferralFromInboundMessage(message = {}) {
  const referral = message?.referral || message?.context?.referral || null;
  if (!referral || typeof referral !== 'object') return null;
  return referral;
}

export function collectReferralAttributionValues(message = {}) {
  const referral = extractReferralFromInboundMessage(message);
  if (!referral) return [];

  return compactUnique([
    referral.source_id,
    referral.source_url,
    referral.headline,
    referral.body,
    referral.ctwa_clid,
    referral.ad_id,
    referral.adgroup_id,
    referral.campaign_id,
    referral.campaign_name,
    referral.ad_name
  ].map((value) => String(value || '').trim()));
}

export function extractMetaAttributionFields(message = {}) {
  const referral = extractReferralFromInboundMessage(message);
  if (!referral) return {};
  const fields = {
    metaCtwaClid: cleanMetaValue(referral.ctwa_clid),
    metaAdId: cleanMetaValue(referral.ad_id || referral.source_id),
    metaCampaignId: cleanMetaValue(referral.campaign_id),
    metaCampaignName: cleanMetaValue(referral.campaign_name)
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value));
}

function referralIdentityTokens(message = {}) {
  const referral = extractReferralFromInboundMessage(message) || {};
  return compactUnique([
    referral.campaign_id,
    referral.ad_id,
    referral.source_id,
    referral.adgroup_id
  ].map(normalizeCampaignCode)).filter((token) => token.length >= 3);
}

function referralCampaignNameToken(message = {}) {
  const referral = extractReferralFromInboundMessage(message) || {};
  return normalizeAttributionToken(referral.campaign_name);
}

function referralDescriptiveTokens(message = {}) {
  const referral = extractReferralFromInboundMessage(message) || {};
  return compactUnique([
    referral.campaign_name,
    referral.ad_name,
    referral.headline,
    referral.source_url
  ].map(normalizeAttributionToken)).filter((token) => token.length >= 3);
}

function scoreCampaignForReferral(campaign = {}, message = {}) {
  const campaignCode = normalizeCampaignCode(campaign.code);
  const campaignCodeToken = normalizeAttributionToken(campaign.code);
  const campaignName = normalizeAttributionToken(campaign.name);
  const campaignNotes = normalizeAttributionToken(campaign.notes);
  const identityTokens = referralIdentityTokens(message);
  const descriptiveTokens = referralDescriptiveTokens(message);

  if (campaignCode && identityTokens.includes(campaignCode)) {
    return { campaign, score: 10000, mode: 'objective_id_exact' };
  }
  if (campaignCodeToken && identityTokens.includes(campaignCodeToken)) {
    return { campaign, score: 9900, mode: 'objective_id_exact' };
  }

  // Si Meta entregó IDs nuevos que todavía no están registrados internamente,
  // solo aceptamos una segunda señal inequívoca: campaign_name exactamente igual
  // al nombre interno de la campaña. No se degrada a ad_name, notas ni similitud.
  const metaCampaignName = referralCampaignNameToken(message);
  if (identityTokens.length && campaignName && metaCampaignName === campaignName) {
    return { campaign, score: 8500, mode: 'campaign_name_exact_with_objective_metadata' };
  }
  if (identityTokens.length) return { campaign, score: 0, mode: null };

  if (campaignCode && descriptiveTokens.includes(campaignCode)) {
    return { campaign, score: 8000, mode: 'campaign_code_exact' };
  }
  if (campaignCodeToken && descriptiveTokens.includes(campaignCodeToken)) {
    return { campaign, score: 7900, mode: 'campaign_code_exact' };
  }
  if (campaignName && descriptiveTokens.includes(campaignName)) {
    return { campaign, score: 7000, mode: 'campaign_name_exact' };
  }
  if (campaignNotes && descriptiveTokens.includes(campaignNotes)) {
    return { campaign, score: 6000, mode: 'campaign_notes_exact' };
  }

  // Las coincidencias parciales no son una fuente inequívoca de atribución.
  return { campaign, score: 0, mode: null };
}

export function resolveCampaignForReferral(campaigns = [], message = {}) {
  const identityTokens = referralIdentityTokens(message);
  const descriptiveTokens = referralDescriptiveTokens(message);
  if (!identityTokens.length && !descriptiveTokens.length) {
    return { campaign: null, reason: 'no_referral_tokens', matches: [] };
  }

  const matches = campaigns
    .map((campaign) => scoreCampaignForReferral(campaign, message))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || String(a.campaign.id).localeCompare(String(b.campaign.id)));

  if (!matches.length) {
    return {
      campaign: null,
      reason: identityTokens.length
        ? 'objective_metadata_without_exact_campaign_match'
        : 'no_campaign_match',
      matches: []
    };
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

  // La vacante solo se asigna cuando la campaña activa tiene una vacante configurada
  // de forma explícita. No se infiere por texto ni por similitud en esta capa.
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
        phone: from,
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
      // conversacional. Así el bot confirma la vacante de campaña antes de pedir
      // autorización o datos personales.
      await runCampaignAttribution(prisma, req);
      return consentGate(req, res, next);
    } catch (error) {
      console.warn('[CAMPAIGN_ATTRIBUTION_ERROR]', error?.message || error);
      return consentGate(req, res, next);
    }
  };
}
