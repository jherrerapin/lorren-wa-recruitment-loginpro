/**
 * fieldSanitizer.js
 * ──────────────────────────────────────────────────────────────────────
 *
 * Compuerta semántica posterior a la IA.
 *
 * Objetivo:
 * - La IA puede proponer entidades, pero este módulo decide si esas entidades
 *   tienen evidencia suficiente para entrar al estado curado del candidato.
 * - No funciona con listas quemadas de saludos. Funciona con contexto,
 *   tipo de turno, campo pendiente, evidencia, confianza y estructura del dato.
 */

import { hasAmbiguousGenderEvidence, hasStrongGenderEvidence } from './genderEvidencePolicy.js';
import { classifyAgeEvidence } from './ageEvidence.js';

const DEFAULT_MIN_CONFIDENCE = 0.72;
const CORE_IDENTITY_FIELDS = new Set(['fullName', 'documentType', 'documentNumber', 'age']);
const RESIDENCE_FIELDS = new Set(['locality', 'neighborhood']);
const ALL_SANITIZED_FIELDS = [
  'fullName',
  'age',
  'documentType',
  'documentNumber',
  'gender',
  'locality',
  'neighborhood',
  'transportMode',
  'medicalRestrictions',
  'experienceInfo',
  'experienceTime'
];

function minFieldConfidence() {
  const parsed = Number(process.env.OPENAI_MIN_FIELD_CONFIDENCE || DEFAULT_MIN_CONFIDENCE);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return DEFAULT_MIN_CONFIDENCE;
  return parsed;
}

function normalizeText(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== '';
}

function compactObject(value = {}) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, fieldValue]) => hasValue(fieldValue))
  );
}

function readPendingFields(context = {}) {
  const direct = Array.isArray(context.pendingFields) ? context.pendingFields : [];
  const nested = Array.isArray(context.conversationContext?.pendingFields)
    ? context.conversationContext.pendingFields
    : [];
  return [...direct, ...nested].map((field) => String(field || '').trim()).filter(Boolean);
}

function readCurrentStep(context = {}) {
  return String(
    context.currentStep
    || context.conversationContext?.currentStep
    || context.candidateKnownData?.currentStep
    || context.candidate?.currentStep
    || ''
  ).toUpperCase();
}

function readLastBotQuestion(context = {}) {
  return String(
    context.lastBotQuestion
    || context.conversationContext?.lastBotQuestion
    || ''
  );
}

function fieldWasPending(field, context = {}) {
  const pending = readPendingFields(context).map(normalizeText);
  if (pending.includes(normalizeText(field))) return true;

  if (field === 'fullName') {
    return pending.some((item) => /\bnombre\b/.test(item));
  }

  if (field === 'neighborhood' || field === 'locality') {
    return pending.some((item) => /\b(barrio|localidad|residencia|zona|sector|municipio)\b/.test(item));
  }

  if (field === 'gender') {
    return pending.some((item) => /\b(genero|sexo|mujer|hombre)\b/.test(item));
  }

  return false;
}

function lastQuestionAskedForField(field, context = {}) {
  const question = normalizeText(readLastBotQuestion(context));
  if (!question) return false;

  const fieldPatterns = {
    fullName: /\b(nombre|nombres|apellido|apellidos|llamas)\b/,
    age: /\b(edad|anos)\b/,
    documentType: /\b(tipo de documento|documento|cedula|cc|ppt)\b/,
    documentNumber: /\b(numero de documento|documento|cedula|cc|ppt)\b/,
    gender: /\b(genero|sexo|mujer|hombre)\b/,
    locality: /\b(localidad|barrio|zona|sector|residencia|vives|vivo)\b/,
    neighborhood: /\b(barrio|localidad|zona|sector|residencia|vives|vivo)\b/,
    transportMode: /\b(transporte|moto|bicicleta|bici|carro|bus)\b/,
    medicalRestrictions: /\b(restriccion|restricciones|medica|salud)\b/,
    experienceInfo: /\b(experiencia|trabajado|laborado)\b/,
    experienceTime: /\b(experiencia|tiempo|meses|anos)\b/
  };

  return fieldPatterns[field]?.test(question) || false;
}

function currentStepCollectsCandidateData(context = {}) {
  const step = readCurrentStep(context);
  return /COLLECT|CONFIRM|GREETING_SENT|ASK_DATA|DATA|REGISTRO/.test(step);
}

