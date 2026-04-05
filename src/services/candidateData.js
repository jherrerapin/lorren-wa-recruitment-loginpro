/**
 * candidateData.js
 * ──────────────────────────────────────────────────────────────────────
 *
 * Responsabilidad de este módulo:
 *   - Normalizar los valores que ya vienen extraídos (capitalizar, limpiar).
 *   - Proveer un parser local LIGERO que sirve SOLO como primer pase rápido
 *     para campos de alta certeza (número de documento, barrio con prefijo
 *     explícito, transporte, restricciones médicas negativas).
 *   - La FUENTE DE VERDAD para campos ambiguos (edad, nombre, experiencia,
 *     tiempo de experiencia) es OpenAI — NO este parser.
 *
 * Por qué no usamos regex rígido para edad:
 *   Los candidatos escriben de mil formas: "tengo 28", "28 años", "veintiocho",
 *   "28 añitos", "28" (sin contexto), "28 años de edad", con tildes o sin ellas,
 *   con errores de tipeo ("annos", "añoz"). Un regex jamás cubrirá todo eso
 *   sin generar falsos positivos. OpenAI entiende el contexto completo del
 *   mensaje y distingue, por ejemplo, un número de cédula de una edad.
 */

import { isSuspiciousFullName } from './debugTrace.js';

const NAME_TOKEN_REGEX = /^[A-Za-zÁÉÍÓÚÑáéíóúñ'.-]{2,}$/;
const IMPLICIT_NEIGHBORHOODS = new Set([
  'picalena', 'picaleña', 'boqueron', 'boquerón', 'jordán', 'jordan',
  'salado', 'gaitan', 'combeima', 'modelia', 'centro', 'ciudadela',
  'bolivar', 'simon'
]);

// ─────────────────────────────────────────────
// Helpers de normalización
// ─────────────────────────────────────────────

function normalizeLooseText(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

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
    cc: 'CC', cedula: 'CC', ceduladeciudadania: 'CC',
    cedulaciudadania: 'CC', ccceduladeciudadania: 'CC',
    ti: 'TI', tarjetadeidentidad: 'TI',
    ce: 'CE', ceduladeextranjeria: 'CE',
    ppt: 'PPT', pasaporte: 'Pasaporte'
  };
  return map[normalized] || null;
}

function normalizeExperienceTime(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;

  // Palabras en español a número
  const wordToNum = {
    un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
    seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11,
    doce: 12, trece: 13, catorce: 14, quince: 15
  };

  let normalized = raw;
  for (const [word, num] of Object.entries(wordToNum)) {
    normalized = normalized.replace(new RegExp(`\\b${word}\\b`, 'i'), String(num));
  }

  const match = normalized.match(/(\d+)\s*(mes(?:e|es)?|a[nñ]os?|semanas?)/i);
  if (!match) return capitalizeWords(raw);

  const amount = Number.parseInt(match[1], 10);
  let unit = match[2].toLowerCase();
  if (unit.startsWith('mes')) unit = amount === 1 ? 'mes' : 'meses';
  else if (unit.match(/^a[nñ]/)) unit = amount === 1 ? 'año' : 'años';
  else if (unit.startsWith('semana')) unit = amount === 1 ? 'semana' : 'semanas';

  return `${amount} ${unit}`;
}

function normalizeMedicalRestrictions(value = '') {
  const raw = String(value || '').trim();
  const n = normalizeLooseText(raw);
  if (!n) return null;
  if (/^(no tengo restricciones?( medicas?)?|no cuento con restricciones?( medicas?)?|sin restricciones?( medicas?)?|sin ninguna restriccion|ninguna restriccion)$/.test(n)) {
    return 'Sin restricciones médicas';
  }
  return capitalizeWords(raw);
}

function normalizeTransportMode(value = '') {
  const n = normalizeLooseText(value);
  if (!n) return null;
  if (['sin medio de transporte', 'sin transporte', 'ninguno', 'ninguna',
    'no tengo transporte', 'no tengo medio de transporte'].includes(n)) {
    return 'Sin medio de transporte';
  }
  if (/\b(tengo|cuento con|si tengo|manejo|me movilizo en|voy en)\s+(moto|motocicleta)\b/.test(n)) return 'Moto';
  if (/\b(tengo|cuento con|si tengo|manejo|me movilizo en|voy en)\s+(bicicleta|bici)\b/.test(n)) return 'Bicicleta';
  if (['moto', 'motocicleta', 'motocicleta propia'].includes(n)) return 'Moto';
  if (['bicicleta', 'bici'].includes(n)) return 'Bicicleta';
  return capitalizeWords(n);
}

