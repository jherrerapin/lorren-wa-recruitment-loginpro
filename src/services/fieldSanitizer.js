/**
 * fieldSanitizer.js
 * ──────────────────────────────────────────────────────────────────────
 *
 * Única compuerta semántica de entidades del candidato.
 *
 * La extracción puede venir de IA, parser local o contexto, pero ningún valor
 * entra al estado curado solo porque tenga una forma plausible. Cada entidad
 * debe cumplir tres condiciones: forma válida, evidencia anclada al mensaje y
 * significado compatible con un dato del candidato o con una respuesta al
 * campo que Lórren acaba de pedir.
 */

import { hasAmbiguousGenderEvidence, hasStrongGenderEvidence } from './genderEvidencePolicy.js';
import { classifyAgeEvidence } from './ageEvidence.js';
import { isAlreadySentIntent } from './conversationIntent.js';

const DEFAULT_MIN_CONFIDENCE = 0.72;
const RESIDENCE_FIELDS = new Set(['locality', 'neighborhood']);
const NAME_CONNECTORS = new Set(['de', 'del', 'la', 'las', 'los', 'y']);
const POSITIVE_EVIDENCE_RELATIONS = new Set(['SELF_ATTRIBUTE', 'DIRECT_ANSWER']);
const NEGATIVE_EVIDENCE_RELATIONS = new Set(['QUESTION_MENTION', 'THIRD_PARTY', 'VACANCY_CONTEXT', 'UNKNOWN']);
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

  const aliases = {
    fullName: /\bnombre\b/,
    age: /\b(edad|anos)\b/,
    documentType: /\b(tipo de documento|documento|cedula|cc|ppt)\b/,
    documentNumber: /\b(numero de documento|documento|cedula|cc|ppt)\b/,
    gender: /\b(genero|sexo|mujer|hombre)\b/,
    locality: /\b(barrio|localidad|residencia|zona|sector|municipio)\b/,
    neighborhood: /\b(barrio|localidad|residencia|zona|sector|municipio)\b/,
    transportMode: /\b(transporte|medio de transporte|moto|bicicleta|carro|bus)\b/,
    medicalRestrictions: /\b(restriccion|restricciones|medica|salud)\b/,
    experienceInfo: /\b(experiencia|tiempo de experiencia|trabajado|laborado)\b/,
    experienceTime: /\b(experiencia|tiempo de experiencia|trabajado|laborado)\b/,
    experienceSummary: /\b(experiencia|tiempo de experiencia|trabajado|laborado)\b/
  };

  return pending.some((item) => aliases[field]?.test(item));
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

function fieldHasActiveContext(field, context = {}) {
  return fieldWasPending(field, context) || lastQuestionAskedForField(field, context);
}

function shortAnswerHasFieldContext(field, context = {}) {
  if (readLastBotQuestion(context).trim()) return lastQuestionAskedForField(field, context);
  const pending = [...new Set(readPendingFields(context).map(normalizeText).filter(Boolean))];
  return pending.length === 1 && fieldWasPending(field, context);
}

