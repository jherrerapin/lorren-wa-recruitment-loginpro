import { createHash, randomUUID } from 'node:crypto';
import { CandidateStatus, ConversationStep, MessageType } from '@prisma/client';
import { extractMessages, sendTextMessage } from './whatsapp.js';
import { buildCandidateDataCollectionMessage } from './readinessGuard.js';
import {
  normalizeCandidateFields,
  parseNaturalData
} from './candidateData.js';
import { analyzeConversationTurn } from './conversationIntent.js';
import { captureConsentedProfileData } from './consentProfileCapture.js';
import { buildConsentQuestionReply } from './consentFaq.js';
import { isSupervisorPhone } from './adminSupervisor.js';
import { recordCandidateDataConsent } from './consentStateService.js';
import { cancelActiveInterviewBookings } from './interviewBookingStateService.js';
import { cancelReminderOnInbound } from './reminder.js';
import {
  compareAndSwapConversationMessagePayload,
  findInboundConversationMessage,
  findRecentOutboundConversationDelivery,
  persistInboundConversationMessage,
  persistOutboundConversationMessage,
  updateOutboundConversationDelivery
} from './conversationMessageRepository.js';

export const DATA_CONSENT_VERSION = 'lorren-v2-2026-07-v3';

export const DATA_CONSENT_TEXT = process.env.DATA_CONSENT_TEXT || 'Autorizo a LoginPro a tratar mis datos personales, hoja de vida y documentos enviados por WhatsApp para gestionar mi postulación, validar información, contactarme y conservar la trazabilidad del proceso. Entiendo que puedo solicitar consulta, actualización, corrección o revocatoria de esta autorización.';

export const CAMPAIGN_VACANCY_CONFIRMATION_MODE = 'campaign_vacancy_pending_confirmation';
export const APPLICATION_INTEREST_PENDING_MODE = 'awaiting_application_interest';
export const DATA_CONSENT_PENDING_MODE = 'awaiting_data_consent';

const CONSENT_PENDING_CONTEXT_PREFIX = `${DATA_CONSENT_PENDING_MODE}:`;
const CAMPAIGN_CONFIRMATION_CV_MODE = `${CAMPAIGN_VACANCY_CONFIRMATION_MODE}:cv_resend`;
const PRE_CONSENT_CV_RESEND_MODE = 'pre_consent_cv_resend';
const ALTERNATIVE_MODE_PATTERN = /^(alternative_vacancy_(?:offer|prequalification))(?::(.+))?$/;

const PRE_CONSENT_CAPTURE_MODES = new Set([
  'future_profile_capture',
  'paused_vacancy_capture'
]);

const PRE_CONSENT_OFFER_TO_CAPTURE_MODE = new Map([
  ['future_profile_offer', 'future_profile_capture'],
  ['paused_vacancy', 'paused_vacancy_capture']
]);

const PROTECTED_STEPS = new Set([
  ConversationStep.COLLECTING_DATA,
  ConversationStep.CONFIRMING_DATA,
  ConversationStep.ASK_CV,
  ConversationStep.SCHEDULING,
  ConversationStep.SCHEDULED
]);