function looksLikeNonDataText(value = '') {
  const normalized = normalizeText(value);
  if (!normalized) return true;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;

  const conversationalTokens = new Set([
    'hola', 'buenas', 'buenos', 'dias', 'tardes', 'noches', 'gracias',
    'ok', 'okay', 'vale', 'listo', 'claro', 'si', 'sii', 'sip', 'no',
    'bueno', 'buena', 'perfecto', 'correcto', 'correcta', 'dale'
  ]);
  const onlyConversational = tokens.every((token) => conversationalTokens.has(token));
  if (onlyConversational) return true;

  if (/^(?:a\s*)?(?:ok|okay|vale|listo|claro|gracias|perfecto|bueno|correcto)(?:\s+(?:gracias|claro|listo|si|no))?$/.test(normalized)) return true;
  if (/^(?:si|sii|sip|no)(?:\s+(?:senora|senor|claro|gracias|por favor|listo))?$/.test(normalized)) return true;
  return false;
}

function isStringCandidateValue(value) {
  return typeof value === 'string' || value instanceof String;
}

function getEvidence(field, evidence = {}) {
  const item = evidence?.[field] || {};
  const confidence = Number(item.confidence);
  return {
    snippet: typeof item.snippet === 'string' ? item.snippet.trim() : null,
    confidence: Number.isFinite(confidence) ? confidence : null,
    source: typeof item.source === 'string' ? item.source.trim() : null
  };
}

function evidenceSourceLooksInferential(field, evidence = {}) {
  const source = normalizeText(getEvidence(field, evidence).source || '');
  if (!source) return false;
  if (/\b(name|nombre)\b/.test(source) && /\b(infer|guess|deduc|heuristic)\b/.test(source)) return true;
  if (/\b(infer|guess|deduc)\b/.test(source) && field === 'gender') return true;
  return ['name_inference', 'inferred_from_name', 'gender_from_name'].includes(source.replace(/\s+/g, '_'));
}

function evidenceSnippetIsGrounded(field, evidence = {}, text = '') {
  const item = getEvidence(field, evidence);
  if (!item.snippet) return false;
  const normalizedText = normalizeText(text);
  const normalizedSnippet = normalizeText(item.snippet);
  if (!normalizedText || !normalizedSnippet) return false;
  return normalizedText.includes(normalizedSnippet);
}

function evidenceIsUsable(field, evidence = {}, options = {}) {
  const item = getEvidence(field, evidence);
  const source = normalizeText(item.source || '');

  if (source === 'fallback') return false;

  if (options.allowLocalParser && source === 'local parser') return true;
  if (options.allowLocalParser && source === 'local_parser') return true;

  if (!item.snippet) return false;

  const confidence = item.confidence ?? 0;
  return confidence >= minFieldConfidence();
}

function turnLooksLikeOnlyConversation(turnType = '') {
  const normalizedTurn = String(turnType || '').toUpperCase();
  return ['GREETING', 'CONFIRMATION', 'OBJECTION', 'OTHER'].includes(normalizedTurn);
}

function hasDocumentEvidence(text = '') {
  const normalized = normalizeText(text);
  return /\b(cc|cedula|cedula de ciudadania|ppt|documento)\b/.test(normalized)
    || /\b\d{5,12}\b/.test(normalized);
}

function hasAgeEvidence(text = '') {
  const normalized = normalizeText(text);
  return /\b(edad|tengo|anos|ano)\b/.test(normalized) && /\b\d{1,2}\b/.test(normalized);
}

function hasExperienceEvidence(text = '') {
  return /\b(experien|trabaj|labor|cargo|oficio)\b/.test(normalizeText(text));
}

function hasNameEvidenceCue(text = '') {
  const normalized = normalizeText(text);
  return /\b(mi nombre es|nombre completo|me llamo|soy)\b/.test(normalized);
}

function hasResidenceEvidenceCue(text = '') {
  const normalized = normalizeText(text);
  return /\b(vivo|resido|residencia|barrio|localidad|comuna|zona|sector|municipio|vereda|ciudadela|me encuentro en|estoy en|desde)\b/.test(normalized);
}

function hasGenderEvidenceCue(value, text = '') {
  return hasStrongGenderEvidence(value, text);
}

function hasOnlyCourtesyTreatmentAsGenderCue(text = '') {
  return hasAmbiguousGenderEvidence(text);
}

