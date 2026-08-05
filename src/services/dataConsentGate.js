import { CandidateStatus, ConversationStep, MessageType } from '@prisma/client';
import { extractMessages, sendTextMessage } from './whatsapp.js';
import { buildCandidateDataCollectionMessage } from './readinessGuard.js';
import {
  isHighConfidenceLocalField,
  normalizeCandidateFields,
  parseNaturalData
} from './candidateData.js';
import { analyzeConversationTurn } from './conversationIntent.js';
import { captureConsentedProfileData } from './consentProfileCapture.js';
import { buildConsentQuestionReply } from './consentFaq.js';
import { isSupervisorPhone } from './adminSupervisor.js';
import { shouldResumeAutomationOnInbound } from './botAutomationPolicy.js';
import { resumeCandidateAutomationOnInbound } from './candidateStateService.js';
import { recordCandidateDataConsent } from './consentStateService.js';
import { cancelActiveInterviewBookings } from './interviewBookingStateService.js';
import { cancelReminderOnInbound } from './reminder.js';
import {
  findInboundConversationMessage,
  persistInboundConversationMessage,
  persistOutboundConversationMessage
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

const PROFILE_DATA_FIELDS = new Set([
  'fullName',
  'documentType',
  'documentNumber',
  'age',
  'gender',
  'neighborhood',
  'locality',
  'medicalRestrictions',
  'transportMode',
  'experienceInfo',
  'experienceTime',
  'experienceSummary'
]);

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

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
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

function isConsentRightsQuestion(text = '') {
  const raw = String(text || '').trim();
  const normalized = normalize(raw);
  if (!normalized) return false;
  if (startsWithExplicitConsentRejection(normalized)) return false;
  if (/^(solicito|pido|exijo|quiero que|deseo que|por favor)\b/.test(normalized)) return false;
  if (/^(eliminen|elimine|borren|borre|supriman|suprima|cancelen|cancele|detengan|detenga|paren|pare|revoquen|revoque|retiren|retire)\b/.test(normalized)) return false;
  return raw.includes('?') || /^(como|como puedo|puedo|podria|que debo|cual es|donde)\b/.test(normalized);
}

function isExplicitConsentRevocation(text = '') {
  const normalized = normalize(text);
  if (!normalized || isConsentRightsQuestion(text)) return false;
  if (startsWithExplicitConsentRejection(normalized) && referencesConsentSubject(normalized)) return true;
  return hasAny(normalized, [
    /\b(cancelar|cancelen|cancele|detener|detengan|detenga|parar|paren|pare)\b.*\b(postulacion|proceso|tratamiento|datos)\b/,
    /\b(eliminar|eliminen|elimine|borrar|borren|borre|suprimir|supriman|suprima)\b.*\b(datos|informacion|registro)\b/,
    /\b(revocar|revoco|revoquen|revoque|retiro|retirar|retiren|retire)\b.*\b(autorizacion|consentimiento|tratamiento|datos)\b/,
    /\b(solicito|pido|exijo|quiero|deseo)\b.*\b(revocatoria|revocacion|revocar|retirar|eliminar|borrar|suprimir|cancelar|detener)\b.*\b(autorizacion|consentimiento|tratamiento|datos|informacion|registro|proceso|postulacion)\b/,
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

function hasExplicitNameEvidence(text = '', fullName = '') {
  const raw = String(text || '');
  if (/\b(me llamo|mi nombre(?: completo)?(?: es)?|nombre(?: completo)?\s*[:\-])\b/i.test(raw)) return true;

  const normalizedText = normalize(raw);
  const normalizedName = normalize(fullName);
  if (!normalizedName) return false;

  const tokens = normalizedName.split(' ').filter(Boolean);
  if (tokens.length < 2 || tokens.length > 6 || NON_NAME_INTRODUCTION_PATTERN.test(normalizedName)) return false;

  return normalizedText === normalizedName || normalizedText.startsWith(`soy ${normalizedName}`);
}

function hasExplicitGenderEvidence(text = '') {
  return hasAny(String(text || ''), [
    /\b(?:soy|me considero|me identifico como)\s+(?:un|una)?\s*(?:mujer|hombre|femenin[ao]|masculin[ao])\b/i,
    /\b(?:sexo|genero|género)\s*(?:es|:)?\s*(?:mujer|hombre|femenin[ao]|masculin[ao])\b/i
  ]);
}

function containsProfileData(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return false;

  const normalized = normalizeCandidateFields(parseNaturalData(raw));
  const acceptedFields = Object.entries(normalized).filter(([field, value]) => {
    if (!PROFILE_DATA_FIELDS.has(field) || !hasValue(value)) return false;
    if (field === 'fullName' && !hasExplicitNameEvidence(raw, value)) return false;
    if (field === 'gender' && !hasExplicitGenderEvidence(raw)) return false;
    return isHighConfidenceLocalField(field, value);
  });

  return acceptedFields.length > 0;
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

export function evaluateConsentBoundary(candidate = {}, message = {}) {
  if (isSupervisorPhone(message?.from || '')) return { block: false, reason: 'supervisor_message' };
  const body = inboundText(message);
  const withdrawalRequested = isExplicitConsentRevocation(body)
    || (isConsentAlreadyAccepted(candidate) && hasExplicitConsentRejection(body));
  if (withdrawalRequested) return { block: true, reason: 'explicit_consent_revocation' };
  if (isConsentAlreadyAccepted(candidate)) return { block: false, reason: 'consent_already_accepted' };
  if (candidate?.dataConsentStatus === 'REVOKED') return { block: true, reason: 'consent_revoked' };
  if (parseConsentPendingMode(candidate?.botResumeMode).pending) return { block: true, reason: 'consent_pending' };
  if (isPreConsentCaptureMode(candidate?.botResumeMode)) return { block: true, reason: 'capture_mode_without_consent' };
  if (isProtectedAttachment(message)) return { block: true, reason: 'attachment_before_consent' };
  if (PROTECTED_STEPS.has(candidate?.currentStep)) return { block: true, reason: 'protected_step_without_consent' };
  if (containsProfileData(body)) return { block: true, reason: 'profile_data_before_consent' };
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

async function saveInboundConsentEvidence(prisma, candidateId, message, body, decision) {
  const waMessageId = message?.id || null;
  const result = await persistInboundConversationMessage(prisma, {
    candidateId,
    waMessageId,
    messageType: inboundMessageType(message),
    body,
    rawPayload: {
      source: 'data_consent_gate',
      consentVersion: DATA_CONSENT_VERSION,
      consentDecision: decision,
      waMessageId
    }
  });
  return result.created;
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

async function handleConsentPrerequisite(prisma, candidate, message, from, vacancy, boundaryReason) {
  const hasVacancy = Boolean(candidate?.vacancyId || vacancy?.id);
  const nextMode = hasVacancy
    ? (isProtectedAttachment(message) ? PRE_CONSENT_CV_RESEND_MODE : APPLICATION_INTEREST_PENDING_MODE)
    : null;
  const nextStep = hasVacancy || PROTECTED_STEPS.has(candidate.currentStep)
    ? ConversationStep.GREETING_SENT
    : candidate.currentStep;
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
    && !containsProfileData(inboundText(message))
  );
  if (passRecoveredVacancyContext) return false;

  const reply = buildConsentPrerequisiteReply(candidate, vacancy, boundaryReason);
  await sendAndStore(prisma, candidate.id, from, reply, 'data_consent_prerequisite', {
    reason: boundaryReason,
    vacancyId: vacancy?.id || candidate?.vacancyId || null,
    nextMode
  });
  return true;
}

async function handleConsentDecision(prisma, req, candidate, message, from, body, boundaryReason) {
  const context = getConsentContext(candidate);
  let vacancy = await loadVacancy(prisma, candidate.vacancyId);
  const consentTurn = shouldRequestConsentForTurn(candidate, body);
  const consentEligible = context.pending || consentTurn.allowed;

  if (candidate?.dataConsentStatus === 'REVOKED') return true;

  if (isProtectedAttachment(message)) {
    if (!consentEligible) {
      return handleConsentPrerequisite(prisma, candidate, message, from, vacancy, boundaryReason);
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
    return handleConsentPrerequisite(prisma, candidate, message, from, vacancy, boundaryReason);
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
    cvResendRequired: context.cvResendRequired
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
    return { candidate, blocked: false, consume: false, reason: 'automation_not_paused' };
  }

  const waMessageId = String(message?.id || '').trim();
  if (waMessageId) {
    const existing = await findInboundConversationMessage(prisma, {
      candidateId: candidate.id,
      waMessageId
    });
    if (existing.found) {
      return { candidate, blocked: true, consume: true, reason: 'paused_inbound_retry' };
    }
  }

  if (!waMessageId || !shouldResumeAutomationOnInbound(candidate)) {
    return { candidate, blocked: true, consume: false, reason: 'automation_pause_not_resumable_here' };
  }

  const transition = await resumeCandidateAutomationOnInbound(prisma, {
    candidateId: candidate.id,
    expected: {
      botPaused: candidate.botPaused,
      botPausedAt: candidate.botPausedAt ?? null,
      botPausedBy: candidate.botPausedBy ?? null,
      botPauseReason: candidate.botPauseReason ?? null,
      botResumeMode: candidate.botResumeMode ?? null
    },
    now: new Date()
  });

  const resumedCandidate = transition.candidate || candidate;
  if (transition.count !== 1 || resumedCandidate.botPaused) {
    return { candidate: resumedCandidate, blocked: true, consume: false, reason: 'automation_resume_conflict' };
  }

  return { candidate: resumedCandidate, blocked: false, consume: false, reason: 'automation_resumed_on_new_inbound' };
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
        const withdrawalRequested = isExplicitConsentRevocation(body)
          || (candidate?.dataConsentStatus === 'ACCEPTED' && hasExplicitConsentRejection(body));

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
        if (pauseDecision.blocked) {
          if (pauseDecision.consume) handledMessages.push(message);
          continue;
        }

        if (isAwaitingCampaignVacancyConfirmation(candidate)) {
          if (await handleCampaignVacancyConfirmation(prisma, candidate, message, from, body)) handledMessages.push(message);
          continue;
        }

        const boundary = evaluateConsentBoundary(candidate, message);
        if (boundary.block && await handleConsentDecision(prisma, req, candidate, message, from, body, boundary.reason)) {
          handledMessages.push(message);
        }
      }

      removeHandledMessagesFromWebhook(req.body, handledMessages);
      if (handledMessages.length < messages.length) return next();
      return res.sendStatus(200);
    } catch (error) {
      console.warn('[DATA_CONSENT_GATE_ERROR]', safeErrorDetails(error));
      await notifyConsentGateFailure(messages);
      return res.sendStatus(200);
    }
  };
}