const NAME_TOKEN_PATTERN = /^[A-Za-zÁÉÍÓÚÑáéíóúñ'.-]{2,}$/;
const STANDALONE_NAME_CONNECTORS = new Set(['de', 'del', 'la', 'las', 'los', 'y']);
const NON_NAME_INTRODUCTION_PATTERN = /\b(mujer|hombre|femenin[ao]|masculin[ao]|candidat[ao]|interesad[ao]|auxiliar|operari[ao]|coordinador[ao]?|lider|bodega|cargue|descargue|servicios?|generales?|vacante|cargo|aplicar|postularme?)\b/;
const CONSENT_SUBJECT_PATTERN = /\b(tratamiento|datos|dato personal|datos personales|hoja de vida|hv|documentos?|consentimiento|autorizacion)\b/;
const OFFER_SUBJECT_PATTERN = /\b(vacante|oferta|cargo|trabajo|empleo|postulacion|entrevista)\b/;

const CONSENT_PROMPT = process.env.DATA_CONSENT_PROMPT || `Antes de recibir o guardar datos personales, hojas de vida o documentos, necesito tu autorización para tratarlos con fines de reclutamiento de LoginPro.\n\n${DATA_CONSENT_TEXT}\n\nPuedes responder de forma natural si autorizas o si no autorizas.`;
const CONSENT_CLARIFIER_REPLY = 'Para continuar necesito saber si autorizas a LoginPro a tratar tus datos y hoja de vida para este proceso. Puedes responder de forma natural si autorizas o si no autorizas.';
const CONSENT_REVOKED_REPLY = 'Entendido. No continuaré con la postulación ni procesaré tus datos por este medio. Si más adelante deseas autorizar el tratamiento de datos, puedes escribirnos de nuevo.';
const VACANCY_NOT_CONFIRMED_REPLY = 'Entendido. Para ubicar bien tu proceso, cuéntame la ciudad y el cargo o vacante que te interesa.';
const PRE_CONSENT_ATTACHMENT_REPLY = 'Recibí que intentaste enviar un archivo, pero todavía no lo descargué ni lo guardé.';
const PRE_CONSENT_DATA_REPLY = 'Veo que compartiste información personal, pero todavía no la registré en tu perfil.';
const APPLICATION_INTEREST_REQUIRED_REPLY = 'Antes de solicitar tu autorización o recibir datos, confírmame si deseas postularte a esta vacante.';
const CONSENT_GATE_ERROR_REPLY = 'No pude validar tu autorización en este momento. Por seguridad no voy a recibir ni guardar datos o documentos. Intenta nuevamente más tarde.';
const RESEND_CV_REPLY = 'Como el archivo anterior llegó antes de la autorización y no fue guardado, vuelve a adjuntar tu hoja de vida en PDF o DOCX.';
const ALTERNATIVE_VACANCY_UNAVAILABLE_REPLY = 'Gracias, tu autorización quedó registrada. La vacante alternativa que te había mencionado ya no está activa o dejó de recibir postulaciones. Cuéntame la ciudad y el cargo que te interesa para revisar opciones vigentes.';

function normalize(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasAny(text = '', patterns = []) {
  return patterns.some((pattern) => pattern.test(text));
}

function isQuestionLike(text = '') {
  const raw = String(text || '').trim();
  const normalized = normalize(raw);
  if (!normalized) return false;
  return raw.includes('?') || hasAny(normalized, [
    /\b(cual|cuanto|cuando|donde|como|que|quien|por que)\b/,
    /\b(salario|sueldo|pago|horario|turno|requisito|funcion|ubicacion|direccion|contrato|beneficio)\b/
  ]);
}

function startsWithExplicitConsent(text = '') {
  return /^(si|sii|sip|claro|correcto|de acuerdo|acepto|autorizo|consiento|estoy de acuerdo|doy mi consentimiento|doy consentimiento|doy permiso)\b/.test(text);
}

function startsWithExplicitVacancyConfirmation(text = '') {
  return /^(si|sii|sip|claro|correcto|exacto|esa es|si es|de acuerdo|confirmo|confirmado|me interesa|estoy interesado|estoy interesada|quiero aplicar|quiero postularme)\b/.test(text);
}

function referencesConsentSubject(text = '') {
  return CONSENT_SUBJECT_PATTERN.test(normalize(text));
}

function referencesOfferSubject(text = '') {
  return OFFER_SUBJECT_PATTERN.test(normalize(text));
}

function startsWithExplicitConsentRejection(text = '') {
  return /^(no autorizo|no consiento|no doy mi consentimiento|no doy consentimiento|no doy autorizacion|no doy permiso|no deseo autorizar|no quiero autorizar|no permito|no acepto|no estoy de acuerdo|rechazo|revoco)\b/.test(normalize(text));
}

function stripConsentCourtesyPrefix(text = '') {
  return normalize(text).replace(/^(?:por favor|porfa)\s+/, '');
}

function isDirectConsentWithdrawal(text = '') {
  const normalized = stripConsentCourtesyPrefix(text);
  if (!normalized) return false;
  if (startsWithExplicitConsentRejection(normalized) && referencesConsentSubject(normalized)) return true;
  return hasAny(normalized, [
    /^(?:eliminen|elimine|borren|borre|supriman|suprima)\b.*\b(datos|informacion|registro)\b/,
    /^(?:revoquen|revoque|retiren|retire|revoco|retiro)\b.*\b(autorizacion|consentimiento|tratamiento|datos)\b/,
    /^(?:solicito|pido|exijo|quiero|deseo)\b.*\b(revocatoria|revocacion|revocar|retirar|eliminar|borrar|suprimir|cancelar|detener)\b.*\b(autorizacion|consentimiento|tratamiento|datos|informacion|registro|proceso|postulacion)\b/,
    /^(?:cancelen|cancele|detengan|detenga|paren|pare)\b.*\b(postulacion|proceso|tratamiento|datos)\b/
  ]);
}

function isConsentRightsQuestion(text = '') {
  const normalized = stripConsentCourtesyPrefix(text);
  if (!normalized || isDirectConsentWithdrawal(normalized)) return false;
  const questionLead = /^(?:como|como puedo|puedo|podria|que debo|que tengo que|cual es|donde)\b/.test(normalized);
  const futureRightsContext = /\b(?:si mas adelante|mas adelante|despues|en el futuro)\b/.test(normalized);
  return questionLead || (String(text || '').includes('?') && futureRightsContext);
}

function isExplicitConsentRevocation(text = '') {
  const normalized = stripConsentCourtesyPrefix(text);
  if (!normalized || isConsentRightsQuestion(text)) return false;
  if (isDirectConsentWithdrawal(normalized)) return true;
  return hasAny(normalized, [
    /\b(cancelar|cancelen|cancele|detener|detengan|detenga|parar|paren|pare)\b.*\b(postulacion|proceso|tratamiento|datos)\b/,
    /\b(eliminar|eliminen|elimine|borrar|borren|borre|suprimir|supriman|suprima)\b.*\b(datos|informacion|registro)\b/,
    /\b(revocar|revoco|revoquen|revoque|retiro|retirar|retiren|retire)\b.*\b(autorizacion|consentimiento|tratamiento|datos)\b/,
    /\b(revocatoria|revocacion)\b.*\b(autorizacion|consentimiento|tratamiento|datos)\b/
  ]);
}

function hasExplicitConsentRejection(text = '') {
  const normalized = normalize(text);
  if (!normalized) return false;
  if (isExplicitConsentRevocation(text)) return true;
  if (isQuestionLike(text) && !startsWithExplicitConsentRejection(normalized)) return false;

  if (hasAny(normalized, [
    /\b(no autorizo|no consiento|no doy mi consentimiento|no doy consentimiento|no doy autorizacion|no doy permiso|no deseo autorizar|no quiero autorizar|no permito el uso de mis datos)\b/,
    /\b(rechazo|revoco)\b.*\b(autorizacion|consentimiento|tratamiento de datos)\b/
  ])) return true;

  return referencesConsentSubject(normalized) && /\b(no acepto|no estoy de acuerdo)\b/.test(normalized);
}

function hasExplicitConsentAcceptance(text = '') {
  const normalized = normalize(text);
  if (!normalized || hasExplicitConsentRejection(normalized)) return false;

  if (hasAny(normalized, [
    /\b(autorizo|autorisado|autorizado|consiento)\b/,
    /\b(doy mi consentimiento|doy consentimiento|autorizacion concedida)\b/,
    /\b(pueden|puede)\s+(usar|tratar|manejar|procesar|guardar)\s+(mis|los)\s+datos\b/,
    /\b(pueden|puede)\s+continuar\s+con\s+(mis|los)\s+datos\b/
  ])) return true;

  if (!referencesConsentSubject(normalized)) return false;
  return /\b(acepto|estoy de acuerdo|doy permiso|tienen mi permiso)\b/.test(normalized);
}

export function isConsentAcceptance(text = '') {
  const normalized = normalize(text);
  if (!normalized || hasExplicitConsentRejection(text)) return false;
  if (isQuestionLike(text) && !startsWithExplicitConsent(normalized)) return false;
  return hasAny(normalized, [
    /\b(acepto|autorizo|autorizado|autorisado|consiento)\b/,
    /\b(si|sii|sip|claro|correcto|de acuerdo|dale|ok|listo)\b.*\b(acepto|autorizo|consiento)\b/,
    /\b(estoy de acuerdo|doy mi consentimiento|doy consentimiento|doy permiso|tienen mi permiso|autorizacion concedida)\b/,
    /\b(pueden|puede)\s+(usar|tratar|manejar|procesar|guardar)\s+(mis|los)\s+datos\b/,
    /\b(pueden|puede)\s+continuar\s+con\s+(mis|los)\s+datos\b/,
    /\b(si|sii|sip|claro|correcto|de acuerdo|dale|ok|listo|continuemos|sigamos)\b$/
  ]);
}

export function isConsentRejection(text = '') {
  const normalized = normalize(text);
  if (!normalized) return false;
  if (isQuestionLike(text) && !startsWithExplicitConsentRejection(normalized) && !isExplicitConsentRevocation(text)) return false;
  if (hasExplicitConsentRejection(text)) return true;
  return /\b(no|negativo|paso|no gracias)\b$/.test(normalized);
}

export function shouldRecordConsentAcceptance(text = '', { consentPromptPending = false } = {}) {
  if (!isConsentAcceptance(text)) return false;
  if (hasExplicitConsentAcceptance(text)) return true;
  if (!consentPromptPending) return false;
  if (referencesOfferSubject(text) && !referencesConsentSubject(text)) return false;
  return true;
}

export function shouldRecordConsentRejection(text = '', { consentPromptPending = false } = {}) {
  if (!isConsentRejection(text)) return false;
  if (hasExplicitConsentRejection(text)) return true;
  if (!consentPromptPending) return false;
  if (referencesOfferSubject(text) && !referencesConsentSubject(text)) return false;
  return true;
}

function isAffirmativeVacancyConfirmation(text = '') {
  const normalized = normalize(text);
  if (!normalized) return false;
  if (isQuestionLike(text) && !startsWithExplicitVacancyConfirmation(normalized)) return false;
  return hasAny(normalized, [
    /\b(si|sii|sip|claro|correcto|exacto|esa es|si es|de acuerdo|dale|ok|listo)\b/,
    /\b(confirmo|confirmado|me interesa|estoy interesado|estoy interesada|quiero aplicar|quiero postularme)\b/
  ]);
}

function isNegativeVacancyConfirmation(text = '') {
  const normalized = normalize(text);
  if (!normalized) return false;
  return hasAny(normalized, [
    /\b(no es|esa no|no es esa|otra vacante|otro cargo|no corresponde|equivocado|equivocada)\b/,
    /^no\b/,
    /\b(no me interesa|no quiero|no deseo|paso|no gracias)\b/
  ]);
}

function isConsentAlreadyAccepted(candidate = {}) {
  return candidate?.dataConsentStatus === 'ACCEPTED';
}

function isAwaitingCampaignVacancyConfirmation(candidate = {}) {
  return Boolean(
    candidate?.vacancyId
    && [CAMPAIGN_VACANCY_CONFIRMATION_MODE, CAMPAIGN_CONFIRMATION_CV_MODE].includes(String(candidate?.botResumeMode || ''))
  );
}

function isProtectedAttachment(message = {}) {
  return !['text', 'interactive'].includes(String(message?.type || ''));
}

function inboundText(message = {}) {
  if (message.type === 'text') return message.text?.body || '';
  if (message.type === 'interactive') {
    return message.interactive?.button_reply?.title
      || message.interactive?.button_reply?.id
      || message.interactive?.list_reply?.title
      || message.interactive?.list_reply?.id
      || '';
  }
  return '';
}

function trimEvidenceFragment(value = '') {
  return String(value || '')
    .split(/[.;\n]/, 1)[0]
    .trim()
    .replace(/^[,:\-\s]+|[,:\-\s]+$/g, '');
}

function buildCurrentInboundEvidence(field, value, rule, fragment) {
  return {
    field,
    value,
    source: 'CURRENT_INBOUND_EXPLICIT',
    confidence: 0.99,
    rule,
    fragment: String(fragment || '').slice(0, 160)
  };
}

function isPlausibleFullName(value = '') {
  const normalized = normalize(value);
  if (!normalized || NON_NAME_INTRODUCTION_PATTERN.test(normalized)) return false;
  const tokens = String(value || '').trim().split(/\s+/).filter(Boolean);
  return tokens.length >= 2
    && tokens.length <= 6
    && tokens.every((token) => NAME_TOKEN_PATTERN.test(token));
}

function hasStandaloneNameCapitalization(value = '') {
  const tokens = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  return tokens.every((token) => {
    const normalizedToken = normalize(token);
    if (STANDALONE_NAME_CONNECTORS.has(normalizedToken)) return true;
    return /^[A-ZÁÉÍÓÚÑ]/.test(token);
  });
}

function normalizeExplicitFullName(value = '') {
  const captured = trimEvidenceFragment(value);
  if (!isPlausibleFullName(captured)) return null;
  return normalizeCandidateFields({ fullName: captured }).fullName || captured;
}

function resolveExplicitNameEvidence(raw) {
  const text = String(raw || '').trim();
  const labelled = text.match(/\b(?:me llamo|mi nombre(?: completo)?(?: es)?|nombre(?: completo)?\s*[:\-])\s+([^.;\n]{3,100})/i);
  if (labelled) {
    const value = normalizeExplicitFullName(labelled[1]);
    return value
      ? buildCurrentInboundEvidence('fullName', value, 'EXPLICIT_NAME_INTRODUCTION', labelled[0])
      : null;
  }

  const natural = text.match(/^soy\s+([A-Za-zÁÉÍÓÚÑáéíóúñ'.-]+(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ'.-]+){1,5})(?=\s*,|$)/i);
  if (!natural) return null;
  if (looksLikeOccupationalOrDescriptivePhrase(natural[1])) return null;
  const value = normalizeExplicitFullName(natural[1]);
  return value
    ? buildCurrentInboundEvidence('fullName', value, 'EXPLICIT_SOY_NAME_INTRODUCTION', natural[0])
    : null;
}

function looksLikeOccupationalOrDescriptivePhrase(value = '') {
  const contentTokens = String(value || '')
    .trim()
    .split(/\s+/)
    .map((token) => normalize(token))
    .filter((token) => token && !STANDALONE_NAME_CONNECTORS.has(token));
  if (contentTokens.length < 2) return false;
  if (contentTokens[0] === 'muy') return true;

  const head = contentTokens[0];
  const modifiers = contentTokens.slice(1);
  const occupationalHead = /(?:dor|dora|ista|logo|loga|ario|aria|ero|era|ante|ente)$/.test(head);
  const descriptiveHead = /(?:able|ible|ado|ada|ido|ida|oso|osa|ivo|iva)$/.test(head);
  const qualifyingModifier = modifiers.some((token) => (
    /(?:ico|ica|icos|icas|ivo|iva|ivos|ivas|al|ales|ario|aria|arios|arias|ero|era|eros|eras|ista|istas|ante|antes|ente|entes|ado|ada|ados|adas|ido|ida|idos|idas)$/.test(token)
  ));

  return (occupationalHead || descriptiveHead) && qualifyingModifier;
}

function resolveContextualStandaloneNameEvidence(raw, candidate = {}) {
  if (!candidate?.vacancyId) return null;
  const text = String(raw || '').trim();
  if (!text || text.includes('?') || /[,.;:\n]/.test(text)) return null;
  if (!hasStandaloneNameCapitalization(text)) return null;
  if (looksLikeOccupationalOrDescriptivePhrase(text)) return null;
  const value = normalizeExplicitFullName(text);
  return value
    ? buildCurrentInboundEvidence('fullName', value, 'CONTEXTUAL_STANDALONE_FULL_NAME', text)
    : null;
}

function resolveExplicitGenderEvidence(raw) {
  const text = String(raw || '');
  if (/\b(?:soy|me considero|me identifico como)\s+(?:un|una)?\s*(?:mujer|femenina)\b/i.test(text)
    || /\b(?:sexo|genero|género)\s*(?:es|:)?\s*(?:mujer|femenino|femenina)\b/i.test(text)) {
    return buildCurrentInboundEvidence('gender', 'FEMALE', 'EXPLICIT_GENDER_DECLARATION', text);
  }
  if (/\b(?:soy|me considero|me identifico como)\s+(?:un|una)?\s*(?:hombre|masculino)\b/i.test(text)
    || /\b(?:sexo|genero|género)\s*(?:es|:)?\s*(?:hombre|masculino|masculina)\b/i.test(text)) {
    return buildCurrentInboundEvidence('gender', 'MALE', 'EXPLICIT_GENDER_DECLARATION', text);
  }
  return null;
}

function normalizeDocumentCandidate(value = '') {
  return String(value || '').trim().replace(/[.\s]/g, '').replace(/-+/g, '-');
}

function isPlausibleDocumentNumber(value = '') {
  const compact = normalizeDocumentCandidate(value);
  const digits = compact.replace(/\D/g, '');
  return compact.length >= 6
    && compact.length <= 24
    && digits.length >= 6
    && digits.length <= 12
    && /^[A-Z0-9-]+$/i.test(compact);
}

function resolveExplicitDocumentEvidence(raw) {
  const text = String(raw || '').trim();
  const labelled = text.match(/\b(?:mi\s+)?(?:cedula|cédula|c\.?\s*c\.?|documento(?:\s+de\s+identidad)?|numero\s+de\s+documento|número\s+de\s+documento)\b(?:(?:\s+es\b|\s*[:\-])\s*|\s+)([A-Z0-9][A-Z0-9.\-\s]{4,40})/i);
  const labelledValue = trimEvidenceFragment(labelled?.[1] || '');
  if (labelledValue && isPlausibleDocumentNumber(labelledValue)) {
    return buildCurrentInboundEvidence(
      'documentNumber',
      normalizeDocumentCandidate(labelledValue),
      'EXPLICIT_DOCUMENT_LABEL_VALUE_BOUNDARY',
      labelled[0]
    );
  }

  const standalone = text.match(/^\s*([0-9][0-9.\-\s]{5,20})\s*$/);
  const standaloneValue = standalone?.[1] || '';
  if (!isPlausibleDocumentNumber(standaloneValue)) return null;
  return buildCurrentInboundEvidence(
    'documentNumber',
    normalizeDocumentCandidate(standaloneValue),
    'STANDALONE_PLAUSIBLE_DOCUMENT_NUMBER',
    standalone[0].trim()
  );
}

function resolveExplicitMedicalEvidence(raw) {
  const text = String(raw || '');
  const labelled = text.match(/\b(?:restricci[oó]n(?:es)?|condici[oó]n(?:es)?|limitaci[oó]n(?:es)?)\s+m[eé]dicas?\s*[:\-]\s*([^.;\n]{2,100})/i);
  if (labelled) {
    const fragment = trimEvidenceFragment(labelled[0]);
    const normalized = normalizeCandidateFields({ medicalRestrictions: fragment });
    return buildCurrentInboundEvidence(
      'medicalRestrictions',
      normalized.medicalRestrictions || fragment,
      'EXPLICIT_MEDICAL_LABEL_VALUE_BOUNDARY',
      fragment
    );
  }

  const match = text.match(/\b(?:(?:tengo|presento|cuento\s+con|mi)\s+(?:una\s+|ninguna\s+)?|sin\s+)(?:restricci[oó]n(?:es)?\s+m[eé]dicas?|condici[oó]n(?:es)?\s+m[eé]dicas?|limitaci[oó]n(?:es)?\s+m[eé]dicas?)\b/i);
  if (!match) return null;
  const fragment = match[0];
  const normalized = normalizeCandidateFields({ medicalRestrictions: fragment });
  return buildCurrentInboundEvidence(
    'medicalRestrictions',
    normalized.medicalRestrictions || fragment,
    'EXPLICIT_MEDICAL_RESTRICTION_EXPRESSION',
    fragment
  );
}

function resolveExplicitExperienceEvidence(raw) {
  const text = String(raw || '');
  const quantified = text.match(/\b(?:tengo|cuento\s+con|poseo)\s+(\d{1,2})\s+(a[nñ]os?|meses?)\s+de\s+experiencia(?:\s+en\s+([^.;\n]{2,80}))?/i);
  const labelled = text.match(/\bexperiencia\s*:\s*(\d{1,2})\s+(a[nñ]os?|meses?)(?:\s+en\s+([^.;\n]{2,80}))?/i);
  const match = quantified || labelled;
  if (match) {
    const fragment = trimEvidenceFragment(match[0]);
    const duration = `${match[1]} ${match[2]}`;
    const area = trimEvidenceFragment(match[3] || fragment);
    const normalized = normalizeCandidateFields({
      experienceInfo: area,
      experienceTime: duration,
      experienceSummary: fragment
    });
    return [
      buildCurrentInboundEvidence('experienceInfo', normalized.experienceInfo || area, 'EXPLICIT_EXPERIENCE_EXPRESSION', fragment),
      buildCurrentInboundEvidence('experienceTime', normalized.experienceTime || duration, 'EXPLICIT_EXPERIENCE_DURATION', fragment),
      buildCurrentInboundEvidence('experienceSummary', normalized.experienceSummary || fragment, 'EXPLICIT_EXPERIENCE_SUMMARY', fragment)
    ];
  }

  const declaration = text.match(/\b((?:no\s+)?(?:tengo|cuento\s+con|poseo)\s+experiencia(?:\s+en\s+([^.;\n]{2,80}))?)/i);
  if (!declaration) return [];
  const fragment = trimEvidenceFragment(declaration[1]);
  const area = trimEvidenceFragment(declaration[2] || fragment);
  const normalized = normalizeCandidateFields({
    experienceInfo: area,
    experienceSummary: fragment
  });
  return [
    buildCurrentInboundEvidence('experienceInfo', normalized.experienceInfo || area, 'EXPLICIT_EXPERIENCE_DECLARATION', fragment),
    buildCurrentInboundEvidence('experienceSummary', normalized.experienceSummary || fragment, 'EXPLICIT_EXPERIENCE_SUMMARY', fragment)
  ];
}

function resolveExplicitAgeEvidence(raw) {
  const match = String(raw || '').match(/\b(?:tengo\s+|edad\s*(?:es|:|-)?\s*)(\d{1,3})\s*(?:años|anos)?\b/i);
  if (!match) return null;
  const age = Number.parseInt(match[1], 10);
  if (!Number.isInteger(age) || age < 14 || age > 100) return null;
  return buildCurrentInboundEvidence('age', age, 'EXPLICIT_AGE_EXPRESSION', match[0]);
}

function resolveExplicitResidenceEvidence(raw) {
  const match = String(raw || '').match(/\b(?:vivo|resido|mi\s+barrio(?:\s+es)?|mi\s+localidad(?:\s+es)?|mi\s+residencia(?:\s+es)?|barrio\s*[:\-]|localidad\s*[:\-]|residencia\s*[:\-])\s+(?:en\s+)?([^.;\n]{2,100})/i);
  const captured = trimEvidenceFragment(match?.[1] || '');
  if (!captured) return null;
  const normalized = normalizeCandidateFields({ neighborhood: captured });
  const field = normalized.locality ? 'locality' : 'neighborhood';
  const value = normalized[field] || captured;
  return buildCurrentInboundEvidence(field, value, 'EXPLICIT_RESIDENCE_EXPRESSION', match[0]);
}

function resolveExplicitTransportEvidence(raw) {
  const match = String(raw || '').match(/\b(?:mi\s+(?:medio\s+de\s+)?transporte(?:\s+es)?|me\s+movilizo\s+en|me\s+desplazo\s+en|transporte\s*[:\-])\s+(moto|motocicleta|carro|automovil|automóvil|bicicleta|bici|bus|buseta|transporte\s+publico|transporte\s+público)\b/i);
  if (!match) return null;
  const normalized = normalizeCandidateFields({ transportMode: match[1] });
  const value = normalized.transportMode || match[1];
  return buildCurrentInboundEvidence('transportMode', value, 'EXPLICIT_TRANSPORT_EXPRESSION', match[0]);
}

export function evaluateProfileDataEvidence(text = '', options = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { containsProfileData: false, parsedFields: {}, evidence: [] };

  const localParsed = parseNaturalData(raw);
  const parsedFields = normalizeCandidateFields({
    ...localParsed,
    ...(options?.parsedFields || {})
  });
  const explicitName = resolveExplicitNameEvidence(raw);
  const evidence = [
    explicitName || resolveContextualStandaloneNameEvidence(raw, options?.candidate),
    resolveExplicitDocumentEvidence(raw),
    resolveExplicitAgeEvidence(raw),
    resolveExplicitResidenceEvidence(raw),
    resolveExplicitTransportEvidence(raw),
    resolveExplicitGenderEvidence(raw),
    resolveExplicitMedicalEvidence(raw),
    ...resolveExplicitExperienceEvidence(raw)
  ].filter(Boolean);

  return {
    containsProfileData: evidence.length > 0,
    parsedFields,
    evidence
  };
}

function containsProfileData(text = '', options = {}) {
  return evaluateProfileDataEvidence(text, options).containsProfileData;
}

function isPreConsentCaptureMode(mode = '') {
  return PRE_CONSENT_CAPTURE_MODES.has(String(mode || ''));
}

function parseAlternativeMode(mode = '') {
  const match = String(mode || '').match(ALTERNATIVE_MODE_PATTERN);
  return {
    active: Boolean(match),
    kind: match?.[1] || null,
    vacancyId: match?.[2] || null
  };
}

function isContextualInterestConfirmationMode(mode = '') {
  const value = String(mode || '');
  return value === APPLICATION_INTEREST_PENDING_MODE
    || value === PRE_CONSENT_CV_RESEND_MODE
    || PRE_CONSENT_OFFER_TO_CAPTURE_MODE.has(value)
    || isPreConsentCaptureMode(value)
    || parseAlternativeMode(value).active;
}

export function shouldRequestConsentForTurn(candidate = {}, text = '') {
  const mode = String(candidate?.botResumeMode || '');
  const turn = analyzeConversationTurn(text, { currentStep: candidate?.currentStep });
  const explicitInterest = Boolean(
    turn.interest
    || (turn.confirmation && isContextualInterestConfirmationMode(mode))
  );
  const captureAlreadyAuthorized = isPreConsentCaptureMode(mode);
  const alternativePending = parseAlternativeMode(mode).active;
  const futureProfilePending = PRE_CONSENT_OFFER_TO_CAPTURE_MODE.has(mode);
  const activeVacancyReady = Boolean(
    candidate?.vacancyId
    && !isAwaitingCampaignVacancyConfirmation(candidate)
  );

  return {
    allowed: captureAlreadyAuthorized
      || ((activeVacancyReady || alternativePending || futureProfilePending) && explicitInterest),
    explicitInterest,
    turn,
    mode
  };
}

export function buildConsentPendingMode({ resumeMode = null, cvResendRequired = false } = {}) {
  const context = {
    resumeMode: String(resumeMode || '').trim() || null,
    cvResendRequired: Boolean(cvResendRequired)
  };
  if (!context.resumeMode && !context.cvResendRequired) return DATA_CONSENT_PENDING_MODE;
  const encoded = Buffer.from(JSON.stringify(context), 'utf8').toString('base64url');
  return `${CONSENT_PENDING_CONTEXT_PREFIX}${encoded}`;
}

export function parseConsentPendingMode(mode = '') {
  const value = String(mode || '');
  if (value === DATA_CONSENT_PENDING_MODE) {
    return { pending: true, resumeMode: null, cvResendRequired: false };
  }
  if (!value.startsWith(CONSENT_PENDING_CONTEXT_PREFIX)) {
    return { pending: false, resumeMode: null, cvResendRequired: false };
  }
  try {
    const decoded = JSON.parse(Buffer.from(value.slice(CONSENT_PENDING_CONTEXT_PREFIX.length), 'base64url').toString('utf8'));
    return {
      pending: true,
      resumeMode: String(decoded?.resumeMode || '').trim() || null,
      cvResendRequired: Boolean(decoded?.cvResendRequired)
    };
  } catch {
    return { pending: true, resumeMode: null, cvResendRequired: false };
  }
}

export function evaluateConsentBoundary(candidate = {}, message = {}, options = {}) {
  if (isSupervisorPhone(message?.from || '')) return { block: false, reason: 'supervisor_message' };
  const body = inboundText(message);
  const withdrawalRequested = isExplicitConsentRevocation(body);
  if (withdrawalRequested) return { block: true, reason: 'explicit_consent_revocation' };
  if (isConsentAlreadyAccepted(candidate)) return { block: false, reason: 'consent_already_accepted' };
  if (candidate?.dataConsentStatus === 'REVOKED') return { block: true, reason: 'consent_revoked' };
  if (parseConsentPendingMode(candidate?.botResumeMode).pending) return { block: true, reason: 'consent_pending' };
  if (isPreConsentCaptureMode(candidate?.botResumeMode)) return { block: true, reason: 'capture_mode_without_consent' };
  if (isProtectedAttachment(message)) return { block: true, reason: 'attachment_before_consent' };
  if (PROTECTED_STEPS.has(candidate?.currentStep)) return { block: true, reason: 'protected_step_without_consent' };
  const profileDataDecision = options.profileDataDecision || evaluateProfileDataEvidence(body, { candidate });
  if (profileDataDecision.containsProfileData) return { block: true, reason: 'profile_data_before_consent' };
  if (shouldRequestConsentForTurn(candidate, body).allowed) {
    return { block: true, reason: 'candidate_wants_to_continue' };
  }
  return { block: false, reason: 'consent_not_required_for_this_turn' };
}

function messageIdentity(message = {}) {
  const id = String(message?.id || '').trim();
  if (id) return `id:${id}`;
  return [message?.from, message?.timestamp, message?.type]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(':');
}

export function removeHandledMessagesFromWebhook(payload = {}, handledMessages = []) {
  const handled = new Set(handledMessages.map(messageIdentity).filter(Boolean));
  if (!handled.size) return payload;

  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      const messages = change?.value?.messages;
      if (!Array.isArray(messages)) continue;
      change.value.messages = messages.filter((message) => !handled.has(messageIdentity(message)));
    }
  }
  return payload;
}