function normalizeExperienceInfo(value = '') {
  const n = normalizeLooseText(value);
  if (!n) return null;
  if ((/\b(no|sin|ninguna|ninguno|nunca)\b/.test(n) && /experien/.test(n)) || n === 'no') return 'No';
  if ((/\b(si|yes|tengo|cuento con|poseo)\b/.test(n) && /experien/.test(n)) || n === 'si' || n === 'sí') return 'Sí';
  return null;
}

function detectDocumentTypeHint(text = '') {
  const patterns = [
    /\b(?:tipo(?:\s+de)?\s+documento|documento|identificacion|identificaci[oó]n)\s*(?:es|:|-)?\s*(c\.?\s*c\.?|c[ée]dula(?:\s+(?:de\s+)?ciudadan[ií]a)?|t\.?\s*i\.?|tarjeta\s+de\s+identidad|c\.?\s*e\.?|c[ée]dula\s+de\s+extranjer[ií]a|pasaporte|ppt)\b/i,
    /\b(c[ée]dula\s+de\s+extranjer[ií]a|tarjeta\s+de\s+identidad|pasaporte|ppt)\b/i
  ];
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match?.[1]) return normalizeDocumentType(match[1]);
  }
  return null;
}

function detectExperienceTime(text = '') {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  const match = compact.match(/\b((?:un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|\d+)\s*(?:mes(?:e|es)?|a[nñ]os?|semanas?))(?:\s+de\s+experiencia)?\b/i);
  if (!match?.[1]) return null;
  return normalizeExperienceTime(match[1]);
}

