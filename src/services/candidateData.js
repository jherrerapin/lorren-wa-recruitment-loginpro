import { isSuspiciousFullName } from './debugTrace.js';

const NAME_TOKEN_REGEX = /^[A-Za-zÁÉÍÓÚÑáéíóúñ'.-]{2,}$/;
const IMPLICIT_NEIGHBORHOODS = new Set([
  'picalena', 'picaleña', 'boqueron', 'boquerón', 'jordán', 'jordan', 'salado', 'gaitan', 'gaitan', 'combeima', 'modelia', 'centro', 'ciudadela', 'bolivar', 'simon'
]);

function capitalizeWords(str = '') {
  return String(str || '')
    .toLowerCase()
    .replace(/(^|\s)(\S)/g, (_m, space, char) => `${space}${char.toUpperCase()}`)
    .trim();
}

function normalizeDocumentType(value = '') {
  const normalized = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.\s]+/g, '');

  const map = {
    cc: 'CC',
    cedula: 'CC',
    ceduladeciudadania: 'CC',
    cedulaciudadania: 'CC',
    ccceduladeciudadania: 'CC',
    ti: 'TI',
    tarjetadeidentidad: 'TI',
    ce: 'CE',
    ceduladeextranjeria: 'CE',
    ppt: 'PPT',
    pasaporte: 'Pasaporte'
  };

  return map[normalized] || null;
}

function normalizeExperienceTime(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;

  const match = raw.match(/(\d+)\s*(mes(?:e|es)?|ano|anos|año|años|semana|semanas)/i);
  if (!match) return capitalizeWords(raw);

  const amount = Number.parseInt(match[1], 10);
  let unit = match[2].toLowerCase();

  if (unit.startsWith('mes')) {
    unit = amount === 1 ? 'mes' : 'meses';
  } else if (unit.startsWith('ano') || unit.startsWith('año')) {
    unit = amount === 1 ? 'año' : 'años';
  } else if (unit.startsWith('semana')) {
    unit = amount === 1 ? 'semana' : 'semanas';
  }

  return `${amount} ${unit}`;
}

function normalizeMedicalRestrictions(value = '') {
  const raw = String(value || '').trim();
  const normalized = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');

  if (!normalized) return null;
  if (/^(no tengo restricciones( medicas)?|sin restricciones( medicas)?|ninguna restriccion)$/.test(normalized)) {
    return 'Sin restricciones médicas';
  }

  return capitalizeWords(raw);
}

function normalizeTransportMode(value = '') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
  if (!normalized) return null;
  if (['sin medio de transporte', 'sin transporte', 'ninguno', 'ninguna', 'no tengo transporte', 'no tengo medio de transporte'].includes(normalized)) {
    return 'Sin medio de transporte';
  }
  if (['moto', 'motocicleta', 'motocicleta propia'].includes(normalized)) return 'Moto';
  if (['bicicleta', 'bici'].includes(normalized)) return 'Bicicleta';
  return capitalizeWords(normalized);
}