function redactSensitiveText(value = '') {
  return String(value || '')
    .replace(/(access_token=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .slice(0, 1000);
}

function safeErrorDetails(error) {
  return {
    message: redactSensitiveText(error?.message || 'unknown_error'),
    code: String(error?.code || error?.response?.data?.error?.code || '').slice(0, 80) || null,
    stack: error?.stack ? redactSensitiveText(error.stack) : null
  };
}

function inboundMessageType(message = {}) {
  if (message.type === 'document') return MessageType.DOCUMENT;
  if (message.type === 'image') return MessageType.IMAGE;
  if (message.type === 'text') return MessageType.TEXT;
  if (message.type === 'interactive') return MessageType.INTERACTIVE;
  return MessageType.UNKNOWN;
}

function redactedConsentEvidenceBody(decision = '') {
  if (decision === 'ACCEPTED') return '[CONSENT_ACCEPTED]';
  if (decision === 'REVOKED') return '[CONSENT_REVOKED]';
  return '[REDACTED_PRECONSENT]';
}

function consentGateProcessingState(message = {}) {
  return String(message?.rawPayload?.consentGateProcessing?.state || '').toUpperCase();
}

function retryableConsentGateError(error) {
  if (error && typeof error === 'object') error.code = 'CONSENT_GATE_RETRYABLE';
  return error;
}

async function saveInboundConsentEvidence(prisma, candidateId, message, body, decision) {
  const waMessageId = message?.id || null;
  const result = await persistInboundConversationMessage(prisma, {
    candidateId,
    waMessageId,
    messageType: inboundMessageType(message),
    body: redactedConsentEvidenceBody(decision),
    rawPayload: {
      source: 'data_consent_gate',
      consentVersion: DATA_CONSENT_VERSION,
      consentDecision: decision,
      waMessageId
    }
  });
  return result.created;
}

function normalizeMessagePayload(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function acquirePendingPreConsentTurn(prisma, messageRow, decision) {
  const messageId = String(messageRow?.id || '').trim();
  if (!messageId) return { claimed: false, recovering: false, messageId: null, decision };

  const pendingRawPayload = normalizeMessagePayload(messageRow.rawPayload);
  const processing = normalizeMessagePayload(pendingRawPayload.consentGateProcessing);
  const state = String(processing.state || '').toUpperCase();
  const existingDecision = String(processing.decision || '');
  if (state !== 'PENDING' || (existingDecision && existingDecision !== decision)) {
    return { claimed: false, recovering: false, messageId, decision };
  }

  const token = randomUUID();
  const processingRawPayload = {
    ...pendingRawPayload,
    consentGateProcessing: {
      ...processing,
      state: 'PROCESSING',
      decision,
      token,
      startedAt: new Date().toISOString()
    }
  };
  const claimResult = await compareAndSwapConversationMessagePayload(prisma, {
    messageId,
    expectedRawPayload: pendingRawPayload,
    rawPayload: processingRawPayload
  });
  if (!claimResult.updated) {
    return { claimed: false, recovering: false, messageId, decision };
  }

  return {
    claimed: true,
    recovering: true,
    messageId,
    decision,
    token,
    pendingRawPayload,
    processingRawPayload
  };
}

async function claimPreConsentTurn(prisma, candidateId, message, decision) {
  const waMessageId = String(message?.id || '').trim();
  if (!waMessageId) {
    const created = await saveInboundConsentEvidence(prisma, candidateId, message, '', decision);
    return { claimed: created, recovering: false, messageId: null, decision };
  }

  let existing = await findInboundConversationMessage(prisma, { candidateId, waMessageId });
  if (!existing.found) {
    try {
      await persistInboundConversationMessage(prisma, {
        candidateId,
        waMessageId,
        messageType: inboundMessageType(message),
        body: '[REDACTED_PRECONSENT]',
        rawPayload: {
          source: 'data_consent_gate',
          consentVersion: DATA_CONSENT_VERSION,
          consentDecision: decision,
          waMessageId,
          consentGateProcessing: { state: 'PENDING', decision }
        }
      });
      existing = await findInboundConversationMessage(prisma, { candidateId, waMessageId });
    } catch (error) {
      throw retryableConsentGateError(error);
    }
  }

  if (!existing.found) {
    throw retryableConsentGateError(new Error('consent_gate_claim_not_persisted'));
  }
  return acquirePendingPreConsentTurn(prisma, existing.message, decision);
}

async function completePreConsentTurn(prisma, claim) {
  if (!claim?.claimed || !claim.messageId) return;
  if (!claim.processingRawPayload) {
    throw retryableConsentGateError(new Error('consent_gate_processing_payload_missing'));
  }
  const processing = normalizeMessagePayload(claim.processingRawPayload.consentGateProcessing);
  const completedRawPayload = {
    ...claim.processingRawPayload,
    consentGateProcessing: {
      ...processing,
      state: 'COMPLETED',
      completedAt: new Date().toISOString()
    }
  };
  const result = await compareAndSwapConversationMessagePayload(prisma, {
    messageId: claim.messageId,
    expectedRawPayload: claim.processingRawPayload,
    rawPayload: completedRawPayload
  });
  if (!result.updated) {
    throw retryableConsentGateError(new Error('consent_gate_claim_completion_conflict'));
  }
  claim.processingRawPayload = completedRawPayload;
}

async function releasePreConsentTurn(prisma, claim) {
  if (!claim?.claimed || !claim.messageId || !claim.processingRawPayload) return false;
  const originalProcessing = normalizeMessagePayload(claim.pendingRawPayload?.consentGateProcessing);
  const pendingRawPayload = {
    ...normalizeMessagePayload(claim.pendingRawPayload),
    consentGateProcessing: {
      ...originalProcessing,
      state: 'PENDING',
      decision: claim.decision,
      recoveredAt: new Date().toISOString()
    }
  };
  const result = await compareAndSwapConversationMessagePayload(prisma, {
    messageId: claim.messageId,
    expectedRawPayload: claim.processingRawPayload,
    rawPayload: pendingRawPayload
  });
  if (result.updated) claim.processingRawPayload = pendingRawPayload;
  return result.updated;
}

function preConsentOutboundDedupeKey(candidateId, claim, source) {
  return createHash('sha256')
    .update([candidateId, claim?.messageId || 'no-message-id', claim?.decision || '', source].join(':'))
    .digest('hex');
}

async function sendClaimedAndStore(prisma, candidateId, to, body, source, claim, extraPayload = {}) {
  if (!claim?.messageId) {
    await sendAndStore(prisma, candidateId, to, body, source, extraPayload);
    return { suppressed: false, messageId: null };
  }

  const dedupeKey = preConsentOutboundDedupeKey(candidateId, claim, source);
  const existing = await findRecentOutboundConversationDelivery(prisma, {
    candidateId,
    body,
    dedupeKey,
    createdSince: new Date(0)
  });
  if (existing.found) {
    return { suppressed: true, messageId: existing.message?.id || null };
  }

  const startedAt = new Date();
  const intent = await persistOutboundConversationMessage(prisma, {
    candidateId,
    messageType: MessageType.TEXT,
    body,
    rawPayload: {
      source,
      body,
      consentVersion: DATA_CONSENT_VERSION,
      ...extraPayload,
      delivery: {
        state: 'SENDING',
        provider: 'META_WHATSAPP',
        startedAt: startedAt.toISOString(),
        updatedAt: startedAt.toISOString(),
        dedupeKey,
        retryPolicy: 'MANUAL_REVIEW_ONLY'
      }
    }
  });

  let providerResponse;
  try {
    providerResponse = await sendTextMessage(to, body);
  } catch (error) {
    try {
      await updateOutboundConversationDelivery(prisma, {
        messageId: intent.message.id,
        state: 'FAILED',
        occurredAt: new Date(),
        lastError: safeErrorDetails(error).message
      });
    } catch (persistenceError) {
      console.warn('[CONSENT_GATE_PROVIDER_FAILURE_PERSISTENCE]', safeErrorDetails(persistenceError));
    }
    throw retryableConsentGateError(error);
  }

  const providerMessageId = providerResponse?.messages?.[0]?.id || null;
  try {
    await prisma.candidate.update({
      where: { id: candidateId },
      data: { lastOutboundAt: new Date() }
    });
    await updateOutboundConversationDelivery(prisma, {
      messageId: intent.message.id,
      state: 'SENT',
      occurredAt: new Date(),
      providerMessageId
    });
  } catch (error) {
    throw retryableConsentGateError(error);
  }

  return { suppressed: false, messageId: intent.message.id };
}

function summarizeProfileDataEvidence(evidence = []) {
  return evidence.map((item) => ({
    field: item.field,
    source: item.source,
    rule: item.rule,
    confidence: item.confidence
  }));
}

async function saveOutboundConsentGateMessage(prisma, candidateId, body, source, extraPayload = {}) {
  await persistOutboundConversationMessage(prisma, {
    candidateId,
    messageType: MessageType.TEXT,
    body,
    rawPayload: { source, body, consentVersion: DATA_CONSENT_VERSION, ...extraPayload }
  });
  await prisma.candidate.update({ where: { id: candidateId }, data: { lastOutboundAt: new Date() } });
}

async function sendAndStore(prisma, candidateId, to, body, source, extraPayload = {}) {
  await sendTextMessage(to, body);
  await saveOutboundConsentGateMessage(prisma, candidateId, body, source, extraPayload);
}

async function loadVacancy(prisma, vacancyId) {
  if (!vacancyId) return null;
  return prisma.vacancy.findUnique({
    where: { id: vacancyId },
    include: { operation: { include: { city: true } } }
  });
}

function isVacancyOpenForApplications(vacancy = null) {
  return Boolean(vacancy?.isActive && vacancy?.acceptingApplications);
}

function vacancyCity(vacancy = {}) {
  return vacancy?.operation?.city?.name || vacancy?.city || '';
}

function vacancyTitle(vacancy = {}) {
  return vacancy?.title || vacancy?.role || 'esta vacante';
}

function vacancyLocation(vacancy = {}) {
  return vacancy?.operationAddress || vacancy?.operation?.name || vacancyCity(vacancy) || '';
}

function buildVacancyConfirmationPrompt(vacancy = {}) {
  const city = vacancyCity(vacancy);
  const place = city ? ` en ${city}` : '';
  return `Hola, soy Lórren, asistente de selección de LoginPro. ¿Escribes por la vacante de ${vacancyTitle(vacancy)}${place}? Puedes confirmarme de forma natural o decirme el cargo correcto.`;
}

function buildVacancyInfoReply(vacancy = {}) {
  const city = vacancyCity(vacancy);
  const parts = [`Perfecto, te comparto la información registrada de ${vacancyTitle(vacancy)}${city ? ` en ${city}` : ''}.`];
  if (vacancy.roleDescription) parts.push(`El cargo consiste en ${vacancy.roleDescription}.`);
  if (vacancy.operationAddress) parts.push(`Zona de operación: ${vacancy.operationAddress}.`);
  if (vacancy.requirements) parts.push(`Requisitos: ${vacancy.requirements}.`);
  if (vacancy.conditions) parts.push(`Condiciones: ${vacancy.conditions}.`);
  if (vacancy.requiredDocuments) parts.push(`Documentos para el proceso: ${vacancy.requiredDocuments}.`);
  parts.push('¿Te interesa continuar con esta postulación?');
  return parts.join('\n\n');
}

export function buildVacancyQuestionReply(vacancy = {}, text = '') {
  if (!vacancy || !isQuestionLike(text)) return '';
  const normalized = normalize(text);
  const lead = `Sobre la vacante de ${vacancyTitle(vacancy)}`;

  if (/\b(salario|sueldo|pago|cuanto pagan|cuanto es)\b/.test(normalized)) {
    return vacancy.conditions
      ? `${lead}, las condiciones registradas son: ${vacancy.conditions}.`
      : 'No tengo un salario registrado para esta vacante.';
  }
  if (/\b(horario|turno|jornada|contrato|prestacion|beneficio|condicion)\b/.test(normalized)) {
    return vacancy.conditions
      ? `${lead}, las condiciones registradas son: ${vacancy.conditions}.`
      : 'No tengo esas condiciones registradas para esta vacante.';
  }
  if (/\b(requisito|perfil|edad|experiencia|estudio|formacion|documento|moto|carro|transporte|vehiculo)\b/.test(normalized)) {
    const parts = [];
    if (vacancy.requirements) parts.push(vacancy.requirements);
    if (vacancy.requiredDocuments && /\bdocumento\b/.test(normalized)) parts.push(`Documentos: ${vacancy.requiredDocuments}`);
    return parts.length
      ? `${lead}, los requisitos registrados son: ${parts.join('. ')}.`
      : 'No tengo ese requisito registrado para esta vacante.';
  }
  if (/\b(funcion|funciones|labor|hacer|cargo|rol|consiste|tarea|tareas|responsabilidad|responsabilidades)\b/.test(normalized)) {
    return vacancy.roleDescription
      ? `${lead}, el cargo consiste en ${vacancy.roleDescription}.`
      : `El cargo registrado es ${vacancyTitle(vacancy)}, pero no tengo una descripción adicional.`;
  }
  if (/\b(donde|direccion|ubicacion|zona|sector|queda)\b/.test(normalized)) {
    const location = vacancyLocation(vacancy);
    return location
      ? `${lead}, la ubicación registrada es ${location}.`
      : 'No tengo una ubicación específica registrada para esta vacante.';
  }
  return 'No tengo ese dato registrado en la vacante. Puedo continuar con la información disponible.';
}

export function buildConsentAcceptedReply(candidate = {}, vacancy = null, options = {}) {
  const dataPrompt = buildCandidateDataCollectionMessage(candidate, vacancy);
  const parts = ['Gracias, tu autorización quedó registrada.'];
  if (dataPrompt) parts.push(dataPrompt);
  if (options.cvResendRequired) parts.push(RESEND_CV_REPLY);
  if (!dataPrompt && !options.cvResendRequired) parts.push('Continuemos con tu postulación.');
  return parts.join(' ');
}

export function deriveConsentResumeUpdate(resumeMode = null) {
  const alternative = parseAlternativeMode(resumeMode);
  if (alternative.active && alternative.vacancyId) {
    return {
      vacancyId: alternative.vacancyId,
      currentStep: ConversationStep.COLLECTING_DATA,
      botResumeMode: null
    };
  }

  const captureMode = PRE_CONSENT_OFFER_TO_CAPTURE_MODE.get(String(resumeMode || ''));
  if (captureMode) {
    return {
      currentStep: ConversationStep.COLLECTING_DATA,
      botResumeMode: captureMode
    };
  }

  if (isPreConsentCaptureMode(resumeMode)) {
    return {
      currentStep: ConversationStep.COLLECTING_DATA,
      botResumeMode: resumeMode
    };
  }
  return {
    currentStep: ConversationStep.COLLECTING_DATA,
    botResumeMode: null
  };
}

export async function resolveConsentResumeContext(prisma, resumeMode = null) {
  const alternative = parseAlternativeMode(resumeMode);
  if (!alternative.active || !alternative.vacancyId) {
    return {
      resumeUpdate: deriveConsentResumeUpdate(resumeMode),
      vacancy: null,
      alternativeUnavailable: false,
      requestedVacancyId: null
    };
  }

  const vacancy = await loadVacancy(prisma, alternative.vacancyId);
  if (!isVacancyOpenForApplications(vacancy)) {
    return {
      resumeUpdate: {
        vacancyId: null,
        currentStep: ConversationStep.GREETING_SENT,
        botResumeMode: null
      },
      vacancy: null,
      alternativeUnavailable: true,
      requestedVacancyId: alternative.vacancyId
    };
  }

  return {
    resumeUpdate: deriveConsentResumeUpdate(resumeMode),
    vacancy,
    alternativeUnavailable: false,
    requestedVacancyId: alternative.vacancyId
  };
}

async function recordConsent(prisma, req, candidate, status, resumeUpdate = {}) {
  const now = new Date();
  const accepted = status === 'ACCEPTED';
  const result = await recordCandidateDataConsent(prisma, {
    candidateId: candidate.id,
    status,
    version: DATA_CONSENT_VERSION,
    text: DATA_CONSENT_TEXT,
    source: 'WHATSAPP_CANDIDATE',
    actorUsername: 'candidate_whatsapp',
    ipAddress: req.ip || null,
    userAgent: req.headers['user-agent'] || null,
    note: accepted ? 'Aceptación registrada por respuesta de WhatsApp.' : 'Revocatoria registrada por respuesta de WhatsApp.',
    candidatePatch: {
      currentStep: accepted ? ConversationStep.COLLECTING_DATA : ConversationStep.DONE,
      status: accepted ? candidate.status : CandidateStatus.NUEVO,
      botResumeMode: null,
      lastInboundAt: now,
      ...(accepted ? resumeUpdate : {})
    },
    expected: { currentStep: candidate.currentStep },
    now
  });
  return result;
}

async function handleCampaignVacancyConfirmation(prisma, candidate, message, from, body) {
  const vacancy = await loadVacancy(prisma, candidate.vacancyId);
  if (!vacancy) {
    await prisma.candidate.update({ where: { id: candidate.id }, data: { botResumeMode: null, vacancyId: null } });
    await sendAndStore(prisma, candidate.id, from, VACANCY_NOT_CONFIRMED_REPLY, 'campaign_vacancy_missing');
    return true;
  }

  if (isProtectedAttachment(message)) {
    await prisma.candidate.update({ where: { id: candidate.id }, data: { botResumeMode: CAMPAIGN_CONFIRMATION_CV_MODE } });
    const reply = `${PRE_CONSENT_ATTACHMENT_REPLY}\n\n${buildVacancyConfirmationPrompt(vacancy)}`;
    await sendAndStore(prisma, candidate.id, from, reply, 'pre_consent_attachment_vacancy_pending', { vacancyId: vacancy.id, cvResendRequired: true });
    return true;
  }

  const questionReply = buildVacancyQuestionReply(vacancy, body);
  if (isAffirmativeVacancyConfirmation(body)) {
    const cvResendRequired = candidate.botResumeMode === CAMPAIGN_CONFIRMATION_CV_MODE;
    await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        currentStep: ConversationStep.GREETING_SENT,
        botResumeMode: cvResendRequired ? PRE_CONSENT_CV_RESEND_MODE : APPLICATION_INTEREST_PENDING_MODE
      }
    });
    const reply = [questionReply, buildVacancyInfoReply(vacancy)].filter(Boolean).join('\n\n');
    await sendAndStore(prisma, candidate.id, from, reply, 'campaign_vacancy_confirmed', { vacancyId: vacancy.id, cvResendRequired });
    return true;
  }

  if (isNegativeVacancyConfirmation(body)) {
    await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.GREETING_SENT, botResumeMode: null, vacancyId: null } });
    await sendAndStore(prisma, candidate.id, from, VACANCY_NOT_CONFIRMED_REPLY, 'campaign_vacancy_rejected', { previousVacancyId: vacancy.id });
    return true;
  }

  const reply = [questionReply, buildVacancyConfirmationPrompt(vacancy)].filter(Boolean).join('\n\n');
  await sendAndStore(prisma, candidate.id, from, reply, 'campaign_vacancy_confirmation_prompt', { vacancyId: vacancy.id });
  return true;
}