function hasNameTokens(candidate = '') {
  const parts = candidate.split(/\s+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return false;
  return parts.every((part) => NAME_TOKEN_REGEX.test(part));
}

function detectLeadingName(text = '') {
  const compact = String(text || '').trim();
  if (!compact) return null;

  const prefixed = compact.match(
    /(?:me\s+llamo|soy|mi\s+nombre\s+es|nombre\s*[:\-]?)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ][A-Za-zÁÉÍÓÚÑáéíóúñ'\-.\s]{3,60})/i
  );
  if (prefixed?.[1]) return capitalizeWords(prefixed[1]);

  const leading = compact.match(
    /^\s*([A-Za-zÁÉÍÓÚÑáéíóúñ][A-Za-zÁÉÍÓÚÑáéíóúñ'\-.]*(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ][A-Za-zÁÉÍÓÚÑáéíóúñ'\-.]*){1,3})(?=\s+(?:c\.?\s*c\.?|c[ée]dula|t\.?\s*i\.?|c\.?\s*e\.?|pasaporte|ppt|\d))/i
  );
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

// ─────────────────────────────────────────────
// Parser local LIGERO — solo campos de alta certeza
// La edad, el nombre completo y la experiencia NO se extraen aquí.
// OpenAI es la fuente de verdad para esos campos.
// ─────────────────────────────────────────────

export function parseNaturalData(text = '') {
  const result = {};
  const compact = String(text || '').replace(/\n/g, ', ').replace(/\s+/g, ' ').trim();
  let remaining = String(text || '');

  // — Documento: alta certeza cuando hay prefijo explícito o número largo
  const docRegex = /\b(c\.?\s*c\.?|c[ée]dula(?:\s+(?:de\s+)?ciudadan[ií]a)?|t\.?\s*i\.?|tarjeta\s+de\s+identidad|c\.?\s*e\.?|c[ée]dula\s+de\s+extranjer[íi]a|pasaporte|ppt)\s*(?:es|:|\-|#|\.|\s)\s*(\d{6,12})\b/i;
  const docMatch = compact.match(docRegex) || remaining.match(docRegex);
  if (docMatch) {
    result.documentType = normalizeDocumentType(docMatch[1]) || docMatch[1].toUpperCase();
    result.documentNumber = docMatch[2];
    remaining = remaining.replace(docMatch[0], ' ');
  }
  if (!result.documentType) {
    result.documentType = detectDocumentTypeHint(compact);
  }
  if (!result.documentNumber) {
    const docNum = remaining.match(/(?:^|\s)(\d{7,12})(?:\s|$)/);
    if (docNum) {
      result.documentNumber = docNum[1];
      remaining = remaining.replace(docNum[1], ' ');
    }
  }

  // — EDAD: delegada completamente a OpenAI. No se extrae aquí.
  // OpenAI distingue edad de cédula, entiende "veintiocho", "28 añitos",
  // errores de tipeo, contexto conversacional completo.

  // — Barrio: alta certeza cuando hay prefijo explícito
  const barrioMatch = compact.match(
    /\b(?:barrio|zona|sector|localidad|vereda|ciudadela)\s*[:\-]?\s*([^,.\n]{2,60})/i
  ) || remaining.match(
    /\b(?:barrio|zona|sector|localidad|vereda|ciudadela)\s*[:\-]?\s*([^,.\n]{2,60})/i
  );
  if (barrioMatch) {
    const cleaned = barrioMatch[1].replace(/\b(y\s+tengo|tengo|con|y)\b.*$/i, '').trim();
    const normalized = capitalizeWords(cleaned);
    result.neighborhood = /^ciudadela/i.test(barrioMatch[0]) && !/^ciudadela\s+/i.test(normalized)
      ? `Ciudadela ${normalized}`.trim()
      : normalized;
    remaining = remaining.replace(barrioMatch[0], ' ');
  }

  if (!result.neighborhood) {
    const ciudadelaSimon = compact.match(/\bciudadela\s+simon\s+bolivar\b/i) || compact.match(/\bsimon\s+bolivar\b/i);
    if (ciudadelaSimon) result.neighborhood = 'Ciudadela Simon Bolivar';
  }

  if (!result.neighborhood) {
    const tokens = String(text || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
    const implicit = tokens.find((t) => IMPLICIT_NEIGHBORHOODS.has(t));
    if (implicit) result.neighborhood = capitalizeWords(implicit);
  }

  // — Restricciones médicas negativas: alta certeza (patrón muy específico)
  const medicalNegative = /\b(no\s+tengo\s+restricciones?(\s+m[ée]dicas?)?|sin\s+restricciones?(\s+m[ée]dicas?)?|ninguna\s+restricci[oó]n)\b/i.test(compact);
  if (medicalNegative) result.medicalRestrictions = 'Sin restricciones médicas';

  // — Transporte negativo: alta certeza
  const transportNegative = compact.match(
    /\b(?:no\s+(?:tengo|cuento\s+con)\s+(?:medio\s+de\s+transporte|transporte|moto|bicicleta|bici)|sin\s+medio\s+de\s+transporte)\b/i
  );
  if (transportNegative) result.transportMode = 'Sin medio de transporte';

  if (!result.transportMode) {
    const transportPositive = compact.match(/\b(?:tengo|cuento con|si tengo|manejo|me movilizo en|voy en)\s+(moto|motocicleta|bicicleta|bici)\b/i);
    if (transportPositive?.[1]) result.transportMode = normalizeTransportMode(transportPositive[1]);
  }

  const experienceNegative = /\b(?:no\s+tengo|no\s+cuento\s+con|sin|ninguna)\s+experiencia\b/i.test(compact)
    || /\bnunca\s+he\s+trabajado\b/i.test(compact);
  if (experienceNegative) {
    result.experienceInfo = 'No';
    result.experienceTime = '0';
  }

  if (!result.experienceInfo) {
    const experiencePositive = /\b(?:tengo|cuento con|si tengo|poseo)\s+experiencia\b/i.test(compact);
    if (experiencePositive) result.experienceInfo = 'Sí';
  }

  if (!result.experienceTime) {
    const detectedExperienceTime = detectExperienceTime(compact);
    if (detectedExperienceTime) {
      result.experienceTime = detectedExperienceTime;
      result.experienceInfo = 'Sí';
    }
  }

  // — Nombre: solo intento local si hay prefijo muy explícito. Lo demás lo resuelve OpenAI.
  const detectedName = detectLeadingName(text);
  if (detectedName) result.fullName = detectedName;

  return result;
}

export function normalizeCandidateFields(fields = {}) {
  const normalized = {};

  if (fields.fullName) normalized.fullName = capitalizeWords(fields.fullName);
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
  if (fields.neighborhood) normalized.neighborhood = capitalizeWords(fields.neighborhood);
  if (fields.experienceInfo) {
    normalized.experienceInfo = normalizeExperienceInfo(fields.experienceInfo) || (/(si|sí|yes|tengo)/i.test(String(fields.experienceInfo)) ? 'Sí' : 'No');
  }
  if (fields.experienceTime) {
    normalized.experienceTime = normalizeExperienceTime(fields.experienceTime);
  }
  if (normalized.experienceTime) {
    const m = normalized.experienceTime.match(/^(\d+)/);
    if (m && Number.parseInt(m[1], 10) > 0) normalized.experienceInfo = 'Sí';
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
  // La edad NUNCA se marca como alta certeza local — siempre gana OpenAI
  if (field === 'age') return false;
  if (field === 'fullName') return !isSuspiciousFullName(raw) && hasNameTokens(raw);
  if (field === 'neighborhood') return raw.length >= 3;
  if (field === 'experienceInfo') return /^(si|sí|no)$/i.test(raw) || /experien/i.test(raw);
  if (field === 'medicalRestrictions') {
    return /sin restricciones|no tengo restricciones|ninguna restriccion/i.test(raw) || raw.length >= 8;
  }
  if (field === 'transportMode') return /^(moto|bicicleta|bici|sin medio de transporte)$/i.test(raw);
  return true;
}
