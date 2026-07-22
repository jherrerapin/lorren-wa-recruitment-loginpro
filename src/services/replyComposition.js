function normalizeComparableReplyText(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const REQUEST_VERB_PATTERN = /\b(?:adjunta|adjuntar|envia|enviar|enviame|comparte|comparteme|confirma|confirmame|indica|indicame|dime|corrige|corrigeme|responde|necesito|falta|faltan|me falta|me faltan)\b/;
const CV_PATTERN = /\b(?:hoja de vida|hv|curriculum|cv)\b/;
const DATA_PATTERN = /\b(?:datos?|nombre|documento|cedula|edad|localidad|barrio|residencia|restricciones|transporte)\b/;
const VACANCY_PATTERN = /\b(?:vacante|cargo|operacion)\b/;
const CONFIRMATION_PATTERN = /\b(?:confirm\w*|correct\w*|esta bien|responde si|correccion\w*|corrige\w*)\b/;
const FUTURE_PROFILE_PATTERN = /\b(?:perfil|registro|registrad[oa])\b/;
const FUTURE_OPENING_PATTERN = /\b(?:futura|futuras|proxima apertura|reabr\w*|vuelva a abrir|se vuelve a abrir|se abra)\b/;

export function detectReplyFollowUpTargets(value = '') {
  const normalized = normalizeComparableReplyText(value);
  const targets = new Set();
  if (!normalized) return [];

  const requestsAction = REQUEST_VERB_PATTERN.test(normalized);
  const mentionsVacancy = VACANCY_PATTERN.test(normalized);

  if (CV_PATTERN.test(normalized) && (requestsAction || /\b(?:solo me falta|para continuar|para cerrar|para finalizar)\b/.test(normalized))) {
    targets.add('cv_upload');
  }

  if (DATA_PATTERN.test(normalized) && (requestsAction || /\b(?:datos pendientes|aun me faltan|todavia me faltan)\b/.test(normalized))) {
    targets.add('candidate_data');
  }

  if (mentionsVacancy && CONFIRMATION_PATTERN.test(normalized)) {
    targets.add('vacancy_confirmation');
  }

  if (!mentionsVacancy && CONFIRMATION_PATTERN.test(normalized) && /\b(?:datos?|informacion|todo|resumen)\b/.test(normalized)) {
    targets.add('candidate_confirmation');
  }

  if (FUTURE_PROFILE_PATTERN.test(normalized) && FUTURE_OPENING_PATTERN.test(normalized)) {
    targets.add('future_profile');
  }

  return [...targets];
}

export function composeUniqueReplySegment(baseText = '', segmentText = '', options = {}) {
  const base = String(baseText || '').trim();
  const segment = String(segmentText || '').trim();
  const separator = typeof options.separator === 'string' ? options.separator : ' ';

  if (!base) return { text: segment, appended: Boolean(segment), reason: segment ? 'base_empty' : 'both_empty', sharedTargets: [] };
  if (!segment) return { text: base, appended: false, reason: 'segment_empty', sharedTargets: [] };

  const normalizedBase = normalizeComparableReplyText(base);
  const normalizedSegment = normalizeComparableReplyText(segment);

  if (!normalizedSegment) return { text: base, appended: false, reason: 'segment_empty_after_normalization', sharedTargets: [] };
  if (normalizedBase === normalizedSegment || normalizedBase.includes(normalizedSegment)) {
    return { text: base, appended: false, reason: 'segment_already_present', sharedTargets: [] };
  }

  const baseTargets = detectReplyFollowUpTargets(base);
  const segmentTargets = detectReplyFollowUpTargets(segment);
  const sharedTargets = segmentTargets.filter((target) => baseTargets.includes(target));

  if (sharedTargets.length) {
    return { text: base, appended: false, reason: 'semantic_follow_up_already_present', sharedTargets };
  }

  return {
    text: `${base}${separator}${segment}`.trim(),
    appended: true,
    reason: 'segment_appended',
    sharedTargets: []
  };
}

export function appendUniqueReplySegment(baseText = '', segmentText = '', options = {}) {
  return composeUniqueReplySegment(baseText, segmentText, options).text;
}
