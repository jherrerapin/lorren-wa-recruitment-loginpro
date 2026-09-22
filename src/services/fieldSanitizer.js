/**
 * fieldSanitizer.js
 * ──────────────────────────────────────────────────────────────────────
 *
 * Compuerta semántica posterior a la IA.
 *
 * Objetivo:
 * - La IA puede proponer entidades, pero este módulo decide si esas entidades
 *   tienen evidencia suficiente para entrar al estado curado del candidato.
 * - La forma del dato no sustituye la semántica: contexto, tipo de turno,
 *   campo pendiente y evidencia deben coincidir antes de aceptar una entidad.
 */

import { hasAmbiguousGenderEvidence, hasStrongGenderEvidence } from './genderEvidencePolicy.js';
import { classifyAgeEvidence } from './ageEvidence.js';
import { isAlreadySentIntent } from './conversationIntent.js';

const DEFAULT_MIN_CONFIDENCE = 0.72;
const CORE_IDENTITY_FIELDS = new Set(['fullName', 'documentType', 'documentNumber', 'age']);
const RESIDENCE_FIELDS = new Set(['locality', 'neighborhood']);
const NAME_CONNECTORS = new Set(['de', 'del', 'la', 'las', 'los', 'y']);
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
  'experienceTime',
  'experienceSummary'
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

  if (field === 'experienceInfo' || field === 'experienceTime' || field === 'experienceSummary') {
    return pending.some((item) => /\b(experiencia|tiempo de experiencia|trabajado|laborado)\b/.test(item));
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
    experienceTime: /\b(experiencia|tiempo|meses|anos)\b/,
    experienceSummary: /\b(experiencia|cargos?|funciones?|areas?|trabajado|laborado|desempenado)\b/
  };

  return fieldPatterns[field]?.test(question) || false;
}