function looksLikePersonalName(value = '') {
  const raw = String(value || '').trim();
  if (!raw || raw.length < 5 || raw.length > 80) return false;
  if (/\d/.test(raw)) return false;

  const normalized = normalizeText(raw);
  if (/\b(auxiliar|vacante|cargo|bodega|cargue|descargue|logistica|operacion|requisitos|documento|cedula|ppt|barrio|localidad|municipio|ciudad|transporte|moto|bicicleta|experiencia|informacion|info|interes|interesado|interesada|postulacion|trabajo|requisito|favor|gracias)\b/.test(normalized)) {
    return false;
  }

  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 5) return false;

  const semanticNonNameTokens = new Set(['si', 'sii', 'sip', 'ok', 'okay', 'vale', 'listo', 'claro', 'para', 'por', 'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'o', 'que', 'quedo', 'atento', 'atenta', 'buenas', 'buenos', 'dias', 'tardes', 'noches', 'hola', 'cordial', 'saludo']);
  const normalizedTokens = normalized.split(/\s+/).filter(Boolean);
  const semanticTokenCount = normalizedTokens.filter((token) => semanticNonNameTokens.has(token)).length;
  if (semanticNonNameTokens.has(normalizedTokens[0]) || semanticTokenCount === normalizedTokens.length) return false;

  return tokens.every((token) => /^[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}$/.test(token));
}

function looksLikeResidenceValue(value = '') {
  const raw = String(value || '').trim();
  if (!raw || raw.length < 3 || raw.length > 60) return false;
  if (/\d{3,}/.test(raw)) return false;

  const normalized = normalizeText(raw);
  if (/\b(cc|cedula|documento|ppt|edad|anos|experiencia|restriccion|transporte|moto|bicicleta|carro|bus|nombre|vacante|cargo|auxiliar|cargue|descargue|bodega|logistica|interesado|interesada|requisitos|perfil)\b/.test(normalized)) {
    return false;
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 5) return false;
  return words.every((word) => /^[a-zñ]{2,}$/.test(word));
}

function sanitizeFullName(value, evidence, text, context, turnType) {
  if (!looksLikePersonalName(value)) return { ok: false, reason: 'invalid_name_shape' };

  const fieldContext = fieldWasPending('fullName', context) || lastQuestionAskedForField('fullName', context);
  const identityCue = hasNameEvidenceCue(text);
  const groupedIdentityEvidence = hasDocumentEvidence(text) || hasAgeEvidence(text);
  const usableEvidence = evidenceIsUsable('fullName', evidence, { allowLocalParser: true });

  if (getEvidence('fullName', evidence).snippet && !evidenceSnippetIsGrounded('fullName', evidence, text)) {
    return { ok: false, reason: 'name_evidence_not_grounded_in_candidate_text' };
  }

  if (turnLooksLikeOnlyConversation(turnType) && !fieldContext && !identityCue && !groupedIdentityEvidence) {
    return { ok: false, reason: 'conversational_turn_without_identity_evidence' };
  }

  if (!usableEvidence && !fieldContext && !identityCue && !groupedIdentityEvidence) {
    return { ok: false, reason: 'missing_name_evidence' };
  }

  if (!fieldContext && !identityCue && !groupedIdentityEvidence && !currentStepCollectsCandidateData(context)) {
    return { ok: false, reason: 'outside_data_collection_context' };
  }

  return { ok: true };
}

function sanitizeResidence(field, value, evidence, text, context, turnType) {
  if (!looksLikeResidenceValue(value)) return { ok: false, reason: 'invalid_residence_shape' };

  const fieldContext = fieldWasPending(field, context) || lastQuestionAskedForField(field, context);
  const residenceCue = hasResidenceEvidenceCue(text);
  const usableEvidence = evidenceIsUsable(field, evidence, { allowLocalParser: true });

  if (getEvidence(field, evidence).snippet && !evidenceSnippetIsGrounded(field, evidence, text)) {
    return { ok: false, reason: 'residence_evidence_not_grounded_in_candidate_text' };
  }

  if (turnLooksLikeOnlyConversation(turnType) && !fieldContext && !residenceCue) {
    return { ok: false, reason: 'conversational_turn_without_residence_evidence' };
  }

  if (!usableEvidence && !fieldContext && !residenceCue) {
    return { ok: false, reason: 'missing_residence_evidence' };
  }

  if (!fieldContext && !residenceCue && !currentStepCollectsCandidateData(context)) {
    return { ok: false, reason: 'outside_residence_collection_context' };
  }

  return { ok: true };
}

function sanitizeGender(value, evidence, text, context, turnType) {
  if (!['MALE', 'FEMALE', 'OTHER', 'UNKNOWN'].includes(String(value || ''))) {
    return { ok: false, reason: 'invalid_gender_value' };
  }

  if (value === 'UNKNOWN') return { ok: false, reason: 'unknown_gender_is_not_persisted' };

  const fieldContext = fieldWasPending('gender', context) || lastQuestionAskedForField('gender', context);
  if (hasOnlyCourtesyTreatmentAsGenderCue(text)) {
    return { ok: false, reason: 'courtesy_treatment_is_not_candidate_gender' };
  }
  const genderCue = hasGenderEvidenceCue(value, text);
  const usableEvidence = evidenceIsUsable('gender', evidence, { allowLocalParser: true });

  if (evidenceSourceLooksInferential('gender', evidence)) {
    return { ok: false, reason: 'gender_inferred_from_name' };
  }

  if (getEvidence('gender', evidence).snippet && !evidenceSnippetIsGrounded('gender', evidence, text)) {
    return { ok: false, reason: 'gender_evidence_not_grounded_in_candidate_text' };
  }

  if (!genderCue && !fieldContext) {
    return { ok: false, reason: 'gender_without_explicit_linguistic_evidence' };
  }

  if (turnLooksLikeOnlyConversation(turnType) && !genderCue && !fieldContext) {
    return { ok: false, reason: 'conversational_turn_without_gender_evidence' };
  }

  if (!usableEvidence && !genderCue && !fieldContext) {
    return { ok: false, reason: 'missing_gender_evidence' };
  }

  if (!genderCue && !usableEvidence) {
    return { ok: false, reason: 'gender_without_textual_evidence' };
  }

  return { ok: true };
}

function sanitizeDocumentNumber(value) {
  const normalized = String(value || '').replace(/[^A-Za-z0-9]/g, '').trim();
  if (/^\d{5,12}$/.test(normalized)) return { ok: true, value: normalized };
  if (/^[A-Za-z0-9]{5,15}$/.test(normalized)) return { ok: true, value: normalized.toUpperCase() };
  return { ok: false, reason: 'invalid_document_number_shape' };
}

function sanitizeDocumentType(value) {
  const normalized = normalizeText(value);
  const allowed = new Set(['cc', 'cedula', 'cedula de ciudadania', 'ppt']);
  if (!allowed.has(normalized)) return { ok: false, reason: 'unsupported_document_type' };
  return { ok: true };
}

function sanitizeAge(value, text, context = {}) {
  if (!/^\d+$/.test(String(value || '').trim())) return { ok: false, reason: 'invalid_numeric_value' };
  const age = Number(value);
  if (!Number.isInteger(age) || age < 14 || age > 80) return { ok: false, reason: 'invalid_age_range' };

  const allowStandalone = fieldWasPending('age', context) || lastQuestionAskedForField('age', context);
  const evidence = classifyAgeEvidence(age, text, { allowStandalone });
  if (!evidence.valid) return { ok: false, reason: evidence.reason };
  return { ok: true, value: age };
}

function evaluateField(field, value, evidence, text, context, turnType) {
  if (!hasValue(value)) return { ok: false, reason: 'empty' };
  if (isStringCandidateValue(value) && looksLikeNonDataText(value)) return { ok: false, reason: 'non_data_text' };

  if (field === 'fullName') return sanitizeFullName(value, evidence, text, context, turnType);
  if (RESIDENCE_FIELDS.has(field)) return sanitizeResidence(field, value, evidence, text, context, turnType);
  if (field === 'gender') return sanitizeGender(value, evidence, text, context, turnType);
  if (field === 'documentNumber') return sanitizeDocumentNumber(value);
  if (field === 'documentType') return sanitizeDocumentType(value);
  if (field === 'age') return sanitizeAge(value, text, context);

  return { ok: true };
}

export function sanitizeCandidateFieldsForConversation({
  fields = {},
  evidence = {},
  text = '',
  context = {},
  turnType = null
} = {}) {
  const sanitizedFields = {};
  const sanitizedEvidence = {};
  const rejectedFields = [];
  const compactFields = compactObject(fields);

  for (const field of ALL_SANITIZED_FIELDS) {
    if (!Object.hasOwn(compactFields, field)) continue;

    const originalValue = compactFields[field];
    const result = evaluateField(field, originalValue, evidence, text, context, turnType);

    if (!result.ok) {
      if (CORE_IDENTITY_FIELDS.has(field) || RESIDENCE_FIELDS.has(field) || field === 'gender') {
        rejectedFields.push({ field, value: originalValue, reason: result.reason });
      }
      continue;
    }

    sanitizedFields[field] = result.value ?? originalValue;
    sanitizedEvidence[field] = evidence?.[field] || { snippet: String(text || '').slice(0, 180), confidence: 0.7, source: 'local_parser' };
  }

  return { fields: sanitizedFields, evidence: sanitizedEvidence, rejectedFields };
}

export const __fieldSanitizerInternals = {
  normalizeText,
  looksLikePersonalName,
  looksLikeResidenceValue,
  hasGenderEvidenceCue,
  hasResidenceEvidenceCue,
  hasNameEvidenceCue
};
