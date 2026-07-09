const DEFAULT_MIN_REPEAT_TOKENS = 5;

export const ReplySimilarityThreshold = Object.freeze({
  LOOP_GUARD: 0.78,
  RESPONSE_POLICY: 0.8,
  CONTEXTUAL_REPLY: 0.85
});

export function normalizeReplySignature(text = '') {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function replyTokenCount(reply = '') {
  return normalizeReplySignature(reply).split(' ').filter(Boolean).length;
}

export function tokenOverlapRatio(a = '', b = '') {
  const aTokens = new Set(normalizeReplySignature(a).split(' ').filter(Boolean));
  const bTokens = new Set(normalizeReplySignature(b).split(' ').filter(Boolean));
  if (!aTokens.size || !bTokens.size) return 0;

  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1;
  }

  return intersection / Math.max(aTokens.size, bTokens.size);
}

export function isSubstantiallySimilarReply(
  nextReply = '',
  previousReply = '',
  { threshold = ReplySimilarityThreshold.LOOP_GUARD, minTokens = DEFAULT_MIN_REPEAT_TOKENS } = {}
) {
  const next = normalizeReplySignature(nextReply);
  const previous = normalizeReplySignature(previousReply);
  if (!next || !previous) return false;
  if (next === previous) return true;
  if (replyTokenCount(next) < minTokens || replyTokenCount(previous) < minTokens) return false;
  if (next.length > 24 && previous.length > 24 && (next.includes(previous) || previous.includes(next))) {
    return true;
  }
  return tokenOverlapRatio(next, previous) >= threshold;
}

export function getReplyPurpose(source = {}) {
  return String(
    source?.raw?.responsePurpose
    || source?.raw?.detectedIntent
    || source?.responsePurpose
    || source?.detectedIntent
    || ''
  ).trim().toLowerCase();
}

export function getReplyActionTypes(source = {}) {
  const actions = Array.isArray(source?.actions)
    ? source.actions
    : (Array.isArray(source?.raw?.actions) ? source.raw.actions : []);
  return actions.map((action) => action?.type).filter(Boolean);
}

export function isRepeatedPurposeOrAction(next = {}, previous = {}) {
  const purpose = getReplyPurpose(next);
  const previousPayload = previous?.rawPayload || previous || {};
  const previousPurpose = getReplyPurpose(previousPayload);
  if (purpose && previousPurpose && purpose === previousPurpose) return true;

  const actionTypes = new Set(getReplyActionTypes(next));
  if (!actionTypes.size) return false;
  return getReplyActionTypes(previousPayload).some((type) => actionTypes.has(type));
}