function shortAnswerHasFieldContext(field, context = {}) {
  if (readLastBotQuestion(context).trim()) {
    return lastQuestionAskedForField(field, context);
  }

  const pending = [...new Set(
    readPendingFields(context)
      .map(normalizeText)
      .filter(Boolean)
  )];
  return pending.length === 1 && fieldWasPending(field, context);
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

function hasExplicitNoExperienceEvidence(text = '') {
  const normalized = normalizeText(text);
  return /\b(?:no tengo|no cuento con|sin|ninguna|cero)\s+(?:experiencia|experiencia laboral)\b/.test(normalized)
    || /\b(?:nunca|no)\s+he\s+(?:trabajado|laborado)\b/.test(normalized)
    || /\bno\s+he\s+tenido\s+experiencia\b/.test(normalized);
}

function hasExplicitPositiveExperienceEvidence(text = '') {
  const normalized = normalizeText(text);
  if (!normalized || hasExplicitNoExperienceEvidence(normalized)) return false;

  const explicitExperience = /\b(?:tengo|cuento con|poseo|acredito|he adquirido)\s+(?:mas de\s+|aproximadamente\s+)?(?:\d+\s+(?:anos?|meses?|semanas?)\s+de\s+)?experiencia\b/.test(normalized)
    || /\b(?:he trabajado|he laborado|trabaje|trabajaba|estoy trabajando|me encuentro trabajando|labore|laboraba|laboro|me he desempenado)\b/.test(normalized)
    || /\btrabajo\s+(?:en|como|con|para)\b/.test(normalized);
  const durationWithWorkContext = /\b\d+\s+(?:anos?|meses?|semanas?)\b/.test(normalized)
    && /\b(?:experiencia|trabajado|trabajando|trabaje|trabajaba|labor|operacion|logistic|cargo|oficio|personal|coordin|turno|bodega|cargue|descargue)\w*\b/.test(normalized);
  const operationalResponsibility = /\b(?:manejo|coordino|coordinacion|lidero|superviso)\s+(?:de\s+)?personal\b/.test(normalized);

  return explicitExperience || durationWithWorkContext || operationalResponsibility;
}

function sanitizeExperienceInfo(value, evidence, text, context = {}, turnType = null) {
  const normalizedValue = normalizeText(value);
  const isPositive = ['si', 'sii', 'sip'].includes(normalizedValue);
  const isNegative = normalizedValue === 'no';
  if (!isPositive && !isNegative) return { ok: false, reason: 'invalid_experience_info_value' };

  const normalizedText = normalizeText(text);
  const shortAnswer = /^(?:si|sii|sip|no)$/.test(normalizedText);
  const explicitNo = hasExplicitNoExperienceEvidence(text);
  const explicitYes = hasExplicitPositiveExperienceEvidence(text);

  if (isPositive && explicitNo) return { ok: false, reason: 'experience_info_contradicts_negative_evidence' };
  if (isNegative && explicitYes) return { ok: false, reason: 'experience_info_contradicts_positive_evidence' };
  if (shortAnswer) {
    if (!shortAnswerHasFieldContext('experienceInfo', context)) {
      return { ok: false, reason: 'short_experience_answer_without_active_field_context' };
    }
    return { ok: true, value: isPositive ? 'Sí' : 'No' };
  }
  if (isPositive && explicitYes) return { ok: true, value: 'Sí' };
  if (isNegative && explicitNo) return { ok: true, value: 'No' };

  return { ok: false, reason: 'missing_experience_evidence' };
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

function isLocalParserEvidence(evidence = {}) {
  const source = normalizeText(getEvidence('fullName', evidence).source || '').replace(/\s+/g, '_');
  return source === 'local_parser';
}

function turnLooksLikeOnlyConversation(turnType = '') {
  const normalizedTurn = String(turnType || '').toUpperCase();
  return ['GREETING', 'ASK_QUESTION', 'QUESTION', 'CONFIRMATION', 'OBJECTION', 'OTHER'].includes(normalizedTurn);
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
  const normalized = normalizeText(text);
  return /\b(?:experien|labor|coordin|operaci|logistic|despach|empaqu|supervis|lider|carg|descarg)\w*\b/.test(normalized)
    || /\b(?:trabajado|trabajando|trabaje|trabajaba|cargo|oficio|turnos?|personal|bodega)\b/.test(normalized);
}

function looksLikeQuestionText(text = '', turnType = null) {
  const normalizedTurn = String(turnType || '').toUpperCase();
  if (['ASK_QUESTION', 'QUESTION'].includes(normalizedTurn)) return true;
  const raw = String(text || '').trim();
  if (/[¿?]/.test(raw)) return true;
  const normalized = normalizeText(raw);
  return /^(?:que|cual|cuales|cuanto|cuanta|cuantos|cuantas|como|donde|cuando|por que|me puedes|me podrias|puedes|podrias|quisiera saber|necesito saber)\b/.test(normalized);
}

function hasGroundedExperienceSummaryContext(text = '', context = {}, turnType = null) {
  if (hasExplicitPositiveExperienceEvidence(text)) return true;
  if (looksLikeQuestionText(text, turnType)) return false;

  const normalized = normalizeText(text);
  if (/\b(?:interes|vacante|oferta|postul|aplic)\w*\b/.test(normalized)) return false;

  return fieldWasPending('experienceSummary', context) && hasExperienceEvidence(text);
}

function experienceSummaryProfileEvidenceScore(value = '') {
  const normalized = normalizeText(value);
  if (!normalized) return 0;

  let score = 0;
  if (/\b(?:cc|cedula|cedula de ciudadania|documento|ppt)\b[^.]{0,80}\b\d{5,12}\b/.test(normalized)) score += 2;
  if (/\bedad\s*(?:es|de)?\s*\d{1,2}\b/.test(normalized)) score += 1;
  if (/\b(?:localidad|barrio|residencia|municipio)\b(?:\s+de)?\s+[a-z]/.test(normalized)) score += 1;
  if (/\b(?:medio de transporte|transporte publico|me movilizo|me transporto)\b/.test(normalized)) score += 1;
  if (/\brestricciones?\s+medicas?\b/.test(normalized)) score += 1;
  return score;
}

function hasMeaningfulExperienceSummaryDetail(value = '') {
  const normalized = normalizeText(value);
  if (!normalized) return false;

  const detail = normalized
    .replace(/\b(?:si|sii|sip|claro|afirmativo)\b/g, ' ')
    .replace(/\b(?:tengo|cuento con|poseo|acredito|he adquirido)\b/g, ' ')
    .replace(/\bexperiencia(?: laboral)?\b/g, ' ')
    .replace(/\b(?:mas de|aproximadamente)?\s*(?:\d+|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s*(?:mes(?:es)?|anos?|semanas?)\b/g, ' ')
    .replace(/\b(?:en|de|del|la|el|los|las|un|una|y|o|como|laboral)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return detail.length >= 5 && /[a-z]/.test(detail);
}

function hasNameEvidenceCue(text = '') {
  const normalized = normalizeText(text);
  return /\b(mi nombre es|nombre completo|me llamo)\b/.test(normalized)
    || /^nombre\s*(?:es|:)?\s+/.test(normalized);
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
  if (/\d|[?¿!¡,:;]/.test(raw)) return false;

  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 6) return false;

  let lexicalTokens = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const normalizedToken = normalizeText(token);
    if (!normalizedToken) return false;

    if (NAME_CONNECTORS.has(normalizedToken)) {
      if (index === 0 || index === tokens.length - 1) return false;
      continue;
    }

    if (!/^[A-Za-zÁÉÍÓÚÑáéíóúñ'’-]{2,}$/.test(token)) return false;
    lexicalTokens += 1;
  }

  return lexicalTokens >= 2;
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
  if (isAlreadySentIntent(value)) return { ok: false, reason: 'already_sent_statement_is_not_identity' };

  const fieldContext = fieldWasPending('fullName', context) || lastQuestionAskedForField('fullName', context);
  const identityCue = hasNameEvidenceCue(text);
  const groupedIdentityEvidence = hasDocumentEvidence(text) || hasAgeEvidence(text);
  const usableEvidence = evidenceIsUsable('fullName', evidence, { allowLocalParser: true });
  const localParserEvidence = isLocalParserEvidence(evidence);
  const questionTurn = looksLikeQuestionText(text, turnType);

  if (getEvidence('fullName', evidence).snippet && !evidenceSnippetIsGrounded('fullName', evidence, text)) {
    return { ok: false, reason: 'name_evidence_not_grounded_in_candidate_text' };
  }

  if (questionTurn && !identityCue && !groupedIdentityEvidence) {
    return { ok: false, reason: 'question_without_identity_evidence' };
  }

  // El parser local es un fallback determinístico y no puede convertir por sí
  // solo una frase con forma de nombre en identidad. Debe existir una señal
  // fuerte en el propio mensaje: presentación/etiqueta o bloque de identidad.
  if (localParserEvidence && !identityCue && !groupedIdentityEvidence) {
    return { ok: false, reason: 'local_name_without_strong_identity_evidence' };
  }

  if (!usableEvidence) {
    return { ok: false, reason: 'missing_name_evidence' };
  }

  if (identityCue || groupedIdentityEvidence) return { ok: true };

  // Una respuesta libre como "Andrés Felipe Henao Patiño" solo se acepta
  // cuando el bot estaba pidiendo nombre y una fuente semántica no-local la
  // clasificó como dato. El paso general de la FSM no concede esa autoridad.
  if (fieldContext && !turnLooksLikeOnlyConversation(turnType)) {
    return { ok: true };
  }

  return { ok: false, reason: 'missing_identity_context' };
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

function sanitizeExperienceSummary(value, evidence, text, context = {}, turnType = null) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  if (raw.length < 12) return { ok: false, reason: 'experience_summary_too_short' };
  if (!hasGroundedExperienceSummaryContext(text, context, turnType)) {
    return { ok: false, reason: 'missing_experience_summary_context' };
  }
  if (!hasMeaningfulExperienceSummaryDetail(raw)) {
    return { ok: false, reason: 'experience_summary_without_work_detail' };
  }
  if (experienceSummaryProfileEvidenceScore(raw) >= 2) {
    return { ok: false, reason: 'experience_summary_contains_profile_fields' };
  }

  const normalizedText = normalizeText(text);
  const normalizedValue = normalizeText(raw);
  const valueIsGrounded = Boolean(normalizedText && normalizedValue && normalizedText.includes(normalizedValue));
  const usableEvidence = evidenceIsUsable('experienceSummary', evidence, { allowLocalParser: true });
  const evidenceIsGrounded = evidenceSnippetIsGrounded('experienceSummary', evidence, text);

  if (!valueIsGrounded && !(usableEvidence && evidenceIsGrounded)) {
    return { ok: false, reason: 'experience_summary_evidence_not_grounded' };
  }

  return { ok: true, value: raw.slice(0, 280) };
}

function evaluateField(field, value, evidence, text, context, turnType) {
  if (!hasValue(value)) return { ok: false, reason: 'empty' };
  if (field === 'experienceInfo') return sanitizeExperienceInfo(value, evidence, text, context, turnType);
  if (field === 'experienceSummary') return sanitizeExperienceSummary(value, evidence, text, context, turnType);
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
  hasNameEvidenceCue,
  looksLikeQuestionText
};