function getConsentContext(candidate = {}) {
  const pending = parseConsentPendingMode(candidate.botResumeMode);
  if (pending.pending) return pending;
  const mode = String(candidate.botResumeMode || '');
  if (mode === APPLICATION_INTEREST_PENDING_MODE) {
    return { pending: false, resumeMode: null, cvResendRequired: false };
  }
  return {
    pending: false,
    resumeMode: mode === PRE_CONSENT_CV_RESEND_MODE ? null : (mode || null),
    cvResendRequired: mode === PRE_CONSENT_CV_RESEND_MODE
  };
}

function buildConsentPrerequisiteReply(candidate = {}, vacancy = null, boundaryReason = '') {
  const preface = boundaryReason === 'attachment_before_consent'
    ? PRE_CONSENT_ATTACHMENT_REPLY
    : (boundaryReason === 'profile_data_before_consent' ? PRE_CONSENT_DATA_REPLY : null);
  const next = candidate?.vacancyId || vacancy
    ? APPLICATION_INTEREST_REQUIRED_REPLY
    : VACANCY_NOT_CONFIRMED_REPLY;
  return [preface, next].filter(Boolean).join('\n\n');
}

async function handleConsentPrerequisite(prisma, candidate, message, from, vacancy, boundaryReason, profileDataEvidence = []) {
  const hasVacancy = Boolean(candidate?.vacancyId || vacancy?.id);
  const nextMode = hasVacancy
    ? (isProtectedAttachment(message) ? PRE_CONSENT_CV_RESEND_MODE : APPLICATION_INTEREST_PENDING_MODE)
    : null;
  const nextStep = hasVacancy || PROTECTED_STEPS.has(candidate.currentStep)
    ? ConversationStep.GREETING_SENT
    : candidate.currentStep;
  const shouldClaim = boundaryReason === 'profile_data_before_consent'
    || boundaryReason === 'attachment_before_consent';
  let claim = null;
  if (shouldClaim) {
    claim = await claimPreConsentTurn(prisma, candidate.id, message, `PREREQUISITE_${boundaryReason}`);
    if (!claim.claimed) return true;
  }

  try {
    const update = {};
    if (candidate.currentStep !== nextStep) update.currentStep = nextStep;
    if (String(candidate.botResumeMode || '') !== String(nextMode || '')) update.botResumeMode = nextMode;
    if (Object.keys(update).length) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: update });
    }

    const passRecoveredVacancyContext = Boolean(
      !hasVacancy
      && boundaryReason === 'protected_step_without_consent'
      && !isProtectedAttachment(message)
      && !containsProfileData(inboundText(message), { candidate })
    );
    if (passRecoveredVacancyContext) return false;

    const reply = buildConsentPrerequisiteReply(candidate, vacancy, boundaryReason);
    const outboundPayload = {
      reason: boundaryReason,
      vacancyId: vacancy?.id || candidate?.vacancyId || null,
      nextMode,
      ...(profileDataEvidence.length ? { profileDataEvidence: summarizeProfileDataEvidence(profileDataEvidence) } : {})
    };
    if (claim?.claimed) {
      await sendClaimedAndStore(
        prisma,
        candidate.id,
        from,
        reply,
        'data_consent_prerequisite',
        claim,
        outboundPayload
      );
    } else {
      await sendAndStore(prisma, candidate.id, from, reply, 'data_consent_prerequisite', outboundPayload);
    }
    await completePreConsentTurn(prisma, claim);
    return true;
  } catch (error) {
    if (claim?.claimed) {
      try {
        await releasePreConsentTurn(prisma, claim);
      } catch (releaseError) {
        console.warn('[CONSENT_GATE_CLAIM_RELEASE_ERROR]', safeErrorDetails(releaseError));
      }
      throw retryableConsentGateError(error);
    }
    throw error;
  }
}

