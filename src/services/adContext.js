function cleanText(value = '') {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactJoin(values = []) {
  return values
    .map(cleanText)
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index)
    .join(' | ')
    .slice(0, 900);
}

function getReferral(message = {}) {
  return message?.referral
    || message?.context?.referral
    || message?.metadata?.referral
    || null;
}

function normalizeSourceType(value = '') {
  return String(value || '').trim().toLowerCase();
}

export function getReferralAdId(referral = null) {
  if (!referral || typeof referral !== 'object') return null;
  const explicitAdId = referral.ad_id || referral.adId || null;
  if (explicitAdId) return String(explicitAdId);

  const sourceType = normalizeSourceType(referral.source_type || referral.sourceType);
  const sourceId = referral.source_id || referral.sourceId || null;
  if (sourceId && (!sourceType || sourceType === 'ad')) return String(sourceId);
  return null;
}

function buildReferralText(referral = null) {
  if (!referral || typeof referral !== 'object') return '';

  return compactJoin([
    referral.headline,
    referral.body,
    referral.source_url || referral.sourceUrl,
    referral.source_type || referral.sourceType,
    referral.source_id || referral.sourceId,
    referral.ad_id || referral.adId,
    referral.title,
    referral.description
  ]);
}

export function extractAdContextFromMessage(message = {}) {
  const referral = getReferral(message);
  if (!referral) {
    return {
      hasAdContext: false,
      adId: null,
      text: '',
      mapped: false,
      raw: null,
      reason: 'no_referral'
    };
  }

  const adId = getReferralAdId(referral);
  const referralText = buildReferralText(referral);

  return {
    hasAdContext: Boolean(referralText || adId),
    adId,
    text: referralText,
    mapped: false,
    raw: referral,
    reason: 'referral_context'
  };
}

export function attachAdContextToMessage(message = {}) {
  const adContext = extractAdContextFromMessage(message);
  if (!adContext.hasAdContext) return message;

  return {
    ...message,
    lorrenAdContext: {
      adId: adContext.adId,
      text: adContext.text,
      mapped: false,
      reason: adContext.reason
    }
  };
}

export function buildAdContextSystemHint(adContext = null) {
  if (!adContext?.text) return '';
  return [
    'Contexto descriptivo recibido desde Meta Ads. No selecciones ni cambies una vacante con este texto; la asociación persistida del anuncio es la autoridad. Úsalo solo para entender preguntas del candidato y no lo repitas literalmente:',
    adContext.text
  ].join(' ');
}
