function safeJsonParse(value = '') {
  try {
    const parsed = JSON.parse(String(value || '').trim() || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

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

export function getReferralAdId(referral = null) {
  if (!referral || typeof referral !== 'object') return null;
  const value = referral.ad_id
    || referral.adId
    || referral.source_id
    || referral.sourceId
    || referral.id
    || null;
  return value ? String(value) : null;
}

function getAdContextMap() {
  return {
    ...safeJsonParse(process.env.META_AD_CONTEXT_MAP),
    ...safeJsonParse(process.env.META_AD_VACANCY_HINTS),
    ...safeJsonParse(process.env.META_AD_VACANCY_MAP)
  };
}

function formatMappedHint(value) {
  if (!value) return '';
  if (typeof value === 'string') return cleanText(value);
  if (typeof value !== 'object') return '';

  return compactJoin([
    value.city ? `Ciudad: ${value.city}` : '',
    value.vacancy ? `Vacante: ${value.vacancy}` : '',
    value.role ? `Cargo: ${value.role}` : '',
    value.zone ? `Zona: ${value.zone}` : '',
    value.operation ? `Operacion: ${value.operation}` : '',
    value.hint || value.text || value.name || ''
  ]);
}

function buildReferralText(referral = null) {
  if (!referral || typeof referral !== 'object') return '';

  return compactJoin([
    referral.headline,
    referral.body,
    referral.source_url,
    referral.source_type,
    referral.source_id,
    referral.ad_id,
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
  const mappedHint = adId ? formatMappedHint(getAdContextMap()[adId]) : '';
  const referralText = buildReferralText(referral);
  const text = compactJoin([
    mappedHint,
    referralText
  ]);

  return {
    hasAdContext: Boolean(text || adId),
    adId,
    text,
    mapped: Boolean(mappedHint),
    raw: referral,
    reason: mappedHint ? 'mapped_ad_context' : 'referral_context'
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
      mapped: adContext.mapped,
      reason: adContext.reason
    }
  };
}

export function buildAdContextSystemHint(adContext = null) {
  if (!adContext?.text) return '';
  return [
    'Pista interna de origen Meta Ads para acotar ciudad/vacante; no la repitas literal al candidato y no la uses como unica verdad si el candidato la contradice:',
    adContext.text
  ].join(' ');
}