async function handleConsentDecision(prisma, req, candidate, message, from, body, boundaryReason, profileDataEvidence = []) {
  const context = getConsentContext(candidate);
  let vacancy = await loadVacancy(prisma, candidate.vacancyId);
  const consentTurn = shouldRequestConsentForTurn(candidate, body);
  const consentEligible = context.pending || consentTurn.allowed;

  if (candidate?.dataConsentStatus === 'REVOKED') return true;

  if (isProtectedAttachment(message)) {
    if (!consentEligible) {
      return handleConsentPrerequisite(prisma, candidate, message, from, vacancy, boundaryReason, profileDataEvidence);
    }
    const botResumeMode = buildConsentPendingMode({
      resumeMode: context.resumeMode,
      cvResendRequired: true
    });
    await prisma.candidate.update({ where: { id: candidate.id }, data: { botResumeMode } });
    const claimed = await saveInboundConsentEvidence(
      prisma,
      candidate.id,
      message,
      body,
      context.pending ? 'PENDING_ATTACHMENT' : 'PROMPTED_WITH_ATTACHMENT'
    );
    if (!claimed || context.pending) return true;
    const reply = `${PRE_CONSENT_ATTACHMENT_REPLY}\n\n${CONSENT_PROMPT}`;
    await sendAndStore(prisma, candidate.id, from, reply, 'pre_consent_attachment_rejected', {
      reason: boundaryReason,
      vacancyId: vacancy?.id || null,
      cvResendRequired: true
    });
    return true;
  }

  const questionReply = buildConsentQuestionReply(body) || buildVacancyQuestionReply(vacancy, body);

  if (shouldRecordConsentRejection(body, { consentPromptPending: context.pending })) {
    const claimed = await saveInboundConsentEvidence(prisma, candidate.id, message, body, 'REVOKED');
    if (!claimed) return true;
    const consentResult = await recordConsent(prisma, req, candidate, 'REVOKED');
    if (consentResult.conflict) {
      console.warn('[CONSENT_STEP_CONFLICT]', {
        candidateId: candidate.id,
        expectedStep: candidate.currentStep,
        observedStep: consentResult.candidate?.currentStep || null,
        status: 'REVOKED'
      });
      return true;
    }
    await cancelReminderOnInbound(prisma, candidate.id);
    await cancelActiveInterviewBookings(prisma, { candidateId: candidate.id });
    await sendAndStore(prisma, candidate.id, from, CONSENT_REVOKED_REPLY, 'data_consent_revoked');
    return true;
  }

  if (context.pending && shouldRecordConsentAcceptance(body, { consentPromptPending: true })) {
    const claimed = await saveInboundConsentEvidence(prisma, candidate.id, message, body, 'ACCEPTED');
    if (!claimed) return true;
    const resumeContext = await resolveConsentResumeContext(prisma, context.resumeMode);
    const consentResult = await recordConsent(prisma, req, candidate, 'ACCEPTED', resumeContext.resumeUpdate);
    if (consentResult.conflict) {
      console.warn('[CONSENT_STEP_CONFLICT]', {
        candidateId: candidate.id,
        expectedStep: candidate.currentStep,
        observedStep: consentResult.candidate?.currentStep || null,
        status: 'ACCEPTED'
      });
      return true;
    }
    const consentedCandidate = consentResult.candidate;

    if (resumeContext.alternativeUnavailable) {
      const reply = [questionReply, ALTERNATIVE_VACANCY_UNAVAILABLE_REPLY].filter(Boolean).join('\n\n');
      await sendAndStore(prisma, candidate.id, from, reply, 'data_consent_accepted_alternative_unavailable', {
        resumedMode: context.resumeMode,
        requestedVacancyId: resumeContext.requestedVacancyId,
        cvResendRequired: context.cvResendRequired
      });
      return true;
    }

    vacancy = resumeContext.vacancy || await loadVacancy(prisma, consentedCandidate?.vacancyId || candidate.vacancyId);

    let captured = { candidate: consentedCandidate, capturedFields: [] };
    try {
      captured = await captureConsentedProfileData({
        prisma,
        candidate: consentedCandidate,
        vacancy,
        currentText: body
      });
    } catch (error) {
      console.warn('[CONSENTED_PROFILE_CAPTURE_ERROR]', safeErrorDetails(error));
    }

    const acceptedCandidate = captured.candidate || consentedCandidate;
    const reply = [
      questionReply,
      buildConsentAcceptedReply(acceptedCandidate, vacancy, { cvResendRequired: context.cvResendRequired })
    ].filter(Boolean).join('\n\n');
    await sendAndStore(prisma, candidate.id, from, reply, 'data_consent_accepted', {
      capturedFields: captured.capturedFields || [],
      resumedMode: context.resumeMode,
      cvResendRequired: context.cvResendRequired
    });
    return true;
  }

  if (context.pending) {
    const claimed = await saveInboundConsentEvidence(
      prisma,
      candidate.id,
      message,
      body,
      questionReply ? 'PENDING_QUESTION' : 'PENDING_NO_REPLY'
    );
    if (!claimed || !questionReply) return true;
    const reply = [questionReply, CONSENT_CLARIFIER_REPLY].filter(Boolean).join('\n\n');
    await sendAndStore(prisma, candidate.id, from, reply, 'data_consent_pending_question', {
      resumedMode: context.resumeMode,
      cvResendRequired: context.cvResendRequired
    });
    return true;
  }

  if (!consentEligible) {
    return handleConsentPrerequisite(prisma, candidate, message, from, vacancy, boundaryReason, profileDataEvidence);
  }

  const botResumeMode = buildConsentPendingMode({
    resumeMode: context.resumeMode,
    cvResendRequired: context.cvResendRequired
  });
  await prisma.candidate.update({ where: { id: candidate.id }, data: { botResumeMode } });
  const claimed = await saveInboundConsentEvidence(prisma, candidate.id, message, body, 'PROMPTED');
  if (!claimed) return true;
  const preface = boundaryReason === 'profile_data_before_consent' ? PRE_CONSENT_DATA_REPLY : null;
  const reply = [questionReply, preface, CONSENT_PROMPT].filter(Boolean).join('\n\n');
  await sendAndStore(prisma, candidate.id, from, reply, 'data_consent_prompt', {
    reason: boundaryReason,
    resumeMode: context.resumeMode,
    cvResendRequired: context.cvResendRequired,
    ...(profileDataEvidence.length ? { profileDataEvidence: summarizeProfileDataEvidence(profileDataEvidence) } : {})
  });
  return true;
}

