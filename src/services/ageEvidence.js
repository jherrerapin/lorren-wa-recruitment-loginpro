function normalizeText(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAge(value) {
  const age = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(age) && age >= 14 && age <= 80 ? age : null;
}

function valuePattern(value) {
  const age = normalizeAge(value);
  return age === null ? null : String(age);
}

function hasWorkContext(text = '') {
  return /\b(?:experien\w*|trabaj\w*|labor\w*|cargo|oficio|operacion\w*|logistic\w*|personal|turnos?|coordin\w*)\b/.test(normalizeText(text));
}

export function isWorkMetricNumber(value, text = '') {
  const number = valuePattern(value);
  if (!number) return false;
  const normalized = normalizeText(text);

  const metricAfter = new RegExp(
    `\\b${number}\\s+(?:trabajador(?:es)?|persona(?:s)?|emplead(?:o|a|os|as)|auxiliar(?:es)?|operari(?:o|a|os|as)|colaborador(?:es|as)?|integrante(?:s)?|grupo(?:s)?|equipo(?:s)?|turno(?:s)?)\\b`
  );
  const metricBefore = new RegExp(
    `\\b(?:grupo(?:s)?|equipo(?:s)?|personal|plantilla|cuadrilla(?:s)?)\\b[^.\\n,;]{0,28}\\b${number}\\b`
  );

  return metricAfter.test(normalized) || metricBefore.test(normalized);
}

export function isWorkDurationNumber(value, text = '') {
  const number = valuePattern(value);
  if (!number) return false;
  const normalized = normalizeText(text);

  const directAfter = new RegExp(
    `\\b${number}\\s+anos?\\s+(?:de\\s+)?(?:experiencia|trabajando|laborando|en\\s+el\\s+cargo|en\\s+el\\s+oficio)\\b`
  );
  const directBefore = new RegExp(
    `\\b(?:experiencia(?:\\s+de)?|trabajando|laborando|llevo|cuento\\s+con)\\s+(?:mas\\s+de\\s+)?${number}\\s+anos?\\b`
  );
  const approximateDuration = new RegExp(`\\b(?:mas\\s+de|aproximadamente|cerca\\s+de)\\s+${number}\\s+anos?\\b`);

  return directAfter.test(normalized)
    || directBefore.test(normalized)
    || (hasWorkContext(normalized) && approximateDuration.test(normalized));
}

function hasAddressBinding(value, text = '') {
  const number = valuePattern(value);
  if (!number) return false;
  return new RegExp(
    `\\b(?:calle|cl|carrera|cra|kr|avenida|av|km|kilometro|diagonal|transversal|tv)\\s+${number}\\b`
  ).test(normalizeText(text));
}

function hasExplicitAgeBinding(value, text = '') {
  const number = valuePattern(value);
  if (!number) return false;
  const normalized = normalizeText(text);
  if (!normalized) return false;

  const patterns = [
    new RegExp(`\\bmi\\s+edad\\s+(?:es\\s+)?${number}\\b`),
    new RegExp(`\\bedad\\s+(?:es\\s+)?${number}\\b`),
    new RegExp(`\\btengo\\s+${number}\\s+anos?\\b`),
    new RegExp(`\\bsoy\\s+de\\s+${number}\\s+anos?\\b`),
    new RegExp(`\\b${number}\\s+anos?\\s+de\\s+edad\\b`)
  ];

  if (patterns.some((pattern) => pattern.test(normalized))) {
    return !isWorkDurationNumber(number, normalized) && !isWorkMetricNumber(number, normalized);
  }

  const startsWithAge = new RegExp(`^${number}\\s+anos?\\b`).test(normalized);
  if (startsWithAge) {
    const directWorkSuffix = new RegExp(`^${number}\\s+anos?\\s+(?:de\\s+experiencia|trabajando|laborando)\\b`).test(normalized);
    return !directWorkSuffix && !isWorkMetricNumber(number, normalized);
  }

  return normalized === number;
}

function hasStandaloneNumber(value, text = '') {
  const number = valuePattern(value);
  if (!number) return false;
  const normalized = normalizeText(text);
  if (!new RegExp(`\\b${number}\\b`).test(normalized)) return false;
  if (hasAddressBinding(number, normalized)) return false;
  if (isWorkDurationNumber(number, normalized) || isWorkMetricNumber(number, normalized)) return false;
  return true;
}

export function classifyAgeEvidence(value, text = '', options = {}) {
  const age = normalizeAge(value);
  if (age === null) return { valid: false, reason: 'invalid_age_range' };
  if (hasAddressBinding(age, text)) return { valid: false, reason: 'address_number_not_age' };
  if (isWorkMetricNumber(age, text)) return { valid: false, reason: 'work_metric_not_age' };
  if (isWorkDurationNumber(age, text)) return { valid: false, reason: 'experience_number_not_age' };
  if (hasExplicitAgeBinding(age, text)) return { valid: true, reason: 'explicit_age_evidence' };
  if (options.allowStandalone && hasStandaloneNumber(age, text)) {
    return { valid: true, reason: 'requested_age_value' };
  }
  return { valid: false, reason: 'missing_age_evidence' };
}

export function extractExplicitAge(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const patterns = [
    /\bmi\s+edad\s+(?:es\s+)?(\d{1,2})\b/,
    /\bedad\s+(?:es\s+)?(\d{1,2})\b/,
    /\btengo\s+(\d{1,2})\s+anos?\b/,
    /\bsoy\s+de\s+(\d{1,2})\s+anos?\b/,
    /\b(\d{1,2})\s+anos?\s+de\s+edad\b/,
    /^(\d{1,2})\s+anos?\b/,
    /^(\d{1,2})$/
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match?.[1]) continue;
    const age = normalizeAge(match[1]);
    if (age === null) continue;
    const evidence = classifyAgeEvidence(age, normalized, { allowStandalone: true });
    if (evidence.valid) return age;
  }

  return null;
}