function getEvidence(field, evidence = {}) {
  const item = evidence?.[field] || {};
  const confidence = Number(item.confidence);
  const relation = typeof item.relation === 'string' ? item.relation.trim().toUpperCase() : null;
  return {
    snippet: typeof item.snippet === 'string' ? item.snippet.trim() : null,
    confidence: Number.isFinite(confidence) ? confidence : null,
    source: typeof item.source === 'string' ? item.source.trim() : null,
    relation: POSITIVE_EVIDENCE_RELATIONS.has(relation) || NEGATIVE_EVIDENCE_RELATIONS.has(relation)
      ? relation
      : null
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
  if (options.allowLocalParser && ['local parser', 'local_parser'].includes(source)) return true;
  if (!item.snippet) return false;
  return (item.confidence ?? 0) >= minFieldConfidence();
}

function evidenceContract(field, evidence, text, options = {}) {
  const item = getEvidence(field, evidence);
  if (item.snippet && !evidenceSnippetIsGrounded(field, evidence, text)) {
    return { ok: false, reason: `${field}_evidence_not_grounded` };
  }
  if (!evidenceIsUsable(field, evidence, options)) {
    return { ok: false, reason: `missing_${field}_evidence` };
  }
  if (NEGATIVE_EVIDENCE_RELATIONS.has(item.relation)) {
    return { ok: false, reason: `${field}_relation_${item.relation.toLowerCase()}` };
  }
  return { ok: true, relation: item.relation };
}

function isLocalParserEvidence(field, evidence = {}) {
  const source = normalizeText(getEvidence(field, evidence).source || '').replace(/\s+/g, '_');
  return source === 'local_parser';
}

function looksLikeQuestionText(text = '', turnType = null) {
  const normalizedTurn = String(turnType || '').toUpperCase();
  if (['ASK_QUESTION', 'QUESTION'].includes(normalizedTurn)) return true;
  const raw = String(text || '').trim();
  if (/[¿?]/.test(raw)) return true;
  const normalized = normalizeText(raw);
  return /^(?:que|cual|cuales|cuanto|cuanta|cuantos|cuantas|como|donde|cuando|por que|me puedes|me podrias|puedes|podrias|quisiera saber|necesito saber)\b/.test(normalized);
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

function hasDocumentOwnershipCue(text = '') {
  const normalized = normalizeText(text);
  return /\b(?:mi|el)\s+(?:cc|cedula|documento|ppt)\b/.test(normalized)
    || /\b(?:cc|cedula|documento|ppt)\s*(?:es|numero|nro)\b/.test(normalized)
    || /\b(?:tengo|cuento con|uso|manejo)\s+(?:cc|cedula|documento|ppt)\b/.test(normalized);
}

function hasAgeEvidence(text = '') {
  const normalized = normalizeText(text);
  return /\b(edad|tengo|anos|ano)\b/.test(normalized) && /\b\d{1,2}\b/.test(normalized);
}

function hasNameEvidenceCue(text = '') {
  const normalized = normalizeText(text);
  return /\b(mi nombre es|nombre completo|me llamo)\b/.test(normalized)
    || /^nombre\s*(?:es|:)?\s+/.test(normalized);
}

function hasResidenceEvidenceCue(text = '') {
  const normalized = normalizeText(text);
  return /\b(?:vivo|resido|mi residencia|mi barrio|mi localidad|mi sector|mi zona|soy de|me encuentro viviendo|estoy viviendo)\b/.test(normalized);
}

function hasTransportEvidenceCue(text = '') {
  const normalized = normalizeText(text);
  return /\b(?:tengo|cuento con|dispongo de|uso|utilizo|me movilizo en|me muevo en|me transporto en|voy en|mi transporte es)\s+(?:moto|motocicleta|bicicleta|bici|cicla|carro|automovil|vehiculo|bus|buseta|transporte publico|taxi|uber|indriver)\b/.test(normalized)
    || /\b(?:no tengo|no cuento con|sin)\s+(?:vehiculo|moto|motocicleta|bicicleta|carro|transporte propio)\b/.test(normalized);
}

function hasMedicalEvidenceCue(text = '') {
  const normalized = normalizeText(text);
  return /\b(?:no tengo|no cuento con|sin|ninguna|tengo|cuento con|presento|padezco|sufro de|mi restriccion es|mis restricciones son)\s+(?:ninguna\s+)?(?:restriccion|restricciones|limitacion|limitaciones)(?:\s+medicas?)?\b/.test(normalized)
    || /\b(?:estoy sano|estoy sana)\b/.test(normalized);
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
  if (!raw || raw.length < 2 || raw.length > 80) return false;
  if (/\d{4,}/.test(raw)) return false;
  return /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(raw);
}

function contextualEntityDecision({ field, evidence, text, context, turnType, explicitCue = false, allowLocalParser = true }) {
  const evidenceDecision = evidenceContract(field, evidence, text, { allowLocalParser });
  if (!evidenceDecision.ok) return evidenceDecision;

  const fieldContext = fieldHasActiveContext(field, context);
  if (evidenceDecision.relation === 'SELF_ATTRIBUTE') return { ok: true };
  if (evidenceDecision.relation === 'DIRECT_ANSWER') {
    return fieldContext
      ? { ok: true }
      : { ok: false, reason: `${field}_direct_answer_without_active_context` };
  }

  const questionTurn = looksLikeQuestionText(text, turnType);
  if (questionTurn && !explicitCue) return { ok: false, reason: `${field}_mentioned_only_in_question` };
  if (explicitCue) return { ok: true };
  if (fieldContext && !questionTurn) return { ok: true };
  return { ok: false, reason: `missing_${field}_context` };
}

function sanitizeFullName(value, evidence, text, context, turnType) {
  if (!looksLikePersonalName(value)) return { ok: false, reason: 'invalid_name_shape' };
  if (isAlreadySentIntent(value)) return { ok: false, reason: 'already_sent_statement_is_not_identity' };

  const identityCue = hasNameEvidenceCue(text);
  const groupedIdentityEvidence = hasDocumentEvidence(text) || hasAgeEvidence(text);
  const localParserEvidence = isLocalParserEvidence('fullName', evidence);
  const evidenceDecision = evidenceContract('fullName', evidence, text, { allowLocalParser: true });
  if (!evidenceDecision.ok) return evidenceDecision;

  if (evidenceDecision.relation === 'SELF_ATTRIBUTE') return { ok: true };
  if (evidenceDecision.relation === 'DIRECT_ANSWER') {
    return fieldHasActiveContext('fullName', context)
      ? { ok: true }
      : { ok: false, reason: 'name_direct_answer_without_active_context' };
  }

  if (looksLikeQuestionText(text, turnType) && !identityCue && !groupedIdentityEvidence) {
    return { ok: false, reason: 'question_without_identity_evidence' };
  }
  if (localParserEvidence && !identityCue && !groupedIdentityEvidence) {
    return { ok: false, reason: 'local_name_without_strong_identity_evidence' };
  }
  if (identityCue || groupedIdentityEvidence) return { ok: true };
  if (fieldHasActiveContext('fullName', context) && !turnLooksLikeOnlyConversation(turnType)) return { ok: true };
  return { ok: false, reason: 'missing_identity_context' };
}

function sanitizeResidence(field, value, evidence, text, context, turnType) {
  if (!looksLikeResidenceValue(value)) return { ok: false, reason: 'invalid_residence_shape' };
  return contextualEntityDecision({ field, evidence, text, context, turnType, explicitCue: hasResidenceEvidenceCue(text), allowLocalParser: true });
}

function sanitizeGender(value, evidence, text, context, turnType) {
  if (!['MALE', 'FEMALE', 'OTHER', 'UNKNOWN'].includes(String(value || ''))) return { ok: false, reason: 'invalid_gender_value' };
  if (value === 'UNKNOWN') return { ok: false, reason: 'unknown_gender_is_not_persisted' };
  if (hasOnlyCourtesyTreatmentAsGenderCue(text)) return { ok: false, reason: 'courtesy_treatment_is_not_candidate_gender' };
  if (evidenceSourceLooksInferential('gender', evidence)) return { ok: false, reason: 'gender_inferred_from_name' };

  const evidenceDecision = evidenceContract('gender', evidence, text, { allowLocalParser: true });
  if (!evidenceDecision.ok) return evidenceDecision;
  const genderCue = hasGenderEvidenceCue(value, text);
  const fieldContext = fieldHasActiveContext('gender', context);
  if (!genderCue && !fieldContext) return { ok: false, reason: 'gender_without_explicit_linguistic_evidence' };
  if (evidenceDecision.relation === 'DIRECT_ANSWER' && !fieldContext) return { ok: false, reason: 'gender_direct_answer_without_active_context' };
  if (looksLikeQuestionText(text, turnType) && !genderCue && evidenceDecision.relation !== 'SELF_ATTRIBUTE') {
    return { ok: false, reason: 'gender_mentioned_only_in_question' };
  }
  return { ok: true };
}

function normalizeDocumentNumber(value) {
  const normalized = String(value || '').replace(/[^A-Za-z0-9]/g, '').trim();
  if (/^\d{5,12}$/.test(normalized)) return normalized;
  if (/^[A-Za-z0-9]{5,15}$/.test(normalized)) return normalized.toUpperCase();
  return null;
}

function sanitizeDocumentNumber(value, evidence, text, context, turnType) {
  const normalized = normalizeDocumentNumber(value);
  if (!normalized) return { ok: false, reason: 'invalid_document_number_shape' };
  const decision = contextualEntityDecision({ field: 'documentNumber', evidence, text, context, turnType, explicitCue: hasDocumentOwnershipCue(text), allowLocalParser: true });
  return decision.ok ? { ok: true, value: normalized } : decision;
}

function sanitizeDocumentType(value, evidence, text, context, turnType) {
  const normalized = normalizeText(value);
  const allowed = new Set(['cc', 'cedula', 'cedula de ciudadania', 'ppt']);
  if (!allowed.has(normalized)) return { ok: false, reason: 'unsupported_document_type' };
  return contextualEntityDecision({ field: 'documentType', evidence, text, context, turnType, explicitCue: hasDocumentOwnershipCue(text), allowLocalParser: true });
}

function sanitizeAge(value, evidence, text, context = {}) {
  if (!/^\d+$/.test(String(value || '').trim())) return { ok: false, reason: 'invalid_numeric_value' };
  const age = Number(value);
  if (!Number.isInteger(age) || age < 14 || age > 80) return { ok: false, reason: 'invalid_age_range' };
  const relation = getEvidence('age', evidence).relation;
  if (NEGATIVE_EVIDENCE_RELATIONS.has(relation)) return { ok: false, reason: `age_relation_${relation.toLowerCase()}` };
  if (relation === 'DIRECT_ANSWER' && !fieldHasActiveContext('age', context)) return { ok: false, reason: 'age_direct_answer_without_active_context' };
  const allowStandalone = fieldHasActiveContext('age', context);
  const ageEvidence = classifyAgeEvidence(age, text, { allowStandalone });
  if (!ageEvidence.valid) return { ok: false, reason: ageEvidence.reason };
  return { ok: true, value: age };
}

function sanitizeTransportMode(value, evidence, text, context, turnType) {
  const normalizedValue = normalizeText(value);
  const allowed = new Set(['moto', 'motocicleta', 'bicicleta', 'bici', 'cicla', 'carro', 'automovil', 'vehiculo', 'bus', 'buseta', 'publico', 'transporte publico', 'independiente', 'taxi', 'uber', 'indriver']);
  if (!allowed.has(normalizedValue)) return { ok: false, reason: 'invalid_transport_value' };
  return contextualEntityDecision({ field: 'transportMode', evidence, text, context, turnType, explicitCue: hasTransportEvidenceCue(text), allowLocalParser: true });
}

function sanitizeMedicalRestrictions(value, evidence, text, context, turnType) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  if (!raw || raw.length > 240) return { ok: false, reason: 'invalid_medical_restrictions_shape' };
  const shortAnswer = /^(?:no|ninguna|ninguno|si|sí)$/i.test(raw);
  const evidenceDecision = evidenceContract('medicalRestrictions', evidence, text, { allowLocalParser: true });
  if (!evidenceDecision.ok) return evidenceDecision;
  if (evidenceDecision.relation === 'SELF_ATTRIBUTE') return { ok: true };
  if (evidenceDecision.relation === 'DIRECT_ANSWER') {
    return fieldHasActiveContext('medicalRestrictions', context)
      ? { ok: true }
      : { ok: false, reason: 'medicalRestrictions_direct_answer_without_active_context' };
  }
  if (shortAnswer && shortAnswerHasFieldContext('medicalRestrictions', context) && !looksLikeQuestionText(text, turnType)) return { ok: true };
  return contextualEntityDecision({ field: 'medicalRestrictions', evidence, text, context, turnType, explicitCue: hasMedicalEvidenceCue(text), allowLocalParser: true });
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

function hasExperienceEvidence(text = '') {
  const normalized = normalizeText(text);
  return /\b(?:experien|labor|coordin|operaci|logistic|despach|empaqu|supervis|lider|carg|descarg)\w*\b/.test(normalized)
    || /\b(?:trabajado|trabajando|trabaje|trabajaba|cargo|oficio|turnos?|personal|bodega)\b/.test(normalized);
}

function sanitizeExperienceInfo(value, evidence, text, context = {}, turnType = null) {
  const normalizedValue = normalizeText(value);
  const isPositive = ['si', 'sii', 'sip'].includes(normalizedValue);
  const isNegative = normalizedValue === 'no';
  if (!isPositive && !isNegative) return { ok: false, reason: 'invalid_experience_info_value' };

  const evidenceDecision = evidenceContract('experienceInfo', evidence, text, { allowLocalParser: true });
  if (!evidenceDecision.ok) return evidenceDecision;
  if (evidenceDecision.relation === 'DIRECT_ANSWER' && fieldHasActiveContext('experienceInfo', context)) return { ok: true, value: isPositive ? 'Sí' : 'No' };

  const normalizedText = normalizeText(text);
  const shortAnswer = /^(?:si|sii|sip|no)$/.test(normalizedText);
  const explicitNo = hasExplicitNoExperienceEvidence(text);
  const explicitYes = hasExplicitPositiveExperienceEvidence(text);
  if (isPositive && explicitNo) return { ok: false, reason: 'experience_info_contradicts_negative_evidence' };
  if (isNegative && explicitYes) return { ok: false, reason: 'experience_info_contradicts_positive_evidence' };
  if (looksLikeQuestionText(text, turnType) && !explicitNo && !explicitYes && evidenceDecision.relation !== 'SELF_ATTRIBUTE') {
    return { ok: false, reason: 'experience_mentioned_only_in_question' };
  }
  if (shortAnswer) {
    if (!shortAnswerHasFieldContext('experienceInfo', context)) return { ok: false, reason: 'short_experience_answer_without_active_field_context' };
    return { ok: true, value: isPositive ? 'Sí' : 'No' };
  }
  if (isPositive && explicitYes) return { ok: true, value: 'Sí' };
  if (isNegative && explicitNo) return { ok: true, value: 'No' };
  if (evidenceDecision.relation === 'SELF_ATTRIBUTE') return { ok: true, value: isPositive ? 'Sí' : 'No' };
  if (fieldHasActiveContext('experienceInfo', context)) return { ok: true, value: isPositive ? 'Sí' : 'No' };
  return { ok: false, reason: 'missing_experience_evidence' };
}

function sanitizeExperienceTime(value, evidence, text, context, turnType) {
  const raw = String(value || '').trim();
  if (!/\b\d+\s*(?:mes|meses|ano|anos|año|años|semana|semanas)\b/i.test(raw)) return { ok: false, reason: 'invalid_experience_time_shape' };
  const evidenceDecision = evidenceContract('experienceTime', evidence, text, { allowLocalParser: true });
  if (!evidenceDecision.ok) return evidenceDecision;
  if (evidenceDecision.relation === 'DIRECT_ANSWER' && fieldHasActiveContext('experienceTime', context)) return { ok: true };
  if (looksLikeQuestionText(text, turnType) && !hasExplicitPositiveExperienceEvidence(text) && evidenceDecision.relation !== 'SELF_ATTRIBUTE') {
    return { ok: false, reason: 'experience_time_mentioned_only_in_question' };
  }
  if (evidenceDecision.relation === 'SELF_ATTRIBUTE' || hasExplicitPositiveExperienceEvidence(text) || fieldHasActiveContext('experienceTime', context)) return { ok: true };
  return { ok: false, reason: 'missing_experience_time_context' };
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

function sanitizeExperienceSummary(value, evidence, text, context = {}, turnType = null) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  if (raw.length < 12) return { ok: false, reason: 'experience_summary_too_short' };
  const evidenceDecision = evidenceContract('experienceSummary', evidence, text, { allowLocalParser: true });
  if (!evidenceDecision.ok) return evidenceDecision;
  if (evidenceDecision.relation === 'DIRECT_ANSWER' && !fieldHasActiveContext('experienceSummary', context)) return { ok: false, reason: 'experienceSummary_direct_answer_without_active_context' };
  if (evidenceDecision.relation !== 'SELF_ATTRIBUTE' && evidenceDecision.relation !== 'DIRECT_ANSWER' && !hasGroundedExperienceSummaryContext(text, context, turnType)) {
    return { ok: false, reason: 'missing_experience_summary_context' };
  }
  if (!hasMeaningfulExperienceSummaryDetail(raw)) return { ok: false, reason: 'experience_summary_without_work_detail' };
  if (experienceSummaryProfileEvidenceScore(raw) >= 2) return { ok: false, reason: 'experience_summary_contains_profile_fields' };

  const normalizedText = normalizeText(text);
  const normalizedValue = normalizeText(raw);
  const valueIsGrounded = Boolean(normalizedText && normalizedValue && normalizedText.includes(normalizedValue));
  const usableEvidence = evidenceIsUsable('experienceSummary', evidence, { allowLocalParser: true });
  const groundedEvidence = evidenceSnippetIsGrounded('experienceSummary', evidence, text);
  if (!valueIsGrounded && !(usableEvidence && groundedEvidence)) return { ok: false, reason: 'experience_summary_evidence_not_grounded' };
  return { ok: true, value: raw.slice(0, 280) };
}

function evaluateField(field, value, evidence, text, context, turnType) {
  if (!hasValue(value)) return { ok: false, reason: 'empty' };
  if (field === 'fullName') return sanitizeFullName(value, evidence, text, context, turnType);
  if (field === 'age') return sanitizeAge(value, evidence, text, context);
  if (field === 'documentType') return sanitizeDocumentType(value, evidence, text, context, turnType);
  if (field === 'documentNumber') return sanitizeDocumentNumber(value, evidence, text, context, turnType);
  if (field === 'gender') return sanitizeGender(value, evidence, text, context, turnType);
  if (RESIDENCE_FIELDS.has(field)) return sanitizeResidence(field, value, evidence, text, context, turnType);
  if (field === 'transportMode') return sanitizeTransportMode(value, evidence, text, context, turnType);
  if (field === 'medicalRestrictions') return sanitizeMedicalRestrictions(value, evidence, text, context, turnType);
  if (field === 'experienceInfo') return sanitizeExperienceInfo(value, evidence, text, context, turnType);
  if (field === 'experienceTime') return sanitizeExperienceTime(value, evidence, text, context, turnType);
  if (field === 'experienceSummary') return sanitizeExperienceSummary(value, evidence, text, context, turnType);
  return { ok: false, reason: 'unsupported_candidate_field' };
}

export function sanitizeCandidateFieldsForConversation({ fields = {}, evidence = {}, text = '', context = {}, turnType = null } = {}) {
  const sanitizedFields = {};
  const sanitizedEvidence = {};
  const rejectedFields = [];
  const proposedFields = compactObject(fields);

  for (const field of ALL_SANITIZED_FIELDS) {
    if (!Object.hasOwn(proposedFields, field)) continue;
    const originalValue = proposedFields[field];
    const result = evaluateField(field, originalValue, evidence, text, context, turnType);
    if (!result.ok) {
      rejectedFields.push({ field, value: originalValue, reason: result.reason });
      continue;
    }
    sanitizedFields[field] = result.value ?? originalValue;
    sanitizedEvidence[field] = evidence?.[field] || {
      snippet: String(text || '').slice(0, 180),
      confidence: 0.7,
      source: 'local_parser',
      relation: null
    };
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
  hasDocumentOwnershipCue,
  hasTransportEvidenceCue,
  hasMedicalEvidenceCue,
  looksLikeQuestionText
};