async function notifyConsentGateFailure(messages = []) {
  const recipients = [...new Set(
    messages
      .map((message) => message?.from)
      .filter((from) => from && !isSupervisorPhone(from))
  )];
  await Promise.allSettled(recipients.map((to) => sendTextMessage(to, CONSENT_GATE_ERROR_REPLY)));
}

async function preparePausedCandidateForConsentGate(prisma, candidate = {}, message = {}) {
  if (!candidate?.botPaused) {
    return { candidate, blocked: false, consume: false, defer: false, retry: false, reason: 'automation_not_paused' };
  }

  const waMessageId = String(message?.id || '').trim();
  let existingMessage = null;
  if (waMessageId) {
    const existing = await findInboundConversationMessage(prisma, {
      candidateId: candidate.id,
      waMessageId
    });
    existingMessage = existing.message || null;
    if (existing.found && consentGateProcessingState(existing.message) !== 'PENDING') {
      return { candidate, blocked: true, consume: true, defer: false, retry: false, reason: 'paused_inbound_retry' };
    }
  }

  const profileDataDecision = evaluateProfileDataEvidence(inboundText(message), { candidate });
  const protectedBeforeConsent = !isConsentAlreadyAccepted(candidate)
    && (isProtectedAttachment(message) || profileDataDecision.containsProfileData);
  if (protectedBeforeConsent) {
    let claim = null;
    try {
      const decision = isProtectedAttachment(message)
        ? 'PAUSED_PRECONSENT_ATTACHMENT'
        : 'PAUSED_PRECONSENT_PROFILE_DATA';
      claim = await claimPreConsentTurn(prisma, candidate.id, message, decision);
      if (!claim.claimed && existingMessage) {
        return { candidate, blocked: true, consume: true, defer: false, retry: false, reason: 'paused_inbound_retry' };
      }
      await completePreConsentTurn(prisma, claim);
    } catch (error) {
      if (claim?.claimed) {
        try {
          await releasePreConsentTurn(prisma, claim);
        } catch (releaseError) {
          console.warn('[PAUSED_PRECONSENT_CLAIM_RELEASE_ERROR]', safeErrorDetails(releaseError));
        }
      }
      console.warn('[PAUSED_PRECONSENT_ATTACHMENT_PERSISTENCE_ERROR]', safeErrorDetails(error));
      return {
        candidate,
        blocked: true,
        consume: false,
        defer: false,
        retry: true,
        reason: 'paused_preconsent_attachment_persistence_error'
      };
    }
    return {
      candidate,
      blocked: true,
      consume: true,
      defer: false,
      retry: false,
      reason: isProtectedAttachment(message)
        ? 'paused_preconsent_attachment_consumed'
        : 'paused_preconsent_profile_data_consumed'
    };
  }

  return {
    candidate,
    blocked: false,
    consume: false,
    defer: true,
    retry: false,
    reason: 'paused_inbound_deferred_to_router'
  };
}