function hasNameTokens(candidate = '') {
  const parts = candidate.split(/\s+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return false;
  return parts.every((part) => NAME_TOKEN_REGEX.test(part));
}

function detectLeadingName(text = '') {
  const compact = String(text || '').trim();
  if (!compact) return null;

  const prefixed = compact.match(/(?:me\s+llamo|soy|mi\s+nombre\s+es|nombre\s*[:\-]?)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ][A-Za-zÁÉÍÓÚÑáéíóúñ'\-.\s]{3,60})/i);
  if (prefixed?.[1]) return capitalizeWords(prefixed[1]);

  const trailing = compact.match(/(?:nombre\s+(?:completo\s+)?(?:es|:)?|mi\s+nombre\s+es)\s*([A-Za-zÁÉÍÓÚÑáéíóúñ][A-Za-zÁÉÍÓÚÑáéíóúñ'\-.\s]{3,60})\s*$/i);
  if (trailing?.[1]) {
    const candidate = capitalizeWords(trailing[1]);
    if (!isSuspiciousFullName(candidate) && hasNameTokens(candidate)) return candidate;
  }

  const leading = compact.match(/^\s*([A-Za-zÁÉÍÓÚÑáéíóúñ][A-Za-zÁÉÍÓÚÑáéíóúñ'\-.]*(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ][A-Za-zÁÉÍÓÚÑáéíóúñ'\-.]*){1,3})(?=\s+(?:c\.?\s*c\.?|c[ée]dula|t\.?\s*i\.?|c\.?\s*e\.?|pasaporte|ppt|\d))/i);
  if (leading?.[1]) {
    const cleaned = leading[1].replace(/\b(cc|ti|ce|ppt|pasaporte)\b$/i, '').trim();
    if (!hasNameTokens(cleaned)) return null;
    const candidate = capitalizeWords(cleaned);
    if (!isSuspiciousFullName(candidate)) return candidate;
  }

  const firstChunk = compact.split(/[\n,]/)[0]?.trim() || '';
  if (hasNameTokens(firstChunk)) {
    const candidate = capitalizeWords(firstChunk);
    if (!isSuspiciousFullName(candidate)) return candidate;
  }

  return null;
}

export function parseNaturalData(text = '') {
  const result = {};
  let remaining = String(text || '');
  const compact = String(text || '')
    .replace(/\n/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();

  const docRegex = /\b(c\.?\s*c\.?|c[ée]dula(?:\s+(?:de\s+)?ciudadan[ií]a)?|t\.?\s*i\.?|tarjeta\s+de\s+identidad|c\.?\s*e\.?|c[ée]dula\s+de\s+extranjer[íi]a|pasaporte|ppt)\s*(?:es|:|\-|#|\.|\s)\s*(\d{6,12})\b/i;
  const docMatch = compact.match(docRegex) || remaining.match(docRegex);
  if (docMatch) {
    result.documentType = normalizeDocumentType(docMatch[1]) || docMatch[1].toUpperCase();
    result.documentNumber = docMatch[2];
    remaining = remaining.replace(docMatch[0], ' ');
  }

  if (!result.documentNumber) {
    const docNum = remaining.match(/(?:^|\s)(\d{7,12})(?:\s|$)/);
    if (docNum) {
      result.documentNumber = docNum[1];
      remaining = remaining.replace(docNum[1], ' ');
    }
  }

  const ageMatch = compact.match(/\b(?:edad\s*[:\-]?\s*|tengo\s+)?(\d{1,2})\s*(?:a[ñn]os?)?\b/i) || remaining.match(/\b(?:edad\s*[:\-]?\s*|tengo\s+)?(\d{1,2})\s*(?:a[ñn]os?)?\b/i);
  if (ageMatch) {
    const age = Number.parseInt(ageMatch[1], 10);
    if (age >= 14 && age <= 99) {
      result.age = age;
      remaining = remaining.replace(ageMatch[0], ' ');
    }
  }

  const barrioMatch = compact.match(/\b(?:barrio|zona|sector|localidad|vereda|ciudadela)\s*[:\-]?\s*([^,.\n]{2,60})/i) || remaining.match(/\b(?:barrio|zona|sector|localidad|vereda|ciudadela)\s*[:\-]?\s*([^,.\n]{2,60})/i);
  if (barrioMatch) {
    const cleanedNeighborhood = barrioMatch[1]
      .replace(/\b(y\s+tengo|tengo|con|y)\b.*$/i, '')
      .trim();
    const normalizedNeighborhood = capitalizeWords(cleanedNeighborhood);
    if (/^ciudadela/i.test(barrioMatch[0]) && !/^ciudadela\s+/i.test(normalizedNeighborhood)) {
      result.neighborhood = `Ciudadela ${normalizedNeighborhood}`.trim();
    } else {
      result.neighborhood = normalizedNeighborhood;
    }
    remaining = remaining.replace(barrioMatch[0], ' ');
  }

  if (!result.neighborhood) {
    const ciudadelaSimonBolivar = compact.match(/\bciudadela\s+simon\s+bolivar\b/i) || compact.match(/\bsimon\s+bolivar\b/i);
    if (ciudadelaSimonBolivar) {
      result.neighborhood = 'Ciudadela Simon Bolivar';
    }
  }

  if (!result.neighborhood) {
    const tokens = String(text || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9]+/)
      .filter(Boolean);

    const implicit = tokens.find((token) => IMPLICIT_NEIGHBORHOODS.has(token));
    if (implicit) result.neighborhood = capitalizeWords(implicit);
  }

  const negativeExperience = /\b(no\s+tengo\s+(mucha\s+)?experiencia|sin\s+experiencia|poca\s+experiencia)\b/i.test(compact);
  const positiveExperience = /\b(s[ií],?\s*tengo\s+experiencia|tengo\s+experiencia|cuento\s+con\s+experiencia|experiencia\s*[:\-]?\s*s[ií])\b/i.test(compact);
  if (negativeExperience) result.experienceInfo = 'No';
  else if (positiveExperience) result.experienceInfo = 'Sí';

  const experienceContextRegex = /\b(?:tengo|cuento\s+con|llevo|aproximadamente|casi)?\s*(\d+\s*(?:a[ñn]os?|mes(?:e|es)?|semana(?:s)?))\s*(?:de\s+)?experiencia\b/i;
  const positiveInlineRegex = /\b(?:s[ií]\s+tengo)\s*(\d+\s*(?:a[ñn]os?|mes(?:e|es)?|semana(?:s)?))\b/i;
  const expTime = compact.match(experienceContextRegex)
    || compact.match(positiveInlineRegex)
    || remaining.match(experienceContextRegex)
    || remaining.match(positiveInlineRegex);
  if (expTime) {
    result.experienceTime = expTime[1];
    result.experienceInfo = 'Sí';
  }

  const medicalNegative = /\b(no\s+tengo\s+restricciones?(\s+m[ée]dicas?)?|sin\s+restricciones?(\s+m[ée]dicas?)?|ninguna\s+restricci[oó]n)\b/i.test(compact)
    || /^(no|ninguna|ninguno)$/i.test(compact.trim());
  const medicalAffirmative = /\b(s[ií]\s+tengo\s+restricciones?\s+m[ée]dicas?|tengo\s+restricci[oó]n(?:\s+m[ée]dica)?|no\s+puedo\s+cargar|problema\s+de\s+columna|restricci[oó]n\s+en\s+la\s+espalda)\b/i.test(compact);
  const medicalMatch = compact.match(/(?:restricciones?\s+m[ée]dicas?\s*[:\-]?\s*)([^,.\n]{2,100})/i) || remaining.match(/(?:restricciones?\s+m[ée]dicas?\s*[:\-]?\s*)([^,.\n]{2,100})/i);
  if (medicalNegative) result.medicalRestrictions = 'Sin restricciones médicas';
  else if (medicalMatch) {
    const medicalValue = medicalMatch[1].trim();
    result.medicalRestrictions = /^no$/i.test(medicalValue) ? 'Sin restricciones médicas' : capitalizeWords(medicalValue);
  } else if (medicalAffirmative) {
    const snippet = remaining.match(/(tengo\s+[^,.\n]{5,80}|no\s+puedo\s+[^,.\n]{5,80}|problema\s+de\s+[^,.\n]{3,80})/i);
    result.medicalRestrictions = snippet ? capitalizeWords(snippet[1].trim()) : 'Sí, reporta restricciones médicas';
  }

  const transportNegative = compact.match(/\b(?:no\s+(?:tengo|cuento\s+con)\s+(?:medio\s+de\s+transporte|transporte|moto|bicicleta|bici)|sin\s+medio\s+de\s+transporte)\b/i);
  if (transportNegative) {
    result.transportMode = 'Sin medio de transporte';
  } else {
    const transportMatch = compact.match(/\b(?:transporte|movilidad|me\s+muevo\s+en)?\s*[:\-]?\s*(moto|motocicleta|bicicleta|bici|carro|bus|ninguno|ninguna)\b/i)
      || compact.match(/\b(motocicleta\s+propia)\b/i)
      || remaining.match(/\b(moto|motocicleta|bicicleta|bici|carro|bus|ninguno|ninguna)\b/i);
    if (transportMatch) result.transportMode = normalizeTransportMode(transportMatch[1]);
  }

  const detectedName = detectLeadingName(text);
  if (detectedName) result.fullName = detectedName;

  return result;
}

export function normalizeCandidateFields(fields = {}) {
  const normalized = {};

  if (fields.fullName) {
    normalized.fullName = capitalizeWords(fields.fullName);
  }
  if (fields.documentType) {
    normalized.documentType = normalizeDocumentType(fields.documentType) || String(fields.documentType).trim();
  }
  if (fields.documentNumber) {
    normalized.documentNumber = String(fields.documentNumber).replace(/\D/g, '');
  }
  if (fields.age !== undefined && fields.age !== null && fields.age !== '') {
    const age = Number.parseInt(String(fields.age), 10);
    if (Number.isFinite(age)) normalized.age = age;
  }
  if (fields.neighborhood) {
    normalized.neighborhood = capitalizeWords(fields.neighborhood);
  }
  if (fields.experienceInfo) {
    const info = String(fields.experienceInfo).toLowerCase();
    normalized.experienceInfo = /(si|sí|yes|tengo)/i.test(info) ? 'Sí' : 'No';
  }
  if (fields.experienceTime) {
    normalized.experienceTime = normalizeExperienceTime(fields.experienceTime);
  }
  if (normalized.experienceTime) {
    const amountMatch = normalized.experienceTime.match(/^(\d+)/);
    const amount = amountMatch ? Number.parseInt(amountMatch[1], 10) : null;
    if (Number.isFinite(amount) && amount > 0) {
      normalized.experienceInfo = 'Sí';
    }
  }
  if (normalized.experienceInfo === 'No' && !normalized.experienceTime) {
    normalized.experienceTime = '0';
  }
  if (normalized.experienceInfo === 'No') {
    normalized.experienceTime = normalized.experienceTime || '0';
  }
  if (fields.medicalRestrictions) {
    normalized.medicalRestrictions = normalizeMedicalRestrictions(fields.medicalRestrictions);
  }
  if (fields.transportMode) {
    normalized.transportMode = normalizeTransportMode(fields.transportMode);
  }

  return normalized;
}

export function isHighConfidenceLocalField(field, value) {
  const raw = String(value ?? '').trim();
  if (!raw) return false;
  if (field === 'fullName') return !isSuspiciousFullName(raw) && hasNameTokens(raw);
  if (field === 'neighborhood') return raw.length >= 3;
  if (field === 'medicalRestrictions') return /sin restricciones|no tengo restricciones|ninguna restriccion/i.test(raw) || raw.length >= 8;
  if (field === 'transportMode') return /^(moto|bicicleta|bici|sin medio de transporte)$/i.test(raw);
  return true;
}
