import { extractMessages } from './whatsapp.js';

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

function campaignTokens(campaign = {}) {
  return compactUnique([
    normalizeCampaignCode(campaign.code),
    normalizeAttributionToken(campaign.code),
    normalizeAttributionToken(campaign.name),
    normalizeAttributionToken(campaign.notes)
  ]).filter((token) => token.length >= 3);
}

function referralTokens(message = {}) {
  return compactUnique(
    collectReferralAttributionValues(message)
      .flatMap((value) => [normalizeCampaignCode(value), normalizeAttributionToken(value)])
      .filter((token) => token.length >= 3)
  );
}

function tokenMatchesCampaign(referralToken, campaignToken) {
  if (!referralToken || !campaignToken) return false;
  if (referralToken === campaignToken) return true;
  if (referralToken.length < 8 || campaignToken.length < 8) return false;
  return referralToken.includes(campaignToken) || campaignToken.includes(referralToken);
}

function findCampaignForReferral(campaigns = [], message = {}) {
  const tokensFromReferral = referralTokens(message);
  if (!tokensFromReferral.length) return null;

  return campaigns.find((campaign) => {
    const tokensFromCampaign = campaignTokens(campaign);
    return tokensFromReferral.some((referralToken) => (
      tokensFromCampaign.some((campaignToken) => tokenMatchesCampaign(referralToken, campaignToken))
    ));
  }) || null;
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
    select: { id: true, campaignId: true, sourceType: true, campaignCodeRaw: true }
  });

  if (!candidate) return { attributed: false, reason: 'candidate_not_found' };
  if (candidate.campaignId) return { attributed: false, reason: 'candidate_already_attributed' };

  const activeCampaigns = await prisma.campaign.findMany({
    where: { isActive: true },
    select: { id: true, code: true, name: true, notes: true, sourceType: true }
  });

  const matchedCampaign = findCampaignForReferral(activeCampaigns, message);
  const campaignCodeRaw = referralValues.slice(0, 8).join(' | ').slice(0, 1000);

  if (!matchedCampaign) {
    await prisma.candidate.update({
      where: { id: candidateId },
      data: {
        sourceType: 'META_ADS',
        campaignCodeRaw: candidate.campaignCodeRaw || campaignCodeRaw
      }
    });

    return { attributed: false, reason: 'metadata_saved_without_campaign_match', campaignCodeRaw };
  }

  await prisma.candidate.update({
    where: { id: candidateId },
    data: {
      campaignId: matchedCampaign.id,
      sourceType: matchedCampaign.sourceType || 'META_ADS',
      campaignCodeRaw
    }
  });

  return {
    attributed: true,
    reason: 'matched_referral_metadata',
    campaignId: matchedCampaign.id,
    campaignCodeRaw
  };
}

export function campaignAttributionMiddleware(prisma) {
  return async (req, _res, next) => {
    try {
      const messages = extractMessages(req.body);
      if (!messages.length) return next();

      for (const message of messages) {
        const from = message?.from;
        if (!from || !collectReferralAttributionValues(message).length) continue;

        const candidate = await prisma.candidate.upsert({
          where: { phone: from },
          update: {},
          create: { phone: from }
        });

        const result = await attributeCandidateCampaignFromMessage(prisma, candidate.id, message);
        if (result.attributed || result.reason === 'metadata_saved_without_campaign_match') {
          console.info('[CAMPAIGN_ATTRIBUTION]', JSON.stringify({
            phone: from,
            candidateId: candidate.id,
            attributed: result.attributed,
            reason: result.reason,
            campaignId: result.campaignId || null
          }));
        }
      }

      return next();
    } catch (error) {
      console.warn('[CAMPAIGN_ATTRIBUTION_ERROR]', error?.message || error);
      return next();
    }
  };
}
