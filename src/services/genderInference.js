function normalize(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const DECLARED_FEMALE = [
  /\bsoy\s+(?:una\s+)?mujer\b/,
  /\b(?:sexo|genero)\s*(?:es|:)?\s*femenin[ao]\b/,
  /\bme\s+identifico\s+como\s+mujer\b/
];

const DECLARED_MALE = [
  /\bsoy\s+(?:un\s+)?hombre\b/,
  /\b(?:sexo|genero)\s*(?:es|:)?\s*masculin[ao]\b/,
  /\bme\s+identifico\s+como\s+hombre\b/
];

const LANGUAGE_FEMALE = [
  /\bestoy\s+(?:muy\s+)?(?:interesada|atenta|postulada|inscrita|registrada|dispuesta|apta|lista)\b/,
  /\bquedo\s+(?:muy\s+)?atenta\b/,
  /\bme\s+encuentro\s+(?:muy\s+)?interesada\b/
];

const LANGUAGE_MALE = [
  /\bestoy\s+(?:muy\s+)?(?:interesado|atento|postulado|inscrito|registrado|dispuesto|apto|listo)\b/,
  /\bquedo\s+(?:muy\s+)?atento\b/,
  /\bme\s+encuentro\s+(?:muy\s+)?interesado\b/
];

function firstName(fullName = '') {
  return normalize(fullName).split(' ').filter(Boolean)[0] || '';
}

function inferFromSpanishNameEnding(name = '') {
  const first = firstName(name);
  if (!first || first.length < 3) return null;

  if (/(a|ia|ina|ela|isa|ana|ora|eria|icia)$/.test(first) && !/(josua|elias|matias|tobias|jeremias)$/.test(first)) {
    return { gender: 'FEMALE', confidence: 0.62, source: 'name_pattern', evidence: first };
  }

  if (/(o|io|os|el|er|an|on|ar|or)$/.test(first) && !/(luz|cruz|mercedes)$/.test(first)) {
    return { gender: 'MALE', confidence: 0.58, source: 'name_pattern', evidence: first };
  }

  return null;
}

function matchAny(patterns = [], text = '') {
  return patterns.find((pattern) => pattern.test(text)) || null;
}

export function inferGenderEvidence({ fullName = '', text = '', currentGender = 'UNKNOWN' } = {}) {
  if (currentGender && currentGender !== 'UNKNOWN') {
    return { gender: currentGender, confidence: 1, source: 'existing', evidence: null, shouldPersist: false };
  }

  const normalizedText = normalize(text);
  const declaredFemale = matchAny(DECLARED_FEMALE, normalizedText);
  if (declaredFemale) return { gender: 'FEMALE', confidence: 0.98, source: 'declared', evidence: declaredFemale.source, shouldPersist: true };

  const declaredMale = matchAny(DECLARED_MALE, normalizedText);
  if (declaredMale) return { gender: 'MALE', confidence: 0.98, source: 'declared', evidence: declaredMale.source, shouldPersist: true };

  const languageFemale = matchAny(LANGUAGE_FEMALE, normalizedText);
  if (languageFemale) return { gender: 'FEMALE', confidence: 0.78, source: 'language_cue', evidence: languageFemale.source, shouldPersist: true };

  const languageMale = matchAny(LANGUAGE_MALE, normalizedText);
  if (languageMale) return { gender: 'MALE', confidence: 0.78, source: 'language_cue', evidence: languageMale.source, shouldPersist: true };

  const nameInference = inferFromSpanishNameEnding(fullName);
  if (nameInference) return { ...nameInference, shouldPersist: true };

  return { gender: 'UNKNOWN', confidence: 0, source: 'none', evidence: null, shouldPersist: false };
}