export function dataConsentGateMiddleware(prisma) {
  return async (req, res, next) => {
    const messages = extractMessages(req.body);
    if (!messages.length) return next();

    try {
      const handledMessages = [];

      for (const message of messages) {
        const from = message?.from;
        if (!from || isSupervisorPhone(from)) continue;

        let candidate = await prisma.candidate.upsert({
          where: { phone: from },
          update: {},
          create: { phone: from }
        });
        const body = inboundText(message);
        const withdrawalRequested = isExplicitConsentRevocation(body);

        if (candidate?.dataConsentStatus === 'REVOKED' && withdrawalRequested) {
          await saveInboundConsentEvidence(prisma, candidate.id, message, body, 'REVOKED');
          handledMessages.push(message);
          continue;
        }

        if (withdrawalRequested) {
          if (await handleConsentDecision(prisma, req, candidate, message, from, body, 'explicit_consent_revocation')) {
            handledMessages.push(message);
          }
          continue;
        }

        const pauseDecision = await preparePausedCandidateForConsentGate(prisma, candidate, message);
        candidate = pauseDecision.candidate || candidate;
        if (pauseDecision.retry) return res.sendStatus(503);
        if (pauseDecision.blocked) {
          if (pauseDecision.consume) handledMessages.push(message);
          continue;
        }
        if (pauseDecision.defer) continue;

        if (isAwaitingCampaignVacancyConfirmation(candidate)) {
          if (await handleCampaignVacancyConfirmation(prisma, candidate, message, from, body)) handledMessages.push(message);
          continue;
        }

        const profileDataDecision = evaluateProfileDataEvidence(body, { candidate });
        const boundary = evaluateConsentBoundary(candidate, message, { profileDataDecision });
        if (boundary.block && await handleConsentDecision(
          prisma,
          req,
          candidate,
          message,
          from,
          body,
          boundary.reason,
          profileDataDecision.evidence
        )) {
          handledMessages.push(message);
        }
      }

      removeHandledMessagesFromWebhook(req.body, handledMessages);
      if (handledMessages.length < messages.length) return next();
      return res.sendStatus(200);
    } catch (error) {
      console.warn('[DATA_CONSENT_GATE_ERROR]', safeErrorDetails(error));
      if (error?.code === 'CONSENT_GATE_RETRYABLE') return res.sendStatus(503);
      await notifyConsentGateFailure(messages);
      return res.sendStatus(200);
    }
  };
}
