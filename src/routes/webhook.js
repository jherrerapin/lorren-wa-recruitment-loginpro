import express from 'express';
import { CandidateStatus, ConversationStep, MessageDirection, MessageType } from '@prisma/client';
import { extractMessages, sendImageMessage, sendTextMessage } from '../services/whatsapp.js';
import { fetchMediaMetadata, downloadMedia } from '../services/media.js';
import { tryOpenAIParse } from '../services/aiParser.js';
import {
  applyEnginePreviewPlanReuse,
  buildEnginePreviewTrace,
  createDebugTrace,
  inferIntent,
  sanitizeForRawPayload,
  splitFieldDecisions,
  summarizeError
} from '../services/debugTrace.js';
import { isCvMimeTypeAllowed, looksLikeCvFilenameText, resolveStepAfterDataCompletion, shouldFinalizeAfterCv } from '../services/cvFlow.js';
import {
  alignCandidateLocationFields,
  getCandidateResidenceValue,
  getResidenceFieldConfig,
  hasMeaningfulCandidateData,
  looksLikeNoMedicalRestrictionsText,
  normalizeCandidateFields,
  parseNaturalData
} from '../services/candidateData.js';
import { consolidateTextMessages, getMultilineWindowMs, summarizeConsolidatedInput } from '../services/multiline.js';
import { cancelReminderOnInbound, scheduleReminderForCandidate } from '../services/reminder.js';
import { detectConversationIntent, isPostCompletionAck } from '../services/conversationIntent.js';
import { conversationUnderstanding } from '../services/conversationUnderstanding.js';
import { shouldBlockAutomation, shouldResumeAutomationOnInbound } from '../services/botAutomationPolicy.js';
import {
  acquireCandidateMultilineBatch,
  applyCandidateSilentProfileCapture,
  applyCandidateVacancyFirstGateDecision,
  pauseCandidateAutomationForManualReview,
  reflectCandidateInterviewCancellationReminder,
  reflectCandidateInterviewRescheduleProgress,
  resumeCandidateAutomationOnInbound,
  scheduleCandidateMultilineWindow
} from '../services/candidateStateService.js';
import { runChatEngine } from '../services/chatEngine.js';
import { think, extractEngineCandidateFields, prepareEngineDecisionContext } from '../services/conversationEngine.js';
import { storeCandidateCv } from '../services/cvStorage.js';
import { applyFieldPolicy } from '../services/policyLayer.js';
import { analyzeAttachment } from '../services/attachmentAnalyzer.js';
import { buildContextualReply, deriveAttachmentDecision, shouldEscalateHumanReview } from '../services/contextualReply.js';
import { isFeatureEnabled } from '../services/featureFlags.js';
import { enqueueJob, JOB_TYPES } from '../services/jobQueue.js';
import { findActiveVacancies, findAllVacancies, normalizeResolverText, resolveVacancyFromText } from '../services/vacancyResolver.js';
import { createBooking, formatInterviewDate, getNextAvailableSlot, getNextAvailableSlotAfter, getInterviewReminderAt, hydrateOfferedSlot } from '../services/interviewScheduler.js';
import { detectInterviewIntent } from '../services/interviewLifecycle.js';
import { applyInterviewReminderResponse } from '../services/interviewBookingStateService.js';
import {
  buildInterviewAttendanceConfirmedReply,
  buildInterviewCancellationReply,
  buildInterviewDocumentsSentence,
  buildUnavailableVacancyInfoReply,
  buildVacancyOptionsReply,
  generateBookingConfirmation,
  generateInterviewOffer,
  sanitizeRequiredDocumentsForBot
} from '../services/naturalReply.js';
import { sanitizeOutboundReply, buildSafeFallbackReply } from '../services/replySafety.js';
import { appendUniqueReplySegment } from '../services/replyComposition.js';
import { buildCandidateDataCollectionMessage, evaluateCandidateEligibility, getCandidateReadiness, getFieldLabel as getReadinessFieldLabel, getMissingFieldLabels, getRequiredCandidateFieldKeys, hasValidCv } from '../services/readinessGuard.js';
import { evaluateSchedulingGuard } from '../services/schedulingGuard.js';
import { handleSupervisorInbound, isSupervisorPhone, notifySupervisorAttachment, notifySupervisorManualReview } from '../services/adminSupervisor.js';
import {
  markConversationMessagesResponded,
  mergeConversationMessagePayload,
  persistInboundConversationMessage,
  persistOutboundConversationMessage
} from '../services/conversationMessageRepository.js';
import { ContextualAllowedAction, evaluateContextualResponseGate, inferContextualSemanticIntent } from '../services/contextualResponseGate.js';
import { FUTURE_PROFILE_CAPTURE_MODE, PAUSED_VACANCY_CAPTURE_MODE, resolveVacancyFirstGate, VacancyFirstGateAction } from '../services/vacancyFirstGate.js';
import {
  buildSilentProfileCaptureReply,
  buildSilentProfileCaptureUpdate,
  shouldSilentCaptureProfileData
} from '../services/silentProfileCapture.js';
import { getOpenAiModelConfig } from '../services/openAiModelConfig.js';

const FAQ_RESPONSE = 'Con gusto te ayudo. ¿Desde qué ciudad nos escribes y para qué vacante o cargo estás interesado?';
const SALUDO_INICIAL = 'Hola, gracias por comunicarte con LoginPro. ¿Desde qué ciudad nos escribes y para qué vacante o cargo estás interesado?';

const DESCARTE_MSG = 'Gracias por tu interés. En este caso no es posible continuar con tu postulación porque no cumples con uno de los requisitos definidos para esta vacante.';
const CIERRE_NO_INTERES = 'Entendido. Si más adelante deseas continuar con la postulación, puedes volver a escribirme y con gusto retomamos el proceso.';
const SOLICITAR_HV = 'Gracias por compartir tus datos. Para finalizar tu postulación, adjunta tu hoja de vida (HV) como archivo PDF, DOC o DOCX.';
const RECORDATORIO_HV = 'Para continuar necesito que adjuntes tu hoja de vida (HV) como archivo PDF, DOC o DOCX. Cuando la envíes, finalizamos tu proceso.';
const MENSAJE_FINAL = 'Tu información y hoja de vida quedaron registradas correctamente. El equipo de selección revisará tu perfil y, si el proceso continúa, te contactará por este medio.';
const MENSAJE_DONE_ACK = '¡Con gusto! Ya quedó tu registro completo. Si surge una novedad, te contactamos por este medio.';
const MENSAJE_DONE_CV_REPEAT = 'Ya tenemos tu registro completo. Si deseas actualizar tu hoja de vida, puedes enviarla y la adjuntamos a tu postulación.';
const GUIA_CONTINUAR = 'Puedo ayudarte a continuar con la postulación. Si deseas seguir, envíame tus datos y te voy guiando.';
const CONFIRMACION_PROMPT = '¿Está correcto? Responde Sí para continuar o envíame la corrección.';
const INTERVIEW_OFFER_SOURCES = new Set(['interview_offer', 'interview_reschedule']);
const ASK_VACANCY_FOR_CV = 'Recibi tu hoja de vida. Para asociarla correctamente, cuentame desde que ciudad nos escribes y para que vacante o cargo estas aplicando.';
const TEXT_ONLY_CV_FILENAME_REPLY = 'Para registrar tu hoja de vida necesito que adjuntes el archivo real en PDF, DOC o DOCX; escribir solo el nombre del archivo no es suficiente.';

const FIELD_LABELS = {
  fullName: 'el nombre completo',
  documentType: 'el tipo de documento',
  documentNumber: 'el número de documento',
  age: 'la edad',
  medicalRestrictions: 'las restricciones médicas',
  transportMode: 'el medio de transporte'
};

const USE_CONVERSATION_ENGINE = process.env.USE_CONVERSATION_ENGINE === 'true';
const FORWARD_MEDIA_TO = process.env.FORWARD_MEDIA_TO;

// ---------------------------------------------------------------------------
// Rate limiting en memoria por número de teléfono.
// ---------------------------------------------------------------------------
const MAX_MESSAGES_PER_WINDOW = parseInt(process.env.RATE_LIMIT_MAX || '15', 10);
const RATE_WINDOW_MS           = parseInt(process.env.RATE_LIMIT_WINDOW_MS || String(10 * 60 * 1000), 10); // 10 min
const CLEANUP_INTERVAL_MS      = 30 * 60 * 1000; // 30 min

/** @type {Map<string, number[]>} */
const phoneTimestamps = new Map();

/**
 * Devuelve true si el número está dentro del límite permitido y registra
 * el timestamp del intento. Devuelve false si lo supera (rate limited).
 */
function checkRateLimit(phone) {
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;
  const timestamps = (phoneTimestamps.get(phone) || []).filter(t => t > windowStart);
  if (timestamps.length >= MAX_MESSAGES_PER_WINDOW) {
    console.warn('[RATE_LIMIT_HIT]', JSON.stringify({ phone, count: timestamps.length, windowMs: RATE_WINDOW_MS }));
    return false;
  }
  timestamps.push(now);
  phoneTimestamps.set(phone, timestamps);
  return true;
}

// Limpieza periódica para no acumular entradas viejas en memoria.
const rateLimitCleanupTimer = setInterval(() => {
  const windowStart = Date.now() - RATE_WINDOW_MS;
  for (const [phone, timestamps] of phoneTimestamps.entries()) {
    const active = timestamps.filter(t => t > windowStart);
    if (active.length === 0) {
      phoneTimestamps.delete(phone);
    } else {
      phoneTimestamps.set(phone, active);
    }
  }
}, CLEANUP_INTERVAL_MS);
rateLimitCleanupTimer.unref?.();

function normalizeText(text = '') { return text.trim(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function isFAQ(text) { const n = normalizeText(text).toLowerCase(); return /(cu[aá]ndo\s+(empiezan|me llaman|inicia|arranca|se comunican)|para\s+cu[aá]ndo)/i.test(n); }
function isAffirmativeInterest(text) {
  const n = normalizeText(text).toLowerCase(); if (!n) return false;
  const patterns = ['si', 'sí', 'claro', 'listo', 'ok', 'okay', 'dale', 'de una', 'hagámosle', 'vamos', 'estoy interesado', 'estoy interesada', 'me interesa', 'quiero aplicar', 'quiero postularme', 'quiero participar', 'deseo continuar', 'me gustaría postularme', 'quiero seguir', 'continuar'];
  if (patterns.some((p) => n === p || n.includes(p))) return true;
  return /(quiero|deseo|me gustar[ií]a|vamos|listo|claro).*(aplicar|postular|continuar|seguir|participar|hacerlo)/i.test(n);
}
function isAffirmativeConfirmation(text) {
  const n = normalizeText(text).toLowerCase();
  return /^(si|sí|correcto|esta bien|está bien|todo bien|todo correcto|confirmo|de acuerdo|ok|listo|perfecto|quedo bien|quedó bien)\b/.test(n);
}
function isNegativeInterest(text) { const n = normalizeText(text).toLowerCase(); return /^(nop+|negativo)$|no gracias|no me interesa|no estoy interesad|no deseo|paso|ya no|prefiero no|mejor no/i.test(n); }
function normalizeComparableText(text = '') { return normalizeResolverText(text); }
function mentionsForeigner(text = '') { return /\b(extranjero|extranjera|venezolan|no soy colombian)\b/.test(normalizeComparableText(text)); }
function hasValidForeignDocumentMention(text = '', parsed = {}) {
  const type = String(parsed.documentType || '').trim();
  if (['CE', 'PPT', 'Pasaporte'].includes(type)) return true;
  const n = normalizeComparableText(text);
  return /\b(ppt|permiso ppt|pasaporte|cedula de extranjeria|ce)\b/.test(n);
}
function explicitlyLacksValidDocument(text = '') {
  const n = normalizeComparableText(text);
  return /no tengo documento vigente|documento vencido|sin documento vigente|sin papeles|no tengo papeles|no tengo documento valido|sin documento valido|no tengo ppt|sin ppt|no tengo pasaporte|sin pasaporte|no tengo cedula de extranjeria|sin cedula de extranjeria|no tengo ce|sin ce/.test(n);
}
function hasStrongAgeEvidence(text = '', parsed = {}, evidenceByField = {}) {
  const age = Number(parsed?.age);
  if (!Number.isFinite(age)) return false;
  const ageEvidence = evidenceByField.age || {};
  const n = normalizeComparableText(text);
  if (/\b(trabajador(?:es)?|personas?|operarios?|empleados?|grupo?s?|turno?s?)\b/.test(n) && /\b(mayor(?:es)?\s+a\s+\d{1,2}|mas\s+de\s+\d{1,2})\b/.test(n)) return false;
  if (/\b(calle|carrera|cra|avenida|av)\s+\d+/.test(n)) return false;
  if (/\b(tengo|edad|anos|años|cumpli|cumplo|soy de)\b/.test(n)) return true;
  return Number(ageEvidence.confidence || 0) >= 0.92 && /\bedad\b/.test(n);
}
function shouldRejectByRequirements(text, parsed = {}, evidenceByField = {}, vacancy = null) {
  const n = normalizeComparableText(text);
  if (hasStrongAgeEvidence(text, parsed, evidenceByField)) {
    const ageFailure = evaluateCandidateEligibility({ age: parsed.age }, vacancy)
      .failures.find((failure) => failure.field === 'age');
    if (ageFailure) {
      return {
        reject: true,
        reason: ageFailure.message,
        details: ageFailure.details,
        code: ageFailure.code,
        candidateAge: ageFailure.candidateAge,
        minAge: ageFailure.minAge,
        maxAge: ageFailure.maxAge
      };
    }
  }
  if (explicitlyLacksValidDocument(n)) return { reject: true, reason: 'Documento no vigente', details: 'El candidato indicó no tener documento vigente.' };
  if (mentionsForeigner(text) && hasValidForeignDocumentMention(text, parsed)) return { reject: false };
  return { reject: false };
}
function getFieldLabel(field, vacancy = null) {
  return getReadinessFieldLabel(field, vacancy) || FIELD_LABELS[field] || field;
}
function buildResidenceMissingField(candidate, vacancy = null) {
  return getCandidateResidenceValue(candidate, vacancy) ? null : getResidenceFieldConfig(vacancy).label;
}
function formatFieldListForVacancy(fields = [], vacancy = null) {
  const labels = fields
    .map((field) => getFieldLabel(field, vacancy))
    .filter(Boolean);
  if (!labels.length) return '';
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} y ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')} y ${labels[labels.length - 1]}`;
}
function formatYearsLabel(age) {
  if (!age) return 'Pendiente';
  return `${age} a\u00f1os`;
}
function isMedicalRestrictionsClarificationRequest(text = '') {
  const n = normalizeComparableText(text);
  if (!n) return false;
  return /\b(no entiendo|no se|no s[eé]|que tendria que poner|que debo poner|a que te refieres|que significa)\b/.test(n)
    && /\b(?:restric\w*|medic\w*|salud)\b/.test(n);
}
function buildMedicalRestrictionsClarifier() {
  return 'Si no tienes ninguna restriccion medica, puedes responder "ninguna" o "no tengo restricciones". Si tienes alguna limitacion o condicion de salud importante para el trabajo, me la indicas en una frase corta.';
}
function enrichNormalizedDataFromContext(text = '', normalizedData = {}, candidate = {}, vacancy = null) {
  const enriched = { ...normalizedData };
  const missing = getMissingFieldLabels(candidate, vacancy);
  const missingSet = new Set(missing);
  const normalizedText = normalizeComparableText(text);

  if (!enriched.gender) {
    if (/\b(?:estoy|me encuentro)\s+interesada\b|\bquedo\s+atenta\b/.test(normalizedText)) {
      enriched.gender = 'FEMALE';
    } else if (/\b(?:estoy|me encuentro)\s+interesado\b|\bquedo\s+atento\b/.test(normalizedText)) {
      enriched.gender = 'MALE';
    }
  }

  if (!enriched.medicalRestrictions && missingSet.size === 1 && missingSet.has('restricciones medicas')) {
    if (looksLikeNoMedicalRestrictionsText(text, { allowImplicit: true })) {
      enriched.medicalRestrictions = 'Sin restricciones médicas';
    }
  }

  return enriched;
}
function buildMissingFieldsReply(candidate, normalizedData = {}, vacancy = null) {
  const missing = getMissingFieldLabels(candidate, vacancy);
  if (!missing.length) return '';
  const capturedCount = Object.keys(normalizedData || {})
    .filter((field) => getRequiredCandidateFieldKeys(vacancy).includes(field) && normalizedData[field] !== undefined && normalizedData[field] !== null && normalizedData[field] !== '')
    .length;
  if (capturedCount >= 2) return `Gracias, registré lo que compartiste. Para completar el proceso aún faltan: ${missing.join(', ')}.`;
  if (capturedCount === 1) return `Gracias, ese dato quedó registrado. Para continuar falta: ${missing.join(', ')}.`;
  return `Para continuar con la postulación falta esta información: ${missing.join(', ')}.`;
}
function buildUpdatedConfirmationReply(candidate, updatedFields = [], vacancy = null) {
  const updatedLabel = formatFieldListForVacancy(updatedFields, vacancy);
  const missing = getMissingFieldLabels(candidate, vacancy);
  const intro = updatedLabel
    ? `Listo, ya actualice ${updatedLabel}. Asi va tu registro:`
    : 'Listo, asi va tu registro:';
  const prompt = missing.length
    ? `Para seguir me faltan: ${missing.join(', ')}.`
    : 'Si todo esta bien, seguimos con el siguiente paso.';
  return buildConfirmationSummary(candidate, { intro, prompt }, vacancy);
}
function buildConfirmationClarifier(candidate, vacancy = null) {
  const missing = getMissingFieldLabels(candidate, vacancy);
  if (missing.length) {
    return `Si ves algo por ajustar, enviame solo el dato correcto. Para seguir todavía necesito: ${missing.join(', ')}.`;
  }
  return 'Si todo esta correcto, responde si y seguimos. Si quieres ajustar algo, enviame solo ese dato y lo actualizo.';
}
function containsCandidateData(text, parsedData = null) {
  const candidateData = parsedData && typeof parsedData === 'object'
    ? parsedData
    : parseNaturalData(text);
  const meaningfulEntries = Object.entries(normalizeCandidateFields(candidateData || {}))
    .filter(([, value]) => value !== undefined && value !== null && value !== '');

  if (!meaningfulEntries.length) return false;
  if (meaningfulEntries.every(([field]) => field === 'gender')) return false;

  return hasMeaningfulCandidateData(candidateData);
}
function hasHv(candidate) { return hasValidCv(candidate); }

function resolveInboundMessageType(message = {}) {
  if (message.type === 'text') return MessageType.TEXT;
  if (message.type === 'document') return MessageType.DOCUMENT;
  if (message.type === 'image') return MessageType.IMAGE;
  if (message.type === 'interactive') return MessageType.INTERACTIVE;
  return MessageType.UNKNOWN;
}
function buildInboundBody(message = {}) {
  if (message.type === 'text') return message.text?.body || '';
  if (message.type === 'document') return message.document?.filename || '';
  if (message.type === 'image') return message.image?.caption || '';
  if (message.type === 'audio') return '[Audio recibido]';
  if (message.type === 'interactive') {
    return message.interactive?.button_reply?.title
      || message.interactive?.list_reply?.title
      || '';
  }
  return '';
}
function getNaturalDelayMs(inputText = '', outputText = '') {
  if (process.env.NODE_ENV === 'test') return 0;
  const configuredDelay = Number.parseInt(String(process.env.LORREN_SEND_DELAY_MS || ''), 10);
  if (Number.isFinite(configuredDelay) && configuredDelay >= 0) return configuredDelay;
  const l = Math.max(normalizeText(inputText).length, normalizeText(outputText).length, 1);
  return Math.max(1800, Math.min(3200, 1800 + Math.min(1400, Math.round(l * 8))));
}
function isQuestionLike(text = '') {
  const n = normalizeComparableText(text);
  return String(text || '').includes('?') || /\b(que|cual|cuales|como|cuando|donde|cuanto|quien|puedo|puede|podria|requisitos|condiciones|horario|pago|direccion|ubicacion|cargo)\b/.test(n);
}
function isVacancyInfoQuestion(text = '') {
  const n = normalizeComparableText(text);
  if (!n || !isQuestionLike(text)) return false;
  return /\b(donde|direccion|ubicacion|queda|sector|requisit|document|edad|experien|perfil|pago|salario|sueldo|turno|horario|condicion|beneficio|contrato|funcion|cargo|labor|hacer|rol|vacante|trabajo|empleo|postul|aplicar)\b/.test(n);
}
function isDocumentValidationQuestion(text = '') {
  const n = normalizeComparableText(text);
  if (!n) return false;
  return /\b(cedula digital|cedula original|documento original|foto de la cedula|foto del documento|solo tengo foto|solo tengo la foto|perdi la cedula|perdi el documento|contrasena del tramite|contraseña del tramite|tramite del documento|tramite de la cedula)\b/.test(n);
}
function buildVacancyLocation(vacancy) {
  return [vacancy?.operation?.city?.name || vacancy?.city || null, vacancy?.operation?.name || null]
    .filter(Boolean)
    .join(' - ');
}
function isVacancyOpen(vacancy) {
  return Boolean(vacancy?.isActive && vacancy?.acceptingApplications);
}
function getVacancyOperationZone(vacancy) {
  return vacancy?.operationAddress || '';
}
function getVacancyInterviewAddress(vacancy) {
  return vacancy?.interviewAddress || vacancy?.operationAddress || '';
}
function buildVacancyCompactSummary(vacancy) {
  if (!vacancy) return '';
  const role = vacancy.title || vacancy.role || 'la vacante';
  const location = buildVacancyLocation(vacancy);
  const parts = [
    isVacancyOpen(vacancy)
      ? `La vacante que tengo para ti es ${role}${location ? ` en ${location}` : ''}.`
      : `La vacante de ${role}${location ? ` en ${location}` : ''} existe en el sistema, pero en este momento no esta activa para recibir personal.`
  ];
  if (vacancy.roleDescription) parts.push(`El cargo consiste en ${vacancy.roleDescription}.`);
  else if (vacancy.requirements) parts.push(`Los requisitos principales son ${vacancy.requirements}.`);
  const requiredDocs = sanitizeRequiredDocumentsForBot(vacancy.requiredDocuments);
  if (requiredDocs) parts.push(buildInterviewDocumentsSentence(requiredDocs));
  return parts.join(' ');
}
function buildNoOperationsAvailableReply(city = null) {
  const location = city ? ` en ${city}` : '';
  return `En este momento no veo operaciones activas${location}. Si quieres, puedo dejar tu perfil registrado para futuras aperturas compatibles; solo avanzo si me confirmas que deseas ese registro.`;
}

function formatVacancyOptions(vacancies = [], city = null) {
  return buildVacancyOptionsReply({ city: city || 'esa ciudad', vacancyOptions: vacancies });
}

function buildVacancyInterestPrompt(city = null, cityVacancyOptions = []) {
  return buildVacancyOptionsReply({ city, vacancyOptions: cityVacancyOptions });
}
function buildVacancyQuestionLead(vacancy, text = '', candidate = null) {
  const n = normalizeComparableText(text);
  const location = buildVacancyLocation(vacancy);
  const operationZone = getVacancyOperationZone(vacancy);
  const interviewAddress = getVacancyInterviewAddress(vacancy);
  const availabilityLead = isVacancyOpen(vacancy)
    ? `Te cuento sobre ${vacancy?.title || vacancy?.role || 'la vacante'}`
    : `Te cuento sobre ${vacancy?.title || vacancy?.role || 'la vacante'} y te aclaro que por ahora no esta recibiendo personal`;
  if (/(donde|direccion|ubicacion|queda|sector)/.test(n)) {
    if (vacancy?.schedulingEnabled && interviewAddress && candidate?.currentStep === ConversationStep.SCHEDULED) {
      return `${availabilityLead} La dirección de entrevista registrada es ${interviewAddress}.`;
    }
    if (vacancy?.schedulingEnabled && interviewAddress && /\b(present|entrevista|cita)\b/.test(n)) {
      return `${availabilityLead} Primero debo confirmar tu horario de entrevista. Por ahora solo puedo confirmarte que la vacante está registrada para ${location || 'esa operación'}${operationZone ? `, zona de operación ${operationZone}` : ''}.`;
    }
    if (operationZone) {
      return `${availabilityLead} La vacante esta registrada para ${location || 'esa operacion'} y la zona de operacion es ${operationZone}.`;
    }
    return `${availabilityLead} La vacante esta registrada para ${location || 'esa operacion'}.`;
  }
  if (/(requisit|document|edad|experien|perfil)/.test(n) && vacancy?.requirements) {
    return `${availabilityLead} Los requisitos registrados para esta vacante son: ${vacancy.requirements}.`;
  }
  if (/(pago|salario|sueldo|turno|horario|condicion|prestacion|beneficio|contrato)/.test(n)) {
    if (vacancy?.conditions) return `${availabilityLead} Las condiciones registradas para esta vacante son: ${vacancy.conditions}.`;
    return buildUnavailableVacancyInfoReply(vacancy);
  }
  if (/(funcion|cargo|labor|hacer|rol)/.test(n)) {
    const description = vacancy?.roleDescription || vacancy?.role || vacancy?.title;
    return `${availabilityLead} El cargo registrado es ${vacancy?.title || vacancy?.role || 'la vacante consultada'}${description ? ` y la descripcion disponible es: ${description}.` : '.'}`;
  }
  return isVacancyOpen(vacancy)
    ? `Con ese contexto, te doy la informacion vigente de ${vacancy?.title || vacancy?.role || 'la vacante'}.`
    : `Con ese contexto, te comparto la informacion vigente y si quieres dejo tu perfil registrado para cuando reabran ${vacancy?.title || vacancy?.role || 'esa vacante'}.`;
}
function isFutureProfileCaptureCandidate(candidate = {}) {
  return [FUTURE_PROFILE_CAPTURE_MODE, PAUSED_VACANCY_CAPTURE_MODE].includes(String(candidate?.botResumeMode || ''));
}

function buildVacancyContinuePrompt(candidate, vacancy = null) {
  if (vacancy && !isVacancyOpen(vacancy)) {
    if (candidate?.botResumeMode !== 'paused_vacancy_capture') {
      return '';
    }

    if (candidate.currentStep === ConversationStep.ASK_CV) {
      return 'Si quieres dejar tu perfil registrado por si la vacante se vuelve a abrir, solo me falta tu hoja de vida en PDF, DOC o DOCX.';
    }
    if (candidate.currentStep === ConversationStep.COLLECTING_DATA || candidate.currentStep === ConversationStep.CONFIRMING_DATA) {
      const missing = getMissingFieldLabels(candidate, vacancy);
      if (missing.length) {
        return `Si quieres dejar tu perfil registrado, aun me faltan estos datos: ${missing.join(', ')}.`;
      }
      return 'Si quieres dejar tu perfil registrado por si la vacante se vuelve a abrir, enviame tambien tu hoja de vida.';
    }
    return 'Si quieres, puedo tomar tus datos y tu hoja de vida para dejar tu perfil registrado por si la vacante se vuelve a abrir.';
  }
  if (candidate.currentStep === ConversationStep.ASK_CV) return RECORDATORIO_HV;
  if (candidate.currentStep === ConversationStep.COLLECTING_DATA || candidate.currentStep === ConversationStep.CONFIRMING_DATA) {
    const missing = getMissingFieldLabels(candidate, vacancy);
    if (missing.length) return `Si deseas continuar, aun me faltan estos datos: ${missing.join(', ')}.`;
    return SOLICITAR_HV;
  }
  if (candidate.currentStep === ConversationStep.DONE) return MENSAJE_DONE_ACK;
  return 'Si te interesa continuar, primero confirmamos que esta sea la vacante correcta y luego te guío con los datos necesarios.';
}
function buildVacancyAssociationPrompt(options = {}) {
  const intro = (options.cvReceived || options.hasCv)
    ? 'Recibí tu hoja de vida.'
    : (options.dataCaptured ? 'Ya registré lo que me compartiste.' : 'Con gusto te ayudo.');
  if (options.city) {
    return `${intro} ${buildVacancyInterestPrompt(options.city, options.cityVacancyOptions || [])}`;
  }
  const attachment = options.hasCv ? 'Para asociarla correctamente' : 'Para asociar bien tu proceso';
  return `${intro} ${attachment}, ${buildVacancyInterestPrompt().replace(/^Cuéntame/, 'cuéntame')}`;
}
function buildQuestionFollowUpReply(vacancy, inboundText = '', followUpText = '', candidate = null) {
  const answer = buildVacancyQuestionLead(vacancy, inboundText, candidate);
  return followUpText ? `${answer}\n\n${followUpText}` : answer;
}
function buildInactiveVacancyReply(vacancy, candidate, inboundText = '') {
  const continuePrompt = buildVacancyContinuePrompt(candidate, vacancy);
  const summary = buildVacancyCompactSummary(vacancy);
  if (isQuestionLike(inboundText)) {
    return [buildVacancyQuestionLead(vacancy, inboundText, candidate), continuePrompt]
      .filter(Boolean)
      .join('\n\n');
  }
  return [summary, continuePrompt].filter(Boolean).join('\n\n');
}
function shouldEscalateManualCandidateQuestion(candidate = {}, text = '', vacancy = null) {
  if (!vacancy || !isQuestionLike(text)) return false;
  if (isDocumentValidationQuestion(text) || isVacancyInfoQuestion(text)) return false;
  if (isAffirmativeInterest(text) || isAffirmativeConfirmation(text) || isNegativeInterest(text) || isPostCompletionAck(text)) return false;
  return hasHv(candidate) || [
    ConversationStep.ASK_CV,
    ConversationStep.SCHEDULING,
    ConversationStep.SCHEDULED,
    ConversationStep.DONE
  ].includes(candidate?.currentStep);
}
function buildVacancyReply(vacancy, candidate, inboundText = '') {
  const lines = [];
  lines.push(isQuestionLike(inboundText) ? buildVacancyQuestionLead(vacancy, inboundText, candidate) : 'Hola, gracias por comunicarte con LoginPro.');
  lines.push('', 'Te comparto la informacion de la vacante disponible:', '', `*Vacante:* ${vacancy.title || vacancy.role}`);
  if (vacancy.role && vacancy.role !== vacancy.title) lines.push(`*Cargo:* ${vacancy.role}`);
  const location = buildVacancyLocation(vacancy);
  if (location) lines.push(`*Ciudad / operacion:* ${location}`);
  if (getVacancyOperationZone(vacancy)) lines.push(`*Zona de operacion:* ${getVacancyOperationZone(vacancy)}`);
  if (vacancy.schedulingEnabled && getVacancyInterviewAddress(vacancy)) lines.push(`*Direccion de entrevista:* ${getVacancyInterviewAddress(vacancy)}`);
  const requiredDocs = sanitizeRequiredDocumentsForBot(vacancy.requiredDocuments);
  if (requiredDocs) lines.push(`*Documentacion para entrevista:* ${requiredDocs}`);
  if (!isVacancyOpen(vacancy)) lines.push('*Estado:* En este momento no estamos recibiendo personal para esta vacante.');
  if (vacancy.roleDescription) lines.push(`*Descripcion del cargo:* ${vacancy.roleDescription}`);
  if (vacancy.requirements) lines.push(`*Requisitos:* ${vacancy.requirements}`);
  if (vacancy.conditions) lines.push(`*Condiciones:* ${vacancy.conditions}`);
  lines.push('', buildVacancyContinuePrompt(candidate, vacancy));
  return lines.join('\n');
}

function buildVacancyReplyNatural(vacancy, candidate, inboundText = '') {
  const continuePrompt = buildVacancyContinuePrompt(candidate, vacancy);
  const compactSummary = buildVacancyCompactSummary(vacancy);

  if (!isVacancyOpen(vacancy)) {
    return buildInactiveVacancyReply(vacancy, candidate, inboundText);
  }

  if (isQuestionLike(inboundText)) {
    const lines = [buildVacancyQuestionLead(vacancy, inboundText, candidate)];
    if (candidate.currentStep === ConversationStep.GREETING_SENT) lines.push(compactSummary);
    if (![ConversationStep.SCHEDULING, ConversationStep.SCHEDULED, ConversationStep.DONE].includes(candidate.currentStep) && continuePrompt) {
      lines.push(continuePrompt);
    }
    return lines.filter(Boolean).join('\n\n');
  }

  if ([ConversationStep.COLLECTING_DATA, ConversationStep.CONFIRMING_DATA, ConversationStep.ASK_CV].includes(candidate.currentStep)) {
    return [compactSummary, continuePrompt].filter(Boolean).join('\n\n');
  }

  return ['Hola, gracias por comunicarte con LoginPro.', compactSummary, continuePrompt]
    .filter(Boolean)
    .join('\n\n');
}

function isSchedulingEligibleCandidate(candidate, vacancy) {
  return evaluateSchedulingGuard({ candidate, vacancy, nextSlot: { slot: { id: 'eligibility-preview' } }, actionType: 'offer_interview' }).allowed;
}

function isSchedulingConfirmationIntent(text = '') {
  const n = normalizeComparableText(text);
  return isAffirmativeConfirmation(text)
    || /\b(confirmo|agendame|agendar|me sirve|me queda bien|si puedo|sí puedo|vale ese horario)\b/.test(n);
}

function isSchedulingRescheduleIntent(text = '') {
  const n = normalizeComparableText(text);
  return /\b(otro horario|otra hora|otro dia|otro dia|reagend|cambiar horario|no puedo|no me queda|no me sirve|mas tarde|mas temprano|otra opcion)\b/.test(n);
}
function isApplicationFollowUpQuestion(text = '') {
  const n = normalizeComparableText(text);
  return /\b(me postule|me postule para|me habia postulado|quisiera saber que ha pasado|que ha pasado con mi postulacion|como va mi postulacion|estado de mi postulacion|qued[eo] en que|si hay novedad)\b/.test(n);
}

function getPrimaryEngineAction(actions = []) {
  const priority = [
    'confirm_booking',
    'reschedule',
    'offer_interview',
    'mark_female_pipeline',
    'mark_rejected',
    'request_cv',
    'request_confirmation',
    'mark_no_interest',
    'pause_bot'
  ];
  return priority.find((type) => actions.some((action) => action?.type === type)) || 'nothing';
}

function buildInterviewReplyPayload(body, source, nextSlot, vacancy = null) {
  return {
    body,
    source,
    slotId: nextSlot?.slot?.id || null,
    scheduledAt: nextSlot?.date?.toISOString?.() || null,
    formattedDate: nextSlot?.formattedDate || null,
    reminderAt: nextSlot?.reminderAt?.toISOString?.() || null,
    skipCount: nextSlot?.skipCount ?? 0,
    ...(vacancy ? { safetyVacancy: vacancy } : {})
  };
}

async function loadPendingInterviewOffer(prisma, candidateId) {
  const recentOutbound = await prisma.message.findMany({
    where: { candidateId, direction: MessageDirection.OUTBOUND },
    orderBy: { createdAt: 'desc' },
    take: 12,
    select: { rawPayload: true }
  });

  const match = recentOutbound.find((message) => {
    const source = message?.rawPayload?.source;
    return INTERVIEW_OFFER_SOURCES.has(source)
      && message?.rawPayload?.slotId
      && message?.rawPayload?.scheduledAt;
  });

  return match?.rawPayload || null;
}

async function loadActiveInterviewBooking(prisma, candidateId) {
  return prisma.interviewBooking.findFirst({
    where: {
      candidateId,
      status: { in: ['SCHEDULED', 'CONFIRMED'] }
    },
    orderBy: { scheduledAt: 'asc' },
    select: {
      id: true,
      slotId: true,
      scheduledAt: true,
      status: true,
      reminderSentAt: true,
      reminderWindowClosed: true
    }
  });
}

async function applyActiveInterviewResponse(prisma, candidate, activeBooking, responseText, intent) {
  if (!activeBooking?.id || !activeBooking?.status) {
    await recordIntentionalSilence(prisma, candidate, responseText, {
      reason: 'interview_booking_missing_for_response',
      gate: 'interview_booking_authority',
      action: intent
    });
    return null;
  }

  const transition = await applyInterviewReminderResponse(prisma, {
    bookingId: activeBooking.id,
    currentStatus: activeBooking.status,
    responseText,
    intent
  });

  if (transition.count !== 1) {
    await recordIntentionalSilence(prisma, candidate, responseText, {
      reason: 'interview_booking_transition_not_applied',
      gate: 'interview_booking_authority',
      action: intent
    });
    return null;
  }

  return transition;
}

async function loadVacancyContext(prisma, vacancyId) {
  if (!vacancyId) return null;
  return prisma.vacancy.findUnique({
    where: { id: vacancyId },
    include: {
      operation: {
        include: {
          city: true,
        },
      },
    },
  });
}

function buildConfirmationSummary(candidate, options = {}, vacancy = null) {
  const residenceConfig = getResidenceFieldConfig(vacancy);
  const residenceValue = getCandidateResidenceValue(candidate, vacancy) || 'Pendiente';
  const documentLabel = candidate.documentType && candidate.documentNumber
    ? `${candidate.documentType} ${candidate.documentNumber}`
    : 'Pendiente';
  const intro = options.intro || 'Perfecto, por favor confirma estos datos:';
  const prompt = options.prompt || CONFIRMACION_PROMPT;
  return [
    intro,
    `- Nombre completo: ${candidate.fullName || 'Pendiente'}`,
    `- Documento: ${documentLabel}`,
    `- Edad: ${formatYearsLabel(candidate.age)}`,
    `- ${residenceConfig.labelTitle}: ${residenceValue}`,
    `- Restricciones medicas: ${candidate.medicalRestrictions || 'Pendiente'}`,
    `- Medio de transporte: ${candidate.transportMode || 'Pendiente'}`,
    prompt
  ].join('\n');
}

async function resolveInterviewSlotContext(prisma, candidate, vacancy, inboundText = '') {
  if (!candidate?.vacancyId || !vacancy || !isSchedulingEligibleCandidate(candidate, vacancy)) return null;

  const lastInboundAt = candidate.lastInboundAt ? new Date(candidate.lastInboundAt) : null;
  const wantsAlternative = isSchedulingRescheduleIntent(inboundText);
  const activeBooking = await loadActiveInterviewBooking(prisma, candidate.id);

  if (candidate.currentStep === ConversationStep.SCHEDULED && activeBooking && !wantsAlternative) {
    const scheduledDate = new Date(activeBooking.scheduledAt);
    return {
      slot: { id: activeBooking.slotId },
      date: scheduledDate,
      reminderAt: getInterviewReminderAt(scheduledDate),
      formattedDate: formatInterviewDate(scheduledDate),
      skipCount: 0,
      windowOk: true,
      windowExtension: null,
      isConfirmedBooking: true
    };
  }

  const pendingOffer = await loadPendingInterviewOffer(prisma, candidate.id);

  if (pendingOffer) {
    if (wantsAlternative) {
      const alternative = await getNextAvailableSlotAfter(prisma, vacancy.id, lastInboundAt, pendingOffer);
      if (!alternative?.slot) return alternative;
      return {
        ...alternative,
        isAlternative: true,
        previousFormattedDate: pendingOffer.formattedDate || formatInterviewDate(new Date(pendingOffer.scheduledAt))
      };
    }

    return hydrateOfferedSlot(prisma, vacancy.id, lastInboundAt, pendingOffer);
  }

  if ((candidate.currentStep === ConversationStep.SCHEDULED || candidate.currentStep === ConversationStep.SCHEDULING) && wantsAlternative && activeBooking) {
    const alternative = await getNextAvailableSlotAfter(prisma, vacancy.id, lastInboundAt, activeBooking);
    if (!alternative?.slot) return alternative;
    return {
      ...alternative,
      isAlternative: true,
      previousFormattedDate: formatInterviewDate(new Date(activeBooking.scheduledAt))
    };
  }

  return getNextAvailableSlot(prisma, vacancy.id, lastInboundAt);
}

async function buildInterviewOfferReply(candidate, vacancy, nextSlot, isReschedule = false) {
  if (!nextSlot?.slot) {
    return 'Ya registré tu proceso. En este momento no tengo un horario válido para ofrecerte, así que el equipo te contactará para coordinar la entrevista.';
  }

  return generateInterviewOffer({
    formattedDate: nextSlot.formattedDate,
    vacancy,
    candidateName: candidate.fullName,
    candidate,
    isReschedule
  });
}

async function buildInterviewConfirmationReply(candidate, vacancy, nextSlot) {
  if (!nextSlot?.slot) {
    return 'Tu entrevista quedó registrada y el equipo te confirmará cualquier ajuste por este medio.';
  }

  return generateBookingConfirmation({
    formattedDate: nextSlot.formattedDate,
    vacancy,
    candidateName: candidate.fullName,
    candidate
  });
}

function shouldAskForConfirmation(candidate, normalizedData, vacancy = null) {
  if (candidate.currentStep === ConversationStep.CONFIRMING_DATA) {
    return getMissingFieldLabels(candidate, vacancy).length === 0;
  }
  const missing = getMissingFieldLabels(candidate, vacancy);
  const hasMainBlock = getRequiredCandidateFieldKeys(vacancy).every((field) => {
    if (field === 'locality' || field === 'neighborhood') {
      return Boolean(getCandidateResidenceValue(candidate, vacancy));
    }
    return candidate[field] !== null && candidate[field] !== undefined && candidate[field] !== '';
  });
  if (hasMainBlock) return true;
  if (!missing.length) return true;

  const correctedFields = Object.keys(normalizedData || {});
  const requiresReconfirm = correctedFields.some((field) => getRequiredCandidateFieldKeys(vacancy).includes(field));
  return requiresReconfirm && correctedFields.length >= 2 && missing.length <= 2;
}

function inferNaturalOverwriteFields(text, normalizedData = {}, current = {}, currentStep = null) {
  const allow = new Set();
  const normalizedText = normalizeComparableText(text);
  const isConfirming = currentStep === ConversationStep.CONFIRMING_DATA;
  const explicitCorrection = /\b(corrijo|correccion|corrección|quise decir|actualizo|de hecho|mejor|perd[oó]n|en realidad|más bien|mas bien)\b/i.test(text);
  const softCorrection = isConfirming && /^(no\b|no,|ah no|mejor|en realidad|de hecho)/i.test(normalizedText);

  if (explicitCorrection || softCorrection) {
    Object.keys(normalizedData).forEach((field) => allow.add(field));
  }

  if (normalizedData.age !== undefined && /\b(edad|anos|años|tengo|soy de)\b/.test(normalizedText)) {
    allow.add('age');
  }
  if (normalizedData.transportMode && /\b(transporte|medio de transporte|moto|motocicleta|bicicleta|bici|cicla|bicivleta|bivivleta|bisicleta)\b/.test(normalizedText)) {
    allow.add('transportMode');
  }
  if (normalizedData.medicalRestrictions && /\b(restric|medic|salud|sin restricciones|ninguna restric)\b/.test(normalizedText)) {
    allow.add('medicalRestrictions');
  }

  if (
    current?.transportMode === 'Publico'
    && normalizedData.transportMode
    && normalizedData.transportMode !== 'Publico'
  ) {
    allow.add('transportMode');
  }

  return [...allow];
}

function shouldUseEngineFieldPreview(candidate, cleanText, localParsedData = {}, aiFields = {}, missingFields = []) {
  if (!USE_CONVERSATION_ENGINE) return false;
  if (!candidate || !cleanText) return false;
  if (![ConversationStep.GREETING_SENT, ConversationStep.CONFIRMING_DATA, ConversationStep.COLLECTING_DATA, ConversationStep.ASK_CV].includes(candidate.currentStep)) {
    return false;
  }
  if (isNegativeInterest(cleanText)) return false;

  const hasParsedCandidateData = hasMeaningfulCandidateData(localParsedData)
    || hasMeaningfulCandidateData(aiFields);
  if (
    candidate.currentStep === ConversationStep.CONFIRMING_DATA
    && missingFields.length === 1
    && missingFields[0] === 'restricciones medicas'
    && isMedicalRestrictionsClarificationRequest(cleanText)
    && !hasParsedCandidateData
  ) {
    return false;
  }
  if (candidate.currentStep === ConversationStep.CONFIRMING_DATA) return true;
  if (
    candidate.currentStep === ConversationStep.ASK_CV
    && isQuestionLike(cleanText)
    && !hasParsedCandidateData
  ) {
    return false;
  }

  if (candidate.currentStep === ConversationStep.GREETING_SENT && !candidate.vacancyId) {
    return hasParsedCandidateData;
  }
  return Object.keys(aiFields || {}).length === 0 || Object.keys(localParsedData || {}).length <= 1;
}

async function buildEngineContext(prisma, candidate, inboundText = '', providedVacancy = null) {
  const vacancy = providedVacancy || (candidate.vacancyId
    ? await loadVacancyContext(prisma, candidate.vacancyId)
    : null);

  const recentMessagesRaw = await prisma.message.findMany({
    where: { candidateId: candidate.id },
    orderBy: { createdAt: 'desc' },
    take: 8,
    select: { direction: true, body: true, rawPayload: true, createdAt: true },
  });

  const recentMessages = recentMessagesRaw
    .reverse()
    .map((m) => ({
      direction: m.direction,
      body: m.body || '',
      rawPayload: m.rawPayload || {},
      createdAt: m.createdAt || null
    }));

  const nextSlot = vacancy
    ? await resolveInterviewSlotContext(prisma, candidate, vacancy, inboundText)
    : null;

  return { vacancy, recentMessages, nextSlot };
}

async function previewEngineCandidateFields(prisma, candidate, inboundText, providedVacancy = null) {
  const { vacancy, recentMessages, nextSlot } = await buildEngineContext(prisma, candidate, inboundText, providedVacancy);
  const preparedContext = await prepareEngineDecisionContext({
    inboundText,
    candidate,
    vacancy,
    recentMessages,
    nextSlot,
    currentStep: candidate.currentStep || ConversationStep.MENU,
    prisma
  });
  const preview = await think({
    inboundText,
    candidate,
    vacancy,
    recentMessages,
    nextSlot,
    currentStep: candidate.currentStep || ConversationStep.MENU,
    prisma,
    preparedContext
  });
  const usage = preview?.usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

  if (preview?.fallback) {
    return { fields: {}, usage, decision: null, used: false, fallback: true };
  }
  return {
    fields: extractEngineCandidateFields(preview.actions, preview.extractedFields),
    usage,
    decision: preview,
    used: true,
    fallback: false
  };
}

function shouldUsePrimaryConversationEngine(candidate, inboundText = '') {
  if (!USE_CONVERSATION_ENGINE || !process.env.OPENAI_API_KEY) return false;
  if (!candidate || !normalizeText(inboundText)) return false;
  return [
    ConversationStep.GREETING_SENT,
    ConversationStep.COLLECTING_DATA,
    ConversationStep.CONFIRMING_DATA,
    ConversationStep.ASK_CV,
    ConversationStep.SCHEDULING,
    ConversationStep.SCHEDULED
  ].includes(candidate.currentStep);
}

async function replyWithEngine(prisma, candidate, from, inboundText, providedVacancy = null, options = {}) {
  const effectiveModels = getOpenAiModelConfig();
  const { vacancy, recentMessages, nextSlot } = await buildEngineContext(prisma, candidate, inboundText, providedVacancy);
  const engineResult = await runChatEngine({
    prisma,
    candidate,
    vacancy,
    inboundText,
    recentMessages,
    nextSlot,
    candidateFieldHints: options.candidateFieldHints || {},
    precomputedDecision: options.enginePreview?.decision || null,
  });
  if (options.debugTrace) {
    options.debugTrace.engine_primary = true;
    options.debugTrace.engine_plan_reused = Boolean(engineResult.decisionReused);
    applyEnginePreviewPlanReuse(options.debugTrace, engineResult.decisionReused);
    options.debugTrace.engine_actions = (engineResult.actions || []).map((action) => action?.type).filter(Boolean);
    options.debugTrace.engine_loop_guard = Boolean(engineResult.loopGuardApplied);
    options.debugTrace.blockedActions = engineResult.blockedActions || [];
    const usage = engineResult?.usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    options.debugTrace.openai_input_tokens = Number(options.debugTrace.openai_input_tokens || 0) + Number(usage.input_tokens || 0);
    options.debugTrace.openai_output_tokens = Number(options.debugTrace.openai_output_tokens || 0) + Number(usage.output_tokens || 0);
    options.debugTrace.openai_total_tokens = Number(options.debugTrace.openai_total_tokens || 0) + Number(usage.total_tokens || 0);
    options.debugTrace.response_model = effectiveModels.conversation.model;
    options.debugTrace.response_model_source = effectiveModels.conversation.source;
    options.debugTrace.model_usage = {
      ...(options.debugTrace.model_usage || {}),
      responseModel: effectiveModels.conversation.model,
      input_tokens: options.debugTrace.openai_input_tokens,
      output_tokens: options.debugTrace.openai_output_tokens,
      total_tokens: options.debugTrace.openai_total_tokens
    };
  }

  if (engineResult.suppressed) {
    await recordIntentionalSilence(prisma, candidate, inboundText, {
      reason: engineResult.suppressedReason || 'engine_suppressed_without_reason',
      gate: 'chat_engine',
      action: 'SUPPRESSED',
      vacancyId: vacancy?.id || candidate?.vacancyId || null
    });
    console.warn('[BOT_SUPPRESSED]', JSON.stringify({
      phone: candidate.phone,
      candidateId: candidate.id,
      reason: engineResult.suppressedReason || 'suppressed_without_reason'
    }));
    return true;
  }

  if (!engineResult.reply && !engineResult.suppressed) {
    const body = buildSafeFallbackReply();
    if (options.debugTrace) options.debugTrace.fallbackReason = 'engine_empty_reply';
    console.warn('[BOT_FALLBACK_REPLY]', JSON.stringify({ phone: candidate.phone, candidateId: candidate.id, reason: 'engine_empty_reply' }));
    await reply(prisma, candidate.id, from, body, inboundText, { body, source: 'bot_fallback', safetyVacancy: vacancy });
    return true;
  }

  if (engineResult.fallback) {
    const fallbackReason = engineResult.fallbackReason || 'engine_returned_fallback';
    if (options.debugTrace) {
      options.debugTrace.engine_fallback_used = true;
      options.debugTrace.engine_fallback_reason = fallbackReason;
      options.debugTrace.openai_status = 'fallback';
    }
    console.warn('[ENGINE_PRIMARY_FALLBACK]', JSON.stringify({
      phone: candidate.phone,
      candidateId: candidate.id,
      reason: fallbackReason,
      delegatedToDeterministicFlow: true
    }));
    return false;
  }

  const candidateAfterActions = await prisma.candidate.findUnique({ where: { id: candidate.id } }) || candidate;
  const engineInterviewOffer = (
    engineResult.handledInterviewIntent === 'reschedule_interview'
    && engineResult.interviewOffer?.slot
  )
    ? engineResult.interviewOffer
    : null;

  const primaryAction = getPrimaryEngineAction(engineResult.actions);
  let body = engineResult.reply;
  let source = 'engine';

  if (engineResult.blockedActions?.length) {
    source = 'engine_guard_block';
  } else if (primaryAction === 'offer_interview' || primaryAction === 'reschedule') {
    body = await buildInterviewOfferReply(candidateAfterActions, vacancy, nextSlot, primaryAction === 'reschedule' || Boolean(nextSlot?.isAlternative));
    source = (primaryAction === 'reschedule' || nextSlot?.isAlternative) ? 'interview_reschedule' : 'interview_offer';
  } else if (primaryAction === 'confirm_booking') {
    body = await buildInterviewConfirmationReply(candidateAfterActions, vacancy, nextSlot);
    source = 'interview_booking_confirmation';
  } else if (engineInterviewOffer) {
    source = 'interview_reschedule';
  } else if (shouldForceFlowFollowUp(body, candidateAfterActions, primaryAction)) {
    body = appendUniqueReplySegment(body, buildVacancyContinuePrompt(candidateAfterActions, vacancy));
  }

  const interviewReplySlot = engineInterviewOffer || nextSlot;
  const rawPayload = source.startsWith('interview_')
    ? { ...buildInterviewReplyPayload(body, source, interviewReplySlot), safetyVacancy: vacancy }
    : { body, source, safetyVacancy: vacancy };
  if (engineResult.replySafety?.blocked && options.debugTrace) {
    options.debugTrace.blockedClaims = engineResult.replySafety.blockedClaims;
    options.debugTrace.replySafetyReason = engineResult.replySafety.reason;
  }

  await reply(prisma, candidate.id, from, body, inboundText, rawPayload);
  return true;
}

function shouldForceFlowFollowUp(body, candidate, primaryAction) {
  if (!body || primaryAction && primaryAction !== 'nothing') return false;
  if (candidate.currentStep === ConversationStep.DONE) return false;
  const text = String(body).toLowerCase();
  if (text.includes('?')) return false;
  return /\b(reviso|revisar|validando|te ubico|por ahora)\b/.test(text);
}

async function resolveVacancyFromConversation(prisma, text, options = {}) {
  const activeVacancies = options.activeVacancies || await findActiveVacancies(prisma);
  const allVacancies = options.allVacancies || await findAllVacancies(prisma);
  const resolution = await resolveVacancyFromText(prisma, text, {
    cityHint: options.cityHint,
    roleHint: options.roleHint,
    activeVacancies,
    allVacancies,
  });

  return resolution;
}

async function buildVacancyResolutionContextText(prisma, candidateId, currentText = '') {
  const recentInbound = await prisma.message.findMany({
    where: {
      candidateId,
      direction: MessageDirection.INBOUND
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { body: true }
  });

  const parts = recentInbound
    .reverse()
    .map((message) => normalizeText(message.body || ''))
    .filter(Boolean);

  const normalizedCurrent = normalizeComparableText(currentText);
  if (normalizedCurrent && normalizeComparableText(parts[parts.length - 1] || '') !== normalizedCurrent) {
    parts.push(normalizeText(currentText));
  }

  return parts.join('\n');
}

async function pauseInterviewFlow(prisma, candidateId, reason) {
  await prisma.candidate.update({
    where: { id: candidateId },
    data: {
      botPaused: true,
      botPausedAt: new Date(),
      botPauseReason: reason,
      reminderScheduledFor: null,
      reminderState: 'CANCELLED'
    }
  });
}

function buildSupervisorImageNotice(phone, fullName, caption) {
  const candidateLabel = fullName ? `${phone} (${fullName})` : phone;
  const captionSuffix = caption ? ` Caption: ${caption}` : '';
  return `Foto recibida de ${candidateLabel}.${captionSuffix}`;
}

async function forwardInboundImageToSupervisor(candidatePhone, fullName, image = {}) {
  const supervisorPhone = FORWARD_MEDIA_TO;
  if (!supervisorPhone) {
    console.warn('[MEDIA_FORWARD_MISSING_TARGET]', JSON.stringify({
      candidatePhone,
      reason: 'FORWARD_MEDIA_TO missing'
    }));
    return;
  }

  const caption = image?.caption || '';
  await sendTextMessage(supervisorPhone, buildSupervisorImageNotice(candidatePhone, fullName, caption));
  await sendImageMessage(supervisorPhone, { id: image?.id }, caption);
}

async function countRecentInboundAttachments(prisma, candidateId, withinMinutes = 15) {
  const since = new Date(Date.now() - (withinMinutes * 60 * 1000));
  return prisma.message.count({
    where: {
      candidateId,
      direction: MessageDirection.INBOUND,
      messageType: { in: [MessageType.DOCUMENT, MessageType.IMAGE] },
      createdAt: { gte: since }
    }
  });
}

async function countRecentInboundDocuments(prisma, candidateId, withinMinutes = 15) {
  const since = new Date(Date.now() - (withinMinutes * 60 * 1000));
  return prisma.message.count({
    where: {
      candidateId,
      direction: MessageDirection.INBOUND,
      messageType: MessageType.DOCUMENT,
      createdAt: { gte: since }
    }
  });
}

async function saveAttachmentAnalysis(prisma, candidateId, inboundMessageId, attachment, analysis) {
  if (!prisma?.attachmentAnalysis?.create) return;
  await prisma.attachmentAnalysis.create({
    data: {
      candidateId,
      messageId: inboundMessageId || null,
      classification: analysis.classification,
      confidence: Number(analysis.confidence || 0),
      evidence: Array.isArray(analysis.evidence) ? analysis.evidence.join(' | ').slice(0, 1000) : String(analysis.rationale || '').slice(0, 1000),
      mimeType: attachment?.mimeType || null,
      fileName: attachment?.fileName || null
    }
  }).catch((error) => {
    console.warn('[ATTACHMENT_ANALYSIS_SAVE_ERROR]', error?.message || error);
  });
}

async function getRecentConversationMessages(prisma, candidateId, limit = 10) {
  if (!prisma?.message?.findMany) return [];
  const messages = await prisma.message.findMany({
    where: { candidateId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { direction: true, body: true, rawPayload: true, createdAt: true }
  });
  return messages.reverse();
}

async function getRecentOutboundMessages(prisma, candidateId, limit = 6) {
  if (!prisma?.message?.findMany) return [];
  return prisma.message.findMany({
    where: {
      candidateId,
      direction: MessageDirection.OUTBOUND,
      messageType: MessageType.TEXT
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { body: true }
  });
}

async function hasRecentResumePhotoReply(prisma, candidateId, minutes = 15) {
  if (!prisma?.message?.findMany) return false;
  const since = new Date(Date.now() - minutes * 60 * 1000);
  const recent = await prisma.message.findMany({
    where: {
      candidateId,
      direction: MessageDirection.OUTBOUND,
      messageType: MessageType.TEXT,
      createdAt: { gte: since }
    },
    orderBy: { createdAt: 'desc' },
    take: 8,
    select: { body: true, rawPayload: true }
  });
  return recent.some((message) => message?.rawPayload?.situation === 'attachment_resume_photo'
    || (message?.rawPayload?.replyIntent === 'request_cv_pdf_word' && /registrar tu hoja de vida|pdf o word\/docx/i.test(message?.body || '')));
}


export async function recordIntentionalSilence(prisma, candidate = {}, inboundText = '', details = {}) {
  const payload = {
    source: 'bot_silence_trace',
    visibility: 'internal',
    neverSendToCandidate: true,
    candidateId: candidate?.id || null,
    inboundPreview: String(inboundText || '').slice(0, 180),
    currentStep: candidate?.currentStep || null,
    vacancyId: candidate?.vacancyId || details.vacancyId || null,
    reason: details.reason || 'intentional_silence',
    gate: details.gate || details.action || null,
    action: details.action || null,
    replyKind: details.replyKind || null,
    recentReplyKind: details.recentReplyKind || null,
    createdAt: new Date().toISOString()
  };
  try {
    await persistOutboundConversationMessage(prisma, {
      candidateId: candidate.id,
      messageType: MessageType.TEXT,
      body: `[silencio intencional] ${payload.reason}`,
      rawPayload: payload
    });
  } catch (error) {
    console.warn('[BOT_SILENCE_TRACE_ERROR]', JSON.stringify({ candidateId: candidate?.id || null, reason: payload.reason, error: error?.message?.slice(0, 160) }));
  }
  console.info('[BOT_SILENCE_TRACE]', JSON.stringify(payload));
}

async function pauseSilentlyForManualReview(prisma, candidate, reason, inboundText = '', options = {}) {
  const transition = await pauseCandidateAutomationForManualReview(prisma, {
    candidateId: candidate.id,
    expected: {
      botPaused: candidate.botPaused,
      botPausedAt: candidate.botPausedAt ?? null,
      botPausedBy: candidate.botPausedBy ?? null,
      botPauseReason: candidate.botPauseReason ?? null,
      botResumeMode: candidate.botResumeMode ?? null,
      reminderScheduledFor: candidate.reminderScheduledFor ?? null,
      reminderState: candidate.reminderState
    },
    reason,
    pausedAt: new Date()
  });

  if (transition.count !== 1) {
    const observedCandidate = transition.candidate || candidate;
    await recordIntentionalSilence(prisma, observedCandidate, inboundText, {
      reason: 'STALE_CANDIDATE_MANUAL_REVIEW_PAUSE',
      gate: 'manual_review_pause',
      action: 'SUPPRESSED',
      vacancyId: observedCandidate?.vacancyId || candidate?.vacancyId || null
    });
    console.warn('[STALE_CANDIDATE_MANUAL_REVIEW_PAUSE]', JSON.stringify({
      candidateId: candidate.id,
      reason,
      observedPaused: observedCandidate?.botPaused ?? null,
      observedReminderState: observedCandidate?.reminderState || null
    }));
    return {
      paused: false,
      conflict: true,
      candidate: observedCandidate
    };
  }

  await notifySupervisorManualReview(prisma, transition.candidate || candidate, {
    reason,
    inboundText,
    reviewType: options.reviewType || 'question',
    extra: options.extra || {}
  }).catch((error) => console.warn('[ADMIN_SUPERVISOR_NOTIFY_ERROR]', error?.message || error));
  console.info('[BOT_MANUAL_REVIEW_SILENT]', JSON.stringify({
    candidateId: candidate.id,
    reason,
    inboundPreview: String(inboundText || '').slice(0, 140)
  }));
  return {
    paused: true,
    conflict: false,
    candidate: transition.candidate || candidate
  };
}

async function pauseForManualQuestionReview(prisma, candidate, from, inboundText = '') {
  return pauseSilentlyForManualReview(prisma, candidate, 'Duda posterior requiere intervencion manual', inboundText);
}

async function composeContextualAttachmentReply(prisma, {
  candidate,
  from,
  inboundText = '',
  recentOutbound = [],
  vacancy = null,
  activeInterviewBooking = null,
  attachmentAnalysis = null,
  missingFields = [],
  decision = '',
  fallbackIntent = 'continue_flow',
  situation = 'continue_flow',
  requiresHumanReview = false,
  rawPayload = {}
} = {}) {
  const contextual = await buildContextualReply({
    situation,
    decision,
    inboundText,
    recentMessages: recentOutbound,
    candidate,
    vacancy,
    currentStep: candidate?.currentStep || null,
    activeInterviewBooking,
    attachmentAnalysis,
    missingFields,
    requiresHumanReview,
    fallbackIntent
  });
  await reply(prisma, candidate.id, from, contextual.text, inboundText, {
    source: contextual.fallbackUsed ? 'response_policy_fallback' : 'contextual_reply',
    situation,
    decision,
    model: contextual.model,
    fallbackReason: contextual.fallbackUsed ? contextual.reason : null,
    ...rawPayload
  });
  return contextual;
}

async function finalizeCandidateAfterCv(prisma, candidate, from) {
  const vacancy = candidate.vacancyId ? await loadVacancyContext(prisma, candidate.vacancyId) : null;

  const readiness = getCandidateReadiness(candidate, vacancy);

  if (!vacancy && isFutureProfileCaptureCandidate(candidate) && readiness.readyForDone) {
    await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        currentStep: ConversationStep.DONE,
        status: CandidateStatus.REGISTRADO,
        reminderScheduledFor: null,
        reminderState: 'SKIPPED'
      }
    });
    const body = 'Ya recibí tu información y tu hoja de vida para dejar tu perfil registrado. En este momento no hay una vacante activa asociada ni entrevista por agendar; si se abre una oportunidad compatible, el equipo te contactará por este medio.';
    return reply(prisma, candidate.id, from, body, '', { body, source: 'future_profile_capture' });
  }

  if (vacancy && !isVacancyOpen(vacancy) && readiness.readyForDone) {
    await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        currentStep: ConversationStep.DONE,
        status: CandidateStatus.REGISTRADO,
        reminderScheduledFor: null,
        reminderState: 'SKIPPED'
      }
    });
    const location = buildVacancyLocation(vacancy);
    const body = `Ya recibi tu informacion y tu hoja de vida para ${vacancy.title || vacancy.role}${location ? ` en ${location}` : ''}. En este momento no estamos recibiendo personal para esa vacante, pero tu perfil queda registrado por si se vuelve a abrir.`;
    return reply(prisma, candidate.id, from, body, '', { body, source: 'bot_flow' });
  }

  if (readiness.readyForScheduling && isSchedulingEligibleCandidate(candidate, vacancy)) {
    const nextSlot = await resolveInterviewSlotContext(prisma, { ...candidate, currentStep: ConversationStep.SCHEDULING }, vacancy);
    if (!nextSlot?.slot) {
      await pauseInterviewFlow(prisma, candidate.id, 'Vacante con agenda habilitada sin slots validos disponibles');
      const body = 'Ya recibí tu hoja de vida y tus datos. En este momento no tengo un horario válido para ofrecerte, así que el equipo de selección te contactará para coordinar la entrevista.';
      return reply(prisma, candidate.id, from, body, '', { body, source: 'bot_flow' });
    }

    await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        currentStep: ConversationStep.SCHEDULING,
        status: CandidateStatus.REGISTRADO,
        reminderScheduledFor: null,
        reminderState: 'SKIPPED'
      }
    });

    const body = await buildInterviewOfferReply(candidate, vacancy, nextSlot, false);
    return reply(prisma, candidate.id, from, body, '', buildInterviewReplyPayload(body, 'interview_offer', nextSlot, vacancy));
  }

  if (!readiness.readyForDone) {
    const targetStep = readiness.readyForCvRequest ? ConversationStep.ASK_CV : ConversationStep.COLLECTING_DATA;
    await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: targetStep } });
    const body = readiness.readyForCvRequest
      ? 'Tus datos principales están listos. Para cerrar el registro, adjunta tu hoja de vida como archivo PDF, DOC o DOCX.'
      : `Aún me falta un dato para cerrar bien tu registro: ${readiness.missingFieldLabels?.[0] || 'información pendiente'}.`;
    return reply(prisma, candidate.id, from, body, '', { body, source: 'readiness_guard' });
  }

  await prisma.candidate.update({
    where: { id: candidate.id },
    data: {
      currentStep: ConversationStep.DONE,
      status: CandidateStatus.REGISTRADO,
      reminderScheduledFor: null,
      reminderState: 'SKIPPED'
    }
  });
  return reply(prisma, candidate.id, from, MENSAJE_FINAL, '', { body: MENSAJE_FINAL, source: 'bot_flow' });
}

export async function saveInboundMessage(prisma, candidateId, message, body, type, phone) {
  const waMessageId = message?.id || null;
  const persistInbound = (messageType) => persistInboundConversationMessage(prisma, {
    candidateId,
    waMessageId,
    messageType,
    body,
    rawPayload: sanitizeForRawPayload(message)
  });
  let insertResult;

  try {
    insertResult = await persistInbound(type);
  } catch (error) {
    const messageTypeMismatch = /invalid input value for enum "MessageType"/i.test(String(error?.message || ''));
    if (!messageTypeMismatch || type === MessageType.UNKNOWN) throw error;

    console.warn('[INBOUND_MESSAGE_TYPE_FALLBACK]', JSON.stringify({
      phone: phone || null,
      candidateId,
      waMessageId,
      requestedType: type,
      persistedType: MessageType.UNKNOWN
    }));

    insertResult = await persistInbound(MessageType.UNKNOWN);
  }

  if (!insertResult.created) {
    console.log('[INBOUND_DUPLICATE_IGNORED]', JSON.stringify({
      phone: phone || null,
      waMessageId,
      duplicate_ignored: true
    }));
    return { isNew: false, id: null };
  }

  if (prisma.candidate?.update) {
    await prisma.candidate.update({ where: { id: candidateId }, data: { lastInboundAt: new Date() } });
  }

  if (!waMessageId) return { isNew: true, id: null };

  const created = await prisma.message.findUnique({
    where: { waMessageId },
    select: { id: true }
  });

  return { isNew: true, id: created?.id || null };
}
async function attachDebugTrace(prisma, messageId, debugTrace) {
  if (!messageId) return;
  return mergeConversationMessagePayload(prisma, {
    messageId,
    patch: { debugTrace }
  });
}

async function prepareCandidateForInboundAutomation(prisma, candidate = {}) {
  if (!candidate?.botPaused) return candidate;
  if (shouldBlockAutomation(candidate, { direction: 'INBOUND' })) return candidate;
  if (!shouldResumeAutomationOnInbound(candidate)) return candidate;

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

  if (transition.count === 1) {
    console.info('[BOT_RESUMED_BY_INBOUND]', JSON.stringify({
      candidateId: candidate.id,
      previousReason: candidate.botPauseReason || null,
      previousResumeMode: candidate.botResumeMode || null
    }));
  }

  return transition.candidate || candidate;
}


function outboundRequestsResolvedVacancy(reply = '', candidate = {}, vacancy = null) {
  if (!candidate?.vacancyId && !vacancy?.id) return false;
  const n = normalizeComparableText(reply);
  if (!n) return false;
  const asksCity = /\b(?:desde\s+que\s+ciudad|ciudad\s+nos\s+escribes|ciudad\s+escribes|que\s+ciudad)\b/.test(n);
  const asksVacancy = /\b(?:para\s+que\s+vacante|que\s+vacante|vacante\s+o\s+cargo|cargo\s+estas|cargo\s+te\s+interesa)\b/.test(n);
  return asksCity || asksVacancy;
}

function outboundRequestsResolvedResidence(reply = '', candidate = {}, vacancy = null) {
  if (!getCandidateResidenceValue(candidate, vacancy)) return false;
  const n = normalizeComparableText(reply);
  if (!n) return false;

  const asksResidence = /\b(?:localidad|barrio|residencia|donde\s+vives|donde\s+estas\s+ubicad[oa])\b/.test(n);
  const requestTone = /\b(?:falta|faltaria|me\s+falta|necesito|cuentame|confirmame|indica(?:me)?|dime|comparte(?:me)?)\b/.test(n);
  const directResidenceQuestion = /\b(?:en\s+que\s+localidad\s+estas|en\s+que\s+barrio\s+vives|en\s+que\s+barrio\s+estas|cual\s+es\s+tu\s+localidad|cual\s+es\s+tu\s+barrio)\b/.test(n);

  return asksResidence && (requestTone || directResidenceQuestion);
}

function outboundRequestsResolvedCv(reply = '', readiness = {}) {
  if (!readiness?.hasValidCv) return false;
  const n = normalizeComparableText(reply);
  if (!n || !/\b(?:hoja\s+de\s+vida|hv|cv)\b/.test(n)) return false;
  return /\b(?:envia(?:me)?|adjunta|comparte(?:me)?|reenvia|vuelve\s+a\s+enviar|me\s+falta|falta|necesito|para\s+continuar)\b/.test(n)
    && /\b(?:pdf|docx|doc|archivo)\b/.test(n);
}

function buildStateAwareContinuationReply(candidate = {}, vacancy = null, readiness = {}) {
  const known = [];
  const vacancyName = vacancy?.title || vacancy?.role || null;
  const vacancyCity = vacancy?.operation?.city?.name || vacancy?.city || null;
  if (vacancyName) known.push(`la vacante de ${vacancyName}${vacancyCity ? ` en ${vacancyCity}` : ''}`);
  const residence = getCandidateResidenceValue(candidate, vacancy);
  if (residence) known.push(`tu ubicación/residencia: ${residence}`);
  if (readiness.hasValidCv) known.push('tu hoja de vida');

  const prefix = known.length
    ? `Ya tengo registrado ${known.join(', ')}.`
    : 'Ya tengo parte de tu información registrada.';

  if (readiness.missingFieldLabels?.length) {
    return `${prefix} Para continuar solo me falta: ${readiness.missingFieldLabels.join(', ')}.`;
  }
  if (!readiness.hasValidCv) {
    return `${prefix} Para continuar, adjunta tu hoja de vida como archivo PDF, DOC o DOCX.`;
  }
  if (readiness.readyForScheduling) {
    return `${prefix} Con eso puedo seguir con el agendamiento de entrevista.`;
  }
  return `${prefix} Con eso sigo con el siguiente paso del proceso.`;
}

export async function guardReplyWithConversationState(prisma, candidateId, replyText = '', rawPayload = {}) {
  const source = rawPayload?.source || 'bot_flow';
  if (/^admin_|manual/i.test(source)) return { text: replyText, blocked: false };
  const candidate = await prisma.candidate.findUnique({ where: { id: candidateId } }).catch(() => null);
  if (!candidate) return { text: replyText, blocked: false };
  const vacancy = rawPayload?.safetyVacancy
    || rawPayload?.vacancyContext
    || (candidate.vacancyId ? await loadVacancyContext(prisma, candidate.vacancyId).catch(() => null) : null);
  const readiness = getCandidateReadiness(candidate, vacancy);
  const blockedReasons = [];

  if (outboundRequestsResolvedVacancy(replyText, candidate, vacancy)) blockedReasons.push('resolved_vacancy_requested_again');
  if (outboundRequestsResolvedResidence(replyText, candidate, vacancy)) blockedReasons.push('resolved_residence_requested_again');
  if (outboundRequestsResolvedCv(replyText, readiness)) blockedReasons.push('resolved_cv_requested_again');

  if (!blockedReasons.length) return { text: replyText, blocked: false };
  return {
    text: buildStateAwareContinuationReply(candidate, vacancy, readiness),
    blocked: true,
    blockedReasons,
    readiness: {
      missingFields: readiness.missingFields || [],
      missingFieldLabels: readiness.missingFieldLabels || [],
      hasValidCv: readiness.hasValidCv,
      readyForScheduling: readiness.readyForScheduling
    }
  };
}

export async function saveOutboundMessage(prisma, candidateId, body, rawPayload = { body }) {
  const payload = { body, source: 'bot_flow', ...(rawPayload || {}) };
  await persistOutboundConversationMessage(prisma, {
    candidateId,
    messageType: MessageType.TEXT,
    body,
    rawPayload: payload
  });
  await prisma.candidate.update({ where: { id: candidateId }, data: { lastOutboundAt: new Date() } });
}
async function reply(prisma, candidateId, to, body, inboundText = '', rawPayload = { body, source: 'bot_flow' }) {
  let finalBody = String(body || '').trim();
  const stateGuard = await guardReplyWithConversationState(prisma, candidateId, finalBody || buildSafeFallbackReply(), rawPayload || {});
  finalBody = stateGuard.text || buildSafeFallbackReply();
  const safetyVacancy = rawPayload?.safetyVacancy || rawPayload?.vacancyContext || null;
  const safety = sanitizeOutboundReply({
    reply: finalBody,
    vacancy: safetyVacancy,
    candidate: { id: candidateId },
    currentStep: rawPayload?.currentStep || null,
    source: rawPayload?.source || 'bot_flow'
  });
  finalBody = safety.reply || buildSafeFallbackReply();
  const cleanedPayload = { ...(rawPayload || {}), body: finalBody };
  delete cleanedPayload.safetyVacancy;
  delete cleanedPayload.vacancyContext;
  if (stateGuard.blocked) {
    cleanedPayload.stateGuard = { blocked: true, reasons: stateGuard.blockedReasons, readiness: stateGuard.readiness };
    console.warn('[BOT_REPLY_STATE_GUARD_BLOCKED]', JSON.stringify({ candidateId, reasons: stateGuard.blockedReasons }));
  }
  if (safety.blocked) {
    cleanedPayload.replySafety = { blocked: true, blockedClaims: safety.blockedClaims, reason: safety.reason };
    console.warn('[BOT_REPLY_SAFETY_BLOCKED]', JSON.stringify({ candidateId, blockedClaims: safety.blockedClaims, reason: safety.reason }));
  }
  await sleep(getNaturalDelayMs(inboundText, finalBody));
  try {
    await sendTextMessage(to, finalBody);
  } catch (error) {
    console.error('[BOT_SEND_ERROR]', JSON.stringify({ candidateId, error: error?.message?.slice(0, 200) }));
    throw error;
  }
  await saveOutboundMessage(prisma, candidateId, finalBody, cleanedPayload);
  await scheduleReminderForCandidate(prisma, candidateId);
}

async function wasDoneAckSent(prisma, candidateId) {
  const latestOutbound = await prisma.message.findMany({
    where: { candidateId, direction: MessageDirection.OUTBOUND },
    orderBy: { createdAt: 'desc' },
    take: 10
  });
  return latestOutbound.some((message) => message?.rawPayload?.source === 'bot_done_ack');
}
async function rejectCandidate(prisma, candidateId, from, rejection = {}) {
  const rejectionDetails = [
    rejection.details || null,
    rejection.code ? `Código: ${rejection.code}.` : null
  ].filter(Boolean).join(' ');
  await prisma.candidate.update({
    where: { id: candidateId },
    data: {
      status: CandidateStatus.RECHAZADO,
      currentStep: ConversationStep.DONE,
      rejectionReason: rejection.reason || 'No cumple requisitos',
      rejectionDetails: rejectionDetails || null,
      reminderScheduledFor: null,
      reminderState: 'SKIPPED'
    }
  });
  await reply(prisma, candidateId, from, DESCARTE_MSG, '', { body: DESCARTE_MSG, source: 'bot_flow' });
}

export async function processText(prisma, candidate, from, text, debugTrace, options = {}) {
  const cleanText = normalizeText(text);
  const fallbackIntent = detectConversationIntent(cleanText, { isDoneStep: candidate.currentStep === ConversationStep.DONE });
  debugTrace.openai_intent = inferIntent(cleanText);
  debugTrace.batched_message_count = options.batchedMessageCount || 1;
  debugTrace.used_multiline_context = Boolean(options.usedMultilineContext);
  debugTrace.consolidated_input_summary = options.consolidatedInputSummary || null;
  let currentVacancy = candidate.vacancyId ? await loadVacancyContext(prisma, candidate.vacancyId) : null;

  if (looksLikeCvFilenameText(cleanText)) {
    debugTrace.cv_text_filename_only = true;
    return reply(prisma, candidate.id, from, TEXT_ONLY_CV_FILENAME_REPLY, cleanText, {
      body: TEXT_ONLY_CV_FILENAME_REPLY,
      source: 'bot_cv_text_filename_rejected'
    });
  }

  const aiResult = await tryOpenAIParse(cleanText);
  const sanitizerContext = {
    currentStep: candidate.currentStep,
    pendingFields: getMissingFieldLabels(candidate, currentVacancy)
  };
  const localParsedData = parseNaturalData(cleanText);
  const aiFields = aiResult.parsedFields || {};
  const enginePreviewEligible = shouldUseEngineFieldPreview(
    candidate,
    cleanText,
    localParsedData,
    aiFields,
    sanitizerContext.pendingFields
  );
  const rawEnginePreview = enginePreviewEligible
    ? await previewEngineCandidateFields(prisma, candidate, cleanText, currentVacancy)
    : {
      fields: {},
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      decision: null,
      used: false,
      fallback: false
    };
  const understanding = await conversationUnderstanding(cleanText, {
    aiResult,
    context: sanitizerContext,
    runtime: {
      localParsedData,
      engineFields: rawEnginePreview?.fields || {},
      engineUsage: rawEnginePreview?.usage || {},
      vacancy: currentVacancy,
      fallbackIntent,
      enrichFields: (fields) => enrichNormalizedDataFromContext(cleanText, fields, candidate, currentVacancy)
    }
  });
  const turnInterpretation = understanding.turnInterpretation;
  if (!turnInterpretation) throw new Error('Missing runtime turn interpretation.');
  Object.assign(debugTrace, buildEnginePreviewTrace({
    eligible: enginePreviewEligible,
    preview: rawEnginePreview,
    turnInterpretation
  }));
  let normalizedData = turnInterpretation.fields;
  const sourceByField = turnInterpretation.sourceByField;
  const evidenceByField = turnInterpretation.evidenceByField;
  const hasDataIntent = containsCandidateData(cleanText, normalizedData);
  const requiredFields = getRequiredCandidateFieldKeys(currentVacancy);
  const hasNonNameProfileFieldCapture = Object.keys(normalizedData).some((field) => (
    requiredFields.includes(field) && field !== 'fullName'
  ));
  const hasMaterialProfileFieldCapture = Object.keys(normalizedData).some((field) => (
    ['documentType', 'documentNumber', 'age', 'medicalRestrictions', 'transportMode', 'neighborhood', 'locality'].includes(field)
  ));

  debugTrace.openai_used = aiResult.used || rawEnginePreview.used || turnInterpretation.engineFieldCount > 0;
  debugTrace.openai_status = aiResult.status === 'error' ? 'fallback' : aiResult.status;
  debugTrace.openai_model = aiResult.model || debugTrace.openai_model;
  debugTrace.openai_temperature_omitted = typeof aiResult.temperature_omitted === 'boolean'
    ? aiResult.temperature_omitted
    : debugTrace.openai_temperature_omitted;
  const combinedUsage = turnInterpretation.usage;
  debugTrace.openai_input_tokens = combinedUsage.input_tokens;
  debugTrace.openai_output_tokens = combinedUsage.output_tokens;
  debugTrace.openai_total_tokens = combinedUsage.total_tokens;
  const effectiveModels = getOpenAiModelConfig();
  debugTrace.extraction_model = effectiveModels.extraction.model;
  debugTrace.extraction_model_source = effectiveModels.extraction.source;
  debugTrace.response_model = effectiveModels.conversation.model;
  debugTrace.response_model_source = effectiveModels.conversation.source;
  debugTrace.model_usage = {
    extractionModel: debugTrace.extraction_model,
    responseModel: debugTrace.response_model,
    input_tokens: combinedUsage.input_tokens,
    output_tokens: combinedUsage.output_tokens,
    total_tokens: combinedUsage.total_tokens
  };
  const resolvedIntent = turnInterpretation.intent;
  const vacancyHints = {
    city: turnInterpretation.cityHint,
    roleHint: turnInterpretation.roleHint,
  };
  if (resolvedIntent) debugTrace.openai_intent = resolvedIntent;
  debugTrace.openai_detected_fields = turnInterpretation.detectedFields;
  debugTrace.source_by_field = sourceByField;
  debugTrace.field_evidence = evidenceByField;
  debugTrace.normalized_fields = normalizedData;
  debugTrace.rejected_fields.push(...turnInterpretation.rejectedFields);
  debugTrace.vacancy_hint_city = vacancyHints.city;
  debugTrace.vacancy_hint_role = vacancyHints.roleHint;

  const resolveVacancyForCandidate = async (options = {}) => {
    let resolution = await resolveVacancyFromConversation(prisma, cleanText, {
      cityHint: vacancyHints.city,
      roleHint: vacancyHints.roleHint,
    });

    if (!resolution.resolved && !candidate.vacancyId) {
      const contextualText = await buildVacancyResolutionContextText(prisma, candidate.id, cleanText);
      if (normalizeComparableText(contextualText) !== normalizeComparableText(cleanText)) {
        resolution = await resolveVacancyFromConversation(prisma, contextualText, {
          cityHint: vacancyHints.city,
          roleHint: null,
        });
      }
    }

    debugTrace.vacancy_resolution = {
      resolved: resolution.resolved,
      vacancyId: resolution.vacancy?.id || null,
      city: resolution.city,
      roleHint: resolution.roleHint,
      reason: resolution.reason,
    };
    return resolution;
  };

  const replyFromVacancyResolutionFailure = async (resolution) => {
    if (!resolution) return null;
    if (resolution.reason === 'city_without_active_vacancies' || resolution.reason === 'no_active_vacancies') {
      const body = buildNoOperationsAvailableReply(resolution.city);
      await reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_vacancy_prompt' });
      return true;
    }
    if (['city_with_active_vacancies', 'ambiguous_match', 'low_confidence_match'].includes(resolution.reason) && resolution.city) {
      const cityVacancies = (options.activeVacancies || await findActiveVacancies(prisma)).filter((vacancy) => normalizeComparableText(vacancy.operation?.city?.name || vacancy.city || '') === normalizeComparableText(resolution.city));
      const body = buildVacancyInterestPrompt(resolution.city, cityVacancies);
      await reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_vacancy_prompt' });
      return true;
    }
    return false;
  };

  const replyWithVacancyContext = async (candidateState, vacancy = null) => {
    const effectiveVacancy = vacancy || await loadVacancyContext(prisma, candidateState.vacancyId);
    if (!effectiveVacancy) {
      return reply(prisma, candidate.id, from, FAQ_RESPONSE, cleanText, { body: FAQ_RESPONSE, source: 'bot_vacancy_prompt' });
    }
    if (shouldEscalateManualCandidateQuestion(candidateState, cleanText, effectiveVacancy)) {
      return pauseForManualQuestionReview(prisma, candidateState, from, cleanText);
    }
    if (!isVacancyOpen(effectiveVacancy)) {
      const body = buildInactiveVacancyReply(effectiveVacancy, candidateState, cleanText);
      return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_vacancy_context', safetyVacancy: effectiveVacancy });
    }
    const shouldPreferDeterministicVacancyReply = isQuestionLike(cleanText)
      && [
        ConversationStep.ASK_CV,
        ConversationStep.SCHEDULING,
        ConversationStep.SCHEDULED,
        ConversationStep.DONE
      ].includes(candidateState.currentStep);
    if (USE_CONVERSATION_ENGINE && isQuestionLike(cleanText) && !shouldPreferDeterministicVacancyReply) {
      const handledByEngine = await replyWithEngine(prisma, candidateState, from, cleanText, effectiveVacancy, {
        candidateFieldHints: normalizedData,
        debugTrace,
        enginePreview: rawEnginePreview
      });
      if (handledByEngine) return;
    }
    const body = buildVacancyReplyNatural(effectiveVacancy, candidateState, cleanText);
    return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_vacancy_context', safetyVacancy: effectiveVacancy });
  };

  const tryPrimaryEngineReply = async (candidateState = candidate, vacancyState = currentVacancy) => {
    if (!shouldUsePrimaryConversationEngine(candidateState, cleanText)) return false;
    const isPostOnboarding = candidateState.stage
      && !['GREETING', 'INITIAL', 'INTEREST'].includes(candidateState.stage);
    if (isPostOnboarding && !vacancyState && !candidateState.vacancyId) return false;

    if (hasDataIntent && vacancyState && isVacancyOpen(vacancyState) && !isFutureProfileCaptureCandidate(candidateState)) {
      const rejection = shouldRejectByRequirements(cleanText, normalizedData, evidenceByField, vacancyState);
      if (rejection.reject) {
        await rejectCandidate(prisma, candidate.id, from, rejection);
        return true;
      }
    }

    return replyWithEngine(prisma, candidateState, from, cleanText, vacancyState, {
      candidateFieldHints: normalizedData,
      debugTrace,
      enginePreview: rawEnginePreview
    });
  };

  if (aiResult.status === 'error') {
    debugTrace.error_summary = summarizeError(aiResult.error);
    console.warn('[AI_FALLBACK]', JSON.stringify({ phone: candidate.phone, error: debugTrace.error_summary }));
  } else if (aiResult.status === 'disabled') {
    console.log('[AI_FALLBACK]', JSON.stringify({ phone: candidate.phone, reason: 'openai_disabled' }));
  }
  debugTrace.vacancy_assignment_pre_gate_blocked = !currentVacancy;

  if (candidate.status === CandidateStatus.RECHAZADO) return reply(prisma, candidate.id, from, DESCARTE_MSG);

  const currentMissingFields = getMissingFieldLabels(candidate, currentVacancy);
  const shouldPreferVacancyContextReply = Boolean(
    currentVacancy
    && (
      (
        !hasNonNameProfileFieldCapture
        && Boolean(vacancyHints.city || vacancyHints.roleHint)
      )
      || (
        isQuestionLike(cleanText)
        && [
          ConversationStep.ASK_CV,
          ConversationStep.SCHEDULING,
          ConversationStep.SCHEDULED,
          ConversationStep.DONE
        ].includes(candidate.currentStep)
      )
    )
  );
  const shouldPreferStructuredFieldReply = currentMissingFields.length === 1
    && currentMissingFields[0] === 'restricciones medicas'
    && (
      looksLikeNoMedicalRestrictionsText(cleanText, { allowImplicit: true })
      || isMedicalRestrictionsClarificationRequest(cleanText)
    );

  const contextualReadiness = getCandidateReadiness(candidate, currentVacancy);
  const shouldEvaluateContextualGate = Boolean(
    candidate.currentStep === ConversationStep.SCHEDULED
    || candidate.currentStep === ConversationStep.DONE
    || (currentVacancy && !currentVacancy.schedulingEnabled && contextualReadiness.readyForDone)
    || (!contextualReadiness.missingFields.length && contextualReadiness.hasValidCv && candidate.vacancyId)
  );

  if (shouldEvaluateContextualGate) {
    const activeBookingForGate = await loadActiveInterviewBooking(prisma, candidate.id);
    const interviewIntentForGate = detectInterviewIntent({ text: cleanText, booking: activeBookingForGate, now: new Date() });
    const semanticIntentForGate = inferContextualSemanticIntent({
      text: cleanText,
      resolvedIntent,
      interviewIntent: interviewIntentForGate,
      isQuestion: isQuestionLike(cleanText),
      hasDataIntent
    });
    const recentMessagesForGate = await getRecentConversationMessages(prisma, candidate.id, 10);
    const gateDecision = evaluateContextualResponseGate({
      candidate,
      vacancy: currentVacancy,
      activeInterviewBooking: activeBookingForGate,
      recentMessages: recentMessagesForGate,
      semanticIntent: semanticIntentForGate,
      readiness: contextualReadiness
    });
    debugTrace.contextual_response_gate = {
      shouldReply: gateDecision.shouldReply,
      allowedAction: gateDecision.allowedAction,
      reason: gateDecision.reason,
      responsePurpose: gateDecision.responsePurpose,
      requiresHumanReview: gateDecision.requiresHumanReview,
      semanticIntent: semanticIntentForGate
    };

    if (gateDecision.allowedAction !== ContextualAllowedAction.CONTINUE_FLOW) {
      if (gateDecision.requiresHumanReview) {
        await pauseSilentlyForManualReview(prisma, candidate, gateDecision.reason, cleanText, {
          reviewType: 'contextual_response_gate',
          extra: { allowedAction: gateDecision.allowedAction, semanticIntent: semanticIntentForGate }
        });
      }
      if (!gateDecision.shouldReply) {
        await recordIntentionalSilence(prisma, candidate, cleanText, {
          reason: gateDecision.reason || 'contextual_gate_should_not_reply',
          gate: 'contextual_response_gate',
          action: gateDecision.allowedAction,
          vacancyId: currentVacancy?.id || candidate?.vacancyId || null
        });
        return;
      }
      if (gateDecision.reply) {
        return reply(prisma, candidate.id, from, gateDecision.reply, cleanText, {
          body: gateDecision.reply,
          source: 'contextual_response_gate',
          actor: 'BOT',
          responsePurpose: gateDecision.responsePurpose,
          allowedAction: gateDecision.allowedAction,
          currentStep: candidate.currentStep,
          safetyVacancy: currentVacancy
        });
      }
    }
  }


  const vacancyFirstGateDecision = await resolveVacancyFirstGate({
    prisma,
    candidate,
    currentVacancy,
    inboundText: cleanText,
    currentStep: candidate.currentStep,
    readiness: contextualReadiness,
    recentMessages: await getRecentConversationMessages(prisma, candidate.id, 10),
    vacancyHints
  });
  debugTrace.vacancy_first_gate = {
    action: vacancyFirstGateDecision.action,
    reason: vacancyFirstGateDecision.reason,
    replyKind: vacancyFirstGateDecision.replyKind || null,
    vacancyId: vacancyFirstGateDecision.vacancyId || null,
    resolutionReason: vacancyFirstGateDecision.resolution?.reason || null
  };

  const buildVacancyFirstGateExpected = () => ({
    currentStep: candidate.currentStep,
    vacancyId: candidate.vacancyId ?? null,
    botResumeMode: candidate.botResumeMode ?? null,
    reminderScheduledFor: candidate.reminderScheduledFor ?? null,
    reminderState: candidate.reminderState ?? 'NONE'
  });

  const applyVacancyFirstGateUpdates = async (updates = {}) => {
    if (!updates || !Object.keys(updates).length) return { applied: true, candidate };

    const transition = await applyCandidateVacancyFirstGateDecision(prisma, {
      candidateId: candidate.id,
      expected: buildVacancyFirstGateExpected(),
      update: updates
    });

    if (transition.count !== 1) {
      candidate = transition.candidate || candidate;
      debugTrace.vacancy_first_gate = {
        ...(debugTrace.vacancy_first_gate || {}),
        conflict: true,
        observedStep: candidate.currentStep || null,
        observedVacancyId: candidate.vacancyId || null
      };
      await recordIntentionalSilence(prisma, candidate, cleanText, {
        reason: 'STALE_CANDIDATE_VACANCY_FIRST_GATE',
        gate: 'vacancy_first_gate',
        action: vacancyFirstGateDecision.action,
        replyKind: vacancyFirstGateDecision.replyKind || null,
        vacancyId: candidate.vacancyId || vacancyFirstGateDecision.vacancyId || null
      });
      return { applied: false, candidate };
    }

    candidate = transition.candidate || candidate;
    if (updates.vacancyId) currentVacancy = await loadVacancyContext(prisma, updates.vacancyId);
    return { applied: true, candidate };
  };

  const maybeSilentCaptureProfileData = async (reason = 'silent_profile_capture', replyKind = null) => {
    if (!shouldSilentCaptureProfileData({ candidate, normalizedData, hasDataIntent })) return false;

    const updateData = buildSilentProfileCaptureUpdate({ candidate, normalizedData });
    delete updateData.vacancyId;
    const progressFields = new Set([
      'currentStep',
      'botResumeMode',
      'reminderScheduledFor',
      'reminderState'
    ]);
    const profileFields = Object.keys(updateData).filter((field) => !progressFields.has(field));
    const expectedProfile = Object.fromEntries(
      profileFields.map((field) => [field, candidate[field] ?? null])
    );

    const transition = await applyCandidateSilentProfileCapture(prisma, {
      candidateId: candidate.id,
      expected: {
        currentStep: candidate.currentStep,
        vacancyId: candidate.vacancyId ?? null,
        botResumeMode: candidate.botResumeMode ?? null,
        reminderScheduledFor: candidate.reminderScheduledFor ?? null,
        reminderState: candidate.reminderState ?? 'NONE',
        ...expectedProfile
      },
      update: updateData
    });

    if (transition.count !== 1) {
      candidate = transition.candidate || candidate;
      debugTrace.silent_profile_capture = {
        applied: false,
        conflict: true,
        fields: profileFields,
        reason,
        replyKind,
        observedStep: candidate.currentStep || null,
        observedVacancyId: candidate.vacancyId || null
      };
      await recordIntentionalSilence(prisma, candidate, cleanText, {
        reason: 'STALE_CANDIDATE_SILENT_PROFILE_CAPTURE',
        gate: 'silent_profile_capture',
        action: reason,
        replyKind,
        vacancyId: candidate.vacancyId || null
      });
      return true;
    }

    candidate = transition.candidate || candidate;
    debugTrace.silent_profile_capture = {
      applied: true,
      fields: transition.profileFields,
      reason,
      replyKind
    };

    const body = buildSilentProfileCaptureReply({
      candidate,
      city: vacancyHints.city,
      requestedRoleText: vacancyHints.roleHint
    });

    await reply(prisma, candidate.id, from, body, cleanText, {
      body,
      source: 'silent_profile_capture',
      reason,
      replyKind
    });

    return true;
  };

  if (vacancyFirstGateDecision.action === VacancyFirstGateAction.SUPPRESS_REPLY) {
    if (await maybeSilentCaptureProfileData(vacancyFirstGateDecision.reason, vacancyFirstGateDecision.replyKind || null)) return;

    await recordIntentionalSilence(prisma, candidate, cleanText, {
      reason: vacancyFirstGateDecision.reason,
      gate: 'vacancy_first_gate',
      action: vacancyFirstGateDecision.action,
      replyKind: vacancyFirstGateDecision.replyKind || null,
      recentReplyKind: vacancyFirstGateDecision.suppressedDecision?.replyKind || null,
      vacancyId: currentVacancy?.id || candidate?.vacancyId || vacancyFirstGateDecision.vacancyId || null
    });
    return;
  }

  if (vacancyFirstGateDecision.action === VacancyFirstGateAction.REPLY) {
    const applied = await applyVacancyFirstGateUpdates(vacancyFirstGateDecision.candidateUpdates);
    if (!applied.applied) return;
    return reply(prisma, candidate.id, from, vacancyFirstGateDecision.reply, cleanText, {
      body: vacancyFirstGateDecision.reply,
      source: 'vacancy_first_gate',
      reason: vacancyFirstGateDecision.reason,
      replyKind: vacancyFirstGateDecision.replyKind
    });
  }

  if (vacancyFirstGateDecision.action === VacancyFirstGateAction.ENTER_FUTURE_PROFILE_CONSENT) {
    const applied = await applyVacancyFirstGateUpdates(vacancyFirstGateDecision.candidateUpdates);
    if (!applied.applied) return;
    return reply(prisma, candidate.id, from, vacancyFirstGateDecision.reply, cleanText, {
      body: vacancyFirstGateDecision.reply,
      source: 'vacancy_first_gate',
      reason: vacancyFirstGateDecision.reason,
      replyKind: vacancyFirstGateDecision.replyKind
    });
  }

  if (vacancyFirstGateDecision.action === VacancyFirstGateAction.INACTIVE_VACANCY_REPLY) {
    const applied = await applyVacancyFirstGateUpdates(vacancyFirstGateDecision.candidateUpdates || {
      currentStep: ConversationStep.GREETING_SENT
    });
    if (!applied.applied) return;
    return reply(prisma, candidate.id, from, vacancyFirstGateDecision.reply, cleanText, {
      body: vacancyFirstGateDecision.reply,
      source: 'vacancy_first_gate',
      reason: vacancyFirstGateDecision.reason,
      replyKind: vacancyFirstGateDecision.replyKind,
      safetyVacancy: currentVacancy || vacancyFirstGateDecision.vacancy
    });
  }

  if (vacancyFirstGateDecision.action === VacancyFirstGateAction.ASSIGN_VACANCY_AND_CONTINUE) {
    const shouldAnswerQuestionAndCollect = candidate.currentStep === ConversationStep.MENU
      && isAffirmativeInterest(cleanText)
      && isQuestionLike(cleanText);
    const nextStep = shouldAnswerQuestionAndCollect
      ? ConversationStep.COLLECTING_DATA
      : (candidate.currentStep === ConversationStep.MENU
        ? ConversationStep.GREETING_SENT
        : candidate.currentStep);
    const applied = await applyVacancyFirstGateUpdates({
      vacancyId: vacancyFirstGateDecision.vacancyId,
      currentStep: nextStep
    });
    if (!applied.applied) return;
    currentVacancy = vacancyFirstGateDecision.vacancy || await loadVacancyContext(prisma, vacancyFirstGateDecision.vacancyId);
    normalizedData = alignCandidateLocationFields(normalizedData, currentVacancy, { clearAlternate: false });
    debugTrace.normalized_fields = normalizedData;
    const candidateState = {
      ...candidate,
      vacancyId: vacancyFirstGateDecision.vacancyId,
      currentStep: nextStep
    };
    const body = shouldAnswerQuestionAndCollect
      ? buildQuestionFollowUpReply(
        currentVacancy,
        cleanText,
        buildCandidateDataCollectionMessage(candidateState, currentVacancy),
        candidateState
      )
      : buildVacancyReplyNatural(currentVacancy, candidateState, cleanText);
    return reply(prisma, candidate.id, from, body, cleanText, {
      body,
      source: 'vacancy_first_gate',
      reason: vacancyFirstGateDecision.reason,
      safetyVacancy: currentVacancy
    });
  }

  if (candidate.currentStep === ConversationStep.MENU) {
    const resolution = currentVacancy && candidate.vacancyId
      ? {
        resolved: true,
        vacancy: currentVacancy,
        city: currentVacancy.operation?.city?.name || currentVacancy.city || null,
        roleHint: vacancyHints.roleHint,
        reason: 'resolved_before_menu'
      }
      : await resolveVacancyForCandidate();
    const updateData = { currentStep: ConversationStep.GREETING_SENT };
    if (resolution.resolved && resolution.vacancy) {
      if (Object.keys(normalizedData).length) {
        const initialDecisions = splitFieldDecisions(normalizedData, candidate, {
          sourceByField,
          allowOverwriteFields: inferNaturalOverwriteFields(cleanText, normalizedData, candidate, candidate.currentStep)
        });
        if (initialDecisions.persistedFields.length) {
          debugTrace.persisted_fields.push(...initialDecisions.persistedFields);
          if (initialDecisions.consolidatedFields.length) {
            debugTrace.consolidated_fields.push(...initialDecisions.consolidatedFields);
          }
          Object.assign(updateData, initialDecisions.persistedData);
        }
      }
      debugTrace.vacancy_resolution_skipped_outside_gate = resolution.vacancy.id;
    }
    await prisma.candidate.update({ where: { id: candidate.id }, data: updateData });

    if (resolution.resolved && resolution.vacancy) {
      const candidateState = { ...candidate, ...updateData };
      return replyWithVacancyContext(candidateState, resolution.vacancy);
    }

    if (await replyFromVacancyResolutionFailure(resolution)) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.GREETING_SENT } });
      return;
    }

    return reply(prisma, candidate.id, from, SALUDO_INICIAL, cleanText, { body: SALUDO_INICIAL, source: 'bot_vacancy_prompt' });
  }


  if (
    !currentVacancy
    && isVacancyInfoQuestion(cleanText)
    && !hasMaterialProfileFieldCapture
  ) {
    const resolution = await resolveVacancyForCandidate();
    await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.GREETING_SENT } });
    if (resolution.resolved && resolution.vacancy) {
      debugTrace.vacancy_resolution_skipped_outside_gate = resolution.vacancy.id;
      return replyWithVacancyContext({ ...candidate, currentStep: ConversationStep.GREETING_SENT }, resolution.vacancy);
    }
    if (await replyFromVacancyResolutionFailure(resolution)) return;
    const activeVacancies = await findActiveVacancies(prisma);
    const promptCity = vacancyHints.city || resolution.city;
    const cityVacancies = promptCity
      ? activeVacancies.filter((vacancy) => normalizeComparableText(vacancy.operation?.city?.name || vacancy.city || '') === normalizeComparableText(promptCity))
      : [];
    const body = buildVacancyInterestPrompt(promptCity, cityVacancies);
    return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_vacancy_prompt' });
  }

  if (candidate.currentStep !== ConversationStep.DONE && isNegativeInterest(cleanText)) {
    await prisma.candidate.update({
      where: { id: candidate.id },
      data: {
        currentStep: ConversationStep.DONE,
        reminderScheduledFor: null,
        reminderState: 'SKIPPED'
      }
    });
    await reply(prisma, candidate.id, from, CIERRE_NO_INTERES, cleanText, { body: CIERRE_NO_INTERES, source: 'bot_flow' });
    return;
  }

  if (
    currentVacancy
    && (candidate.currentStep === ConversationStep.SCHEDULING || candidate.currentStep === ConversationStep.SCHEDULED)
    && isSchedulingEligibleCandidate(candidate, currentVacancy)
    && isDocumentValidationQuestion(cleanText)
  ) {
    return pauseSilentlyForManualReview(prisma, candidate, 'Consulta documental pendiente de validacion manual', cleanText);
  }

  if (
    currentVacancy
    && isQuestionLike(cleanText)
    && !isSchedulingConfirmationIntent(cleanText)
    && !isSchedulingRescheduleIntent(cleanText)
    && !isDocumentValidationQuestion(cleanText)
    && !hasMaterialProfileFieldCapture
    && [
      ConversationStep.ASK_CV,
      ConversationStep.SCHEDULING,
      ConversationStep.SCHEDULED,
      ConversationStep.DONE
    ].includes(candidate.currentStep)
  ) {
    return replyWithVacancyContext(candidate, currentVacancy);
  }

  const shouldDeferSchedulingConfirmationToDeterministicGuard = Boolean(
    candidate.currentStep === ConversationStep.SCHEDULING
    && currentVacancy
    && isSchedulingEligibleCandidate(candidate, currentVacancy)
    && isSchedulingConfirmationIntent(cleanText)
  );

  if (
    !shouldDeferSchedulingConfirmationToDeterministicGuard
    && !shouldPreferVacancyContextReply
    && !shouldPreferStructuredFieldReply
    && !hasDataIntent
    && await tryPrimaryEngineReply(candidate, currentVacancy)
  ) {
    return;
  }

  if (candidate.currentStep === ConversationStep.GREETING_SENT && !candidate.vacancyId) {
    const resolution = await resolveVacancyForCandidate();
    if (resolution.resolved && resolution.vacancy) {
      debugTrace.vacancy_resolution_skipped_outside_gate = resolution.vacancy.id;
      return replyWithVacancyContext(candidate, resolution.vacancy);
    }

    if (await replyFromVacancyResolutionFailure(resolution)) {
      return;
    }

    if (hasDataIntent) {
      if (await maybeSilentCaptureProfileData('greeting_without_vacancy_data_capture', null)) return;

      const activeVacancies = await findActiveVacancies(prisma);
      const cityVacancies = vacancyHints.city
        ? activeVacancies.filter((vacancy) => (
          normalizeComparableText(vacancy.operation?.city?.name || vacancy.city || '') === normalizeComparableText(vacancyHints.city)
        ))
        : [];
      const body = buildVacancyAssociationPrompt({
        dataCaptured: true,
        hasCv: hasHv(candidate),
        city: vacancyHints.city,
        cityVacancyOptions: cityVacancies
      });
      return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_vacancy_prompt' });
    }

    return reply(prisma, candidate.id, from, SALUDO_INICIAL, cleanText, { body: SALUDO_INICIAL, source: 'bot_vacancy_prompt' });
  }

  if (shouldPreferStructuredFieldReply && isMedicalRestrictionsClarificationRequest(cleanText)) {
    const body = buildMedicalRestrictionsClarifier();
    return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
  }

  const askedVacancyQuestion = Boolean(
    currentVacancy
    && isQuestionLike(cleanText)
    && !isSchedulingConfirmationIntent(cleanText)
    && !isSchedulingRescheduleIntent(cleanText)
    && !isDocumentValidationQuestion(cleanText)
  );

  if ((resolvedIntent === 'faq' || isFAQ(cleanText)) && candidate.currentStep !== ConversationStep.DONE) {
    if (currentVacancy) return replyWithVacancyContext(candidate, currentVacancy);
    return reply(prisma, candidate.id, from, FAQ_RESPONSE, cleanText, { body: FAQ_RESPONSE, source: 'bot_vacancy_prompt' });
  }

  if (askedVacancyQuestion && !hasDataIntent) {
    return replyWithVacancyContext(candidate, currentVacancy);
  }

  if ((candidate.currentStep === ConversationStep.SCHEDULING || candidate.currentStep === ConversationStep.SCHEDULED) && currentVacancy && isSchedulingEligibleCandidate(candidate, currentVacancy)) {
    const nextSlot = await resolveInterviewSlotContext(prisma, candidate, currentVacancy, cleanText);
    const activeBooking = await loadActiveInterviewBooking(prisma, candidate.id);
    const interviewIntent = detectInterviewIntent({ text: cleanText, booking: activeBooking, now: new Date() });

    if (interviewIntent === 'cancel_interview') {
      const transition = await applyActiveInterviewResponse(prisma, candidate, activeBooking, cleanText, 'cancel_interview');
      if (!transition) return;

      const reminderTransition = await reflectCandidateInterviewCancellationReminder(prisma, {
        candidateId: candidate.id,
        expected: {
          reminderScheduledFor: candidate.reminderScheduledFor ?? null,
          reminderState: candidate.reminderState
        }
      });
      if (reminderTransition.count !== 1) {
        const observedCandidate = reminderTransition.candidate || candidate;
        console.warn('[STALE_CANDIDATE_CANCELLATION_REMINDER]', JSON.stringify({
          candidateId: candidate.id,
          bookingId: activeBooking.id,
          expectedReminderState: candidate.reminderState || null,
          observedReminderState: observedCandidate?.reminderState || null
        }));
      }
      const body = buildInterviewCancellationReply();
      return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'interview_booking_cancel' });
    }

    if (interviewIntent === 'reschedule_interview' || isSchedulingRescheduleIntent(cleanText)) {
      if (activeBooking?.id && activeBooking?.status) {
        const transition = await applyActiveInterviewResponse(prisma, candidate, activeBooking, cleanText, 'reschedule_interview');
        if (!transition) return;
      } else if (interviewIntent === 'reschedule_interview') {
        await recordIntentionalSilence(prisma, candidate, cleanText, {
          reason: 'interview_booking_missing_for_response',
          gate: 'interview_booking_authority',
          action: 'reschedule_interview'
        });
        return;
      }

      const progressTransition = await reflectCandidateInterviewRescheduleProgress(prisma, {
        candidateId: candidate.id,
        expected: {
          currentStep: candidate.currentStep,
          reminderScheduledFor: candidate.reminderScheduledFor ?? null,
          reminderState: candidate.reminderState
        }
      });
      if (progressTransition.count !== 1) {
        const observedCandidate = progressTransition.candidate || candidate;
        console.warn('[STALE_CANDIDATE_RESCHEDULE_PROGRESS]', JSON.stringify({
          candidateId: candidate.id,
          bookingId: activeBooking?.id || null,
          expectedStep: candidate.currentStep,
          observedStep: observedCandidate?.currentStep || null,
          expectedReminderState: candidate.reminderState || null,
          observedReminderState: observedCandidate?.reminderState || null
        }));
        await recordIntentionalSilence(prisma, observedCandidate, cleanText, {
          reason: 'STALE_CANDIDATE_RESCHEDULE_PROGRESS',
          gate: 'candidate_state_authority',
          action: 'reschedule_interview',
          vacancyId: currentVacancy?.id || candidate.vacancyId || null
        });
        return;
      }
      candidate = progressTransition.candidate || candidate;

      if (!nextSlot?.slot) {
        await pauseInterviewFlow(prisma, candidate.id, 'No hay un siguiente slot valido para reagendar');
        const body = 'En este momento no tengo un siguiente horario válido para ofrecerte. El equipo te contactará para ayudarte con la reprogramación.';
        return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
      }

      const body = await buildInterviewOfferReply(candidate, currentVacancy, nextSlot, true);
      return reply(prisma, candidate.id, from, body, cleanText, buildInterviewReplyPayload(body, 'interview_reschedule', nextSlot, currentVacancy));
    }

    if (interviewIntent === 'confirm_attendance') {
      const transition = await applyActiveInterviewResponse(prisma, candidate, activeBooking, cleanText, 'confirm_attendance');
      if (!transition) return;

      const body = buildInterviewAttendanceConfirmedReply(nextSlot?.formattedDate);
      return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'interview_attendance_confirmed' });
    }

    if (candidate.currentStep === ConversationStep.SCHEDULING && isSchedulingConfirmationIntent(cleanText)) {
      const schedulingGuard = evaluateSchedulingGuard({ candidate, vacancy: currentVacancy, nextSlot, actionType: 'confirm_booking', acceptedOfferedSlot: true });
      if (!schedulingGuard.allowed) {
        await pauseInterviewFlow(prisma, candidate.id, `Agendamiento bloqueado: ${schedulingGuard.primaryReason}`);
        const body = schedulingGuard.readiness?.readyForCvRequest
          ? 'Antes de agendar, necesito que adjuntes tu hoja de vida como archivo PDF, DOC o DOCX.'
          : 'No puedo confirmar la entrevista todavía porque falta validar información del proceso. Te pido el dato pendiente o el equipo te contactará para terminar el agendamiento.';
        return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
      }

      await createBooking(prisma, candidate.id, candidate.vacancyId, nextSlot.slot.id, nextSlot.date, !nextSlot.windowOk);
      await prisma.candidate.update({
        where: { id: candidate.id },
        data: {
          currentStep: ConversationStep.SCHEDULED,
          reminderScheduledFor: null,
          reminderState: 'SKIPPED'
        }
      });
      const body = await buildInterviewConfirmationReply(candidate, currentVacancy, nextSlot);
      return reply(prisma, candidate.id, from, body, cleanText, buildInterviewReplyPayload(body, 'interview_booking_confirmation', nextSlot, currentVacancy));
    }

    if (candidate.currentStep === ConversationStep.SCHEDULED && isSchedulingConfirmationIntent(cleanText)) {
      const body = 'Gracias por tu mensaje. Tu entrevista ya está agendada; la confirmación de asistencia se registra cerca de la hora de entrevista.';
      return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'interview_confirmation_outside_window' });
    }

    if (isDocumentValidationQuestion(cleanText)) {
      return pauseSilentlyForManualReview(prisma, candidate, 'Consulta documental pendiente de validacion manual', cleanText);
    }

    if (isQuestionLike(cleanText)) {
      return replyWithVacancyContext(candidate, currentVacancy);
    }

    if (nextSlot?.slot) {
      const body = await buildInterviewOfferReply(candidate, currentVacancy, nextSlot, Boolean(nextSlot.isAlternative));
      const source = nextSlot.isAlternative ? 'interview_reschedule' : 'interview_offer';
      return reply(prisma, candidate.id, from, body, cleanText, buildInterviewReplyPayload(body, source, nextSlot, currentVacancy));
    }

    const body = 'Quedó registrado tu interés en entrevista. En este momento no tengo un horario válido para ofrecerte, así que el equipo de selección te contactará por este medio.';
    return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
  }

  if (candidate.currentStep === ConversationStep.ASK_CV && !hasDataIntent) {
    if (currentVacancy && isQuestionLike(cleanText)) {
      return replyWithVacancyContext(candidate, currentVacancy);
    }
    if (hasHv(candidate)) {
      return finalizeCandidateAfterCv(prisma, candidate, from);
    }
    return reply(prisma, candidate.id, from, RECORDATORIO_HV, cleanText, { body: RECORDATORIO_HV, source: 'bot_cv_request' });
  }

  if (candidate.currentStep === ConversationStep.DONE) {
    if (isApplicationFollowUpQuestion(cleanText)) {
      const body = 'Gracias por escribirnos. Tu postulación ya está registrada y tu hoja de vida también. Si hay novedades del proceso, te contactaremos por este medio.';
      return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_done_followup' });
    }
    if (hasDataIntent) {
      const { updatedCandidate: updated, decisions } = await applyDecisionsAndUpdate();
      if (decisions.persistedFields.length) {
        const body = buildUpdatedConfirmationReply(updated, decisions.persistedFields, currentVacancy);
        return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
      }
    }
    if (currentVacancy && isQuestionLike(cleanText)) {
      return replyWithVacancyContext(candidate, currentVacancy);
    }
    if (resolvedIntent === 'cv_intent') return reply(prisma, candidate.id, from, MENSAJE_DONE_CV_REPEAT, cleanText, { body: MENSAJE_DONE_CV_REPEAT, source: 'bot_cv_request' });
    if (resolvedIntent === 'post_completion_ack' || isPostCompletionAck(cleanText) || ['thanks', 'farewell'].includes(resolvedIntent)) {
      const ackSent = await wasDoneAckSent(prisma, candidate.id);
      if (ackSent) return;
      return reply(prisma, candidate.id, from, MENSAJE_DONE_ACK, cleanText, { body: MENSAJE_DONE_ACK, source: 'bot_done_ack' });
    }
    return;
  }

  async function applyDecisionsAndUpdate() {
    const current = await prisma.candidate.findUnique({ where: { id: candidate.id } });
    const explicitCorrection = /\b(corrijo|correccion|corrección|quise decir|actualizo|de hecho|mejor|perd[oó]n|en realidad|más bien|mas bien)\b/i.test(cleanText);
    const allowOverwriteFields = inferNaturalOverwriteFields(cleanText, normalizedData, current, candidate.currentStep);
    if (explicitCorrection) {
      Object.keys(normalizedData).forEach((field) => {
        if (!allowOverwriteFields.includes(field)) allowOverwriteFields.push(field);
      });
    }
    const decisions = splitFieldDecisions(normalizedData, current, { sourceByField, allowOverwriteFields });
    debugTrace.persisted_fields.push(...decisions.persistedFields);
    debugTrace.consolidated_fields?.push(...(decisions.consolidatedFields || []));
    debugTrace.rejected_fields.push(...decisions.rejectedFields);
    debugTrace.ignored_low_confidence_fields.push(...decisions.ignoredLowConfidenceFields);
    debugTrace.suspicious_full_name_rejected = decisions.suspiciousFullNameRejected;
    debugTrace.rejected_name_reason = decisions.rejectedNameReason;
    if (decisions.suspiciousFullNameRejected) console.warn('[AI_REJECTED_NAME]', JSON.stringify({ phone: candidate.phone, fullName: normalizedData.fullName || null, reason: decisions.rejectedNameReason || 'suspicious_name' }));
    const policyResult = isFeatureEnabled('FF_POLICY_LAYER', false)
      ? applyFieldPolicy({ fields: decisions.persistedData, fieldEvidence: evidenceByField }, current)
      : { persistedFields: decisions.persistedData, reviewQueue: [], blocked: [] };
    if (policyResult.reviewQueue.length) {
      debugTrace.policy_review_queue = policyResult.reviewQueue;
    }
    if (policyResult.blocked.length) {
      debugTrace.policy_blocked_fields = policyResult.blocked;
    }
    if (Object.keys(policyResult.persistedFields).length) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: policyResult.persistedFields });
    }
    const updatedCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id } });
    return { updatedCandidate, decisions };
  }

  const routeAfterConfirmation = async (updatedCandidate) => {
    const missing = getMissingFieldLabels(updatedCandidate, currentVacancy);
    if (missing.length) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.COLLECTING_DATA } });
      const replyText = buildMissingFieldsReply(updatedCandidate, normalizedData, currentVacancy);
      return reply(prisma, candidate.id, from, replyText, cleanText, { body: replyText, source: 'bot_flow' });
    }

    if (!updatedCandidate.vacancyId && !isFutureProfileCaptureCandidate(updatedCandidate)) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.GREETING_SENT } });
        const activeVacancies = await findActiveVacancies(prisma);
        const cityVacancies = vacancyHints.city
          ? activeVacancies.filter((vacancy) => (
            normalizeComparableText(vacancy.operation?.city?.name || vacancy.city || '') === normalizeComparableText(vacancyHints.city)
          ))
          : [];
        const body = buildVacancyAssociationPrompt({
          dataCaptured: true,
          hasCv: hasHv(updatedCandidate),
          city: vacancyHints.city,
          cityVacancyOptions: cityVacancies
        });
        return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_vacancy_prompt' });
    }

    if (resolveStepAfterDataCompletion({ hasCv: hasHv(updatedCandidate) }) === ConversationStep.DONE) {
      return finalizeCandidateAfterCv(prisma, updatedCandidate, from);
    }
    await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.ASK_CV } });
    return reply(prisma, candidate.id, from, SOLICITAR_HV, cleanText, { body: SOLICITAR_HV, source: 'bot_cv_request' });
  };

  if (candidate.currentStep === ConversationStep.CONFIRMING_DATA) {
    if (isAffirmativeConfirmation(cleanText)) {
      const updated = await prisma.candidate.findUnique({ where: { id: candidate.id } });
      return routeAfterConfirmation(updated);
    }

    const { updatedCandidate: updated, decisions } = await applyDecisionsAndUpdate();
    const correctedRequiredFields = decisions.persistedFields.filter((field) => getRequiredCandidateFieldKeys(currentVacancy).includes(field));
    const missingAfterCorrection = getMissingFieldLabels(updated, currentVacancy);

    if (correctedRequiredFields.length) {
      if (!missingAfterCorrection.length) {
        return routeAfterConfirmation(updated);
      }

      await prisma.candidate.update({
        where: { id: candidate.id },
        data: { currentStep: ConversationStep.COLLECTING_DATA }
      });
      const correctionReply = buildUpdatedConfirmationReply(updated, correctedRequiredFields, currentVacancy);
      const body = askedVacancyQuestion
        ? buildQuestionFollowUpReply(currentVacancy, cleanText, correctionReply)
        : correctionReply;
      return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
    }

    if (
      isMedicalRestrictionsClarificationRequest(cleanText)
      && missingAfterCorrection.length === 1
      && missingAfterCorrection[0] === 'restricciones medicas'
    ) {
      const body = buildMedicalRestrictionsClarifier();
      return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
    }

    if (resolvedIntent === 'confirmation_no_or_correction' && Object.keys(normalizedData).length === 0) {
      return reply(prisma, candidate.id, from, 'Gracias por avisar. Indícame por favor el dato que deseas corregir y lo actualizo.');
    }
    const latest = await prisma.candidate.findUnique({ where: { id: candidate.id } });
    const followUp = buildConfirmationClarifier(latest, currentVacancy);
    const body = askedVacancyQuestion
      ? buildQuestionFollowUpReply(currentVacancy, cleanText, followUp, updated)
      : followUp;
    return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
  }

  if (candidate.currentStep === ConversationStep.GREETING_SENT) {
    if (isNegativeInterest(cleanText)) {
      await prisma.candidate.update({
        where: { id: candidate.id },
        data: {
          currentStep: ConversationStep.DONE,
          reminderScheduledFor: null,
          reminderState: 'SKIPPED'
        }
      });
      await reply(prisma, candidate.id, from, CIERRE_NO_INTERES, cleanText, { body: CIERRE_NO_INTERES, source: 'bot_flow' });
      return;
    }

    const vacancyAssociationOnly = currentVacancy
      && !hasNonNameProfileFieldCapture
      && Boolean(vacancyHints.city || vacancyHints.roleHint);

    if (vacancyAssociationOnly) {
      const candidateState = { ...candidate, vacancyId: currentVacancy.id };
      return replyWithVacancyContext(candidateState, currentVacancy);
    }

    if (isAffirmativeInterest(cleanText) || hasDataIntent) {
      if (!currentVacancy && !candidate.vacancyId && !isFutureProfileCaptureCandidate(candidate)) {
        const activeVacancies = await findActiveVacancies(prisma);
        const cityVacancies = vacancyHints.city
          ? activeVacancies.filter((vacancy) => (
            normalizeComparableText(vacancy.operation?.city?.name || vacancy.city || '') === normalizeComparableText(vacancyHints.city)
          ))
          : [];
        const body = buildVacancyAssociationPrompt({
          dataCaptured: hasDataIntent,
          hasCv: hasHv(candidate),
          city: vacancyHints.city,
          cityVacancyOptions: cityVacancies
        });
        return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_vacancy_prompt' });
      }

      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.COLLECTING_DATA } });
      if (hasDataIntent) {
        const rejection = currentVacancy && isVacancyOpen(currentVacancy) && !isFutureProfileCaptureCandidate(candidate)
          ? shouldRejectByRequirements(cleanText, normalizedData, evidenceByField, currentVacancy)
          : { reject: false };
        if (rejection.reject) return rejectCandidate(prisma, candidate.id, from, rejection);
        const { updatedCandidate: updated } = await applyDecisionsAndUpdate();

        if (shouldAskForConfirmation(updated, normalizedData, currentVacancy)) {
          await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.CONFIRMING_DATA } });
          const confirmationText = buildConfirmationSummary(updated, {}, currentVacancy);
          const body = askedVacancyQuestion
            ? buildQuestionFollowUpReply(currentVacancy, cleanText, confirmationText, updated)
            : confirmationText;
          return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
        }
        const followUp = buildMissingFieldsReply(updated, normalizedData, currentVacancy);
        const body = askedVacancyQuestion
          ? buildQuestionFollowUpReply(currentVacancy, cleanText, followUp, updated)
          : followUp;
        return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
      }

      const dataPrompt = buildCandidateDataCollectionMessage(candidate, currentVacancy);
      const body = askedVacancyQuestion
        ? buildQuestionFollowUpReply(currentVacancy, cleanText, dataPrompt, candidate)
        : dataPrompt;
      return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
    }

    const rejection = currentVacancy && isVacancyOpen(currentVacancy) && !isFutureProfileCaptureCandidate(candidate)
      ? shouldRejectByRequirements(cleanText, normalizedData, evidenceByField, currentVacancy)
      : { reject: false };
    if (rejection.reject) return rejectCandidate(prisma, candidate.id, from, rejection);

    if (Object.keys(normalizedData).length >= 1) {
      if (!currentVacancy && !candidate.vacancyId && !isFutureProfileCaptureCandidate(candidate)) {
        const activeVacancies = await findActiveVacancies(prisma);
        const cityVacancies = vacancyHints.city
          ? activeVacancies.filter((vacancy) => (
            normalizeComparableText(vacancy.operation?.city?.name || vacancy.city || '') === normalizeComparableText(vacancyHints.city)
          ))
          : [];
        const body = buildVacancyAssociationPrompt({
          dataCaptured: true,
          hasCv: hasHv(candidate),
          city: vacancyHints.city,
          cityVacancyOptions: cityVacancies
        });
        return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_vacancy_prompt' });
      }

      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.COLLECTING_DATA } });
      const { updatedCandidate: updated } = await applyDecisionsAndUpdate();

      if (shouldAskForConfirmation(updated, normalizedData, currentVacancy)) {
        await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.CONFIRMING_DATA } });
        const confirmationText = buildConfirmationSummary(updated, {}, currentVacancy);
        const body = askedVacancyQuestion
          ? buildQuestionFollowUpReply(currentVacancy, cleanText, confirmationText, updated)
          : confirmationText;
        return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
      }
      const followUp = buildMissingFieldsReply(updated, normalizedData, currentVacancy);
      const body = askedVacancyQuestion
        ? buildQuestionFollowUpReply(currentVacancy, cleanText, followUp, updated)
        : followUp;
      return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
    }

    return reply(prisma, candidate.id, from, GUIA_CONTINUAR, cleanText, { body: GUIA_CONTINUAR, source: 'bot_flow' });
  }

  if (candidate.currentStep === ConversationStep.COLLECTING_DATA || candidate.currentStep === ConversationStep.ASK_CV) {
    const vacancyAssociationOnly = currentVacancy
      && !hasNonNameProfileFieldCapture
      && Boolean(vacancyHints.city || vacancyHints.roleHint);

    if (vacancyAssociationOnly && !hasDataIntent) {
      return replyWithVacancyContext(candidate, currentVacancy);
    }

    if (!currentVacancy && !candidate.vacancyId && !isFutureProfileCaptureCandidate(candidate)) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.GREETING_SENT } });
      const activeVacancies = await findActiveVacancies(prisma);
      const cityVacancies = vacancyHints.city
        ? activeVacancies.filter((vacancy) => (
          normalizeComparableText(vacancy.operation?.city?.name || vacancy.city || '') === normalizeComparableText(vacancyHints.city)
        ))
        : [];
      const body = buildVacancyAssociationPrompt({
        dataCaptured: hasDataIntent,
        hasCv: hasHv(candidate),
        city: vacancyHints.city,
        cityVacancyOptions: cityVacancies
      });
      return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_vacancy_prompt' });
    }

    const rejection = currentVacancy && isVacancyOpen(currentVacancy) && !isFutureProfileCaptureCandidate(candidate)
      ? shouldRejectByRequirements(cleanText, normalizedData, evidenceByField, currentVacancy)
      : { reject: false };
    if (rejection.reject) return rejectCandidate(prisma, candidate.id, from, rejection);
    const { updatedCandidate: updated } = await applyDecisionsAndUpdate();
    const missingAfterUpdate = getMissingFieldLabels(updated, currentVacancy);

    if (!updated.vacancyId && !isFutureProfileCaptureCandidate(updated)) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.GREETING_SENT } });
      const activeVacancies = await findActiveVacancies(prisma);
      const cityVacancies = vacancyHints.city
        ? activeVacancies.filter((vacancy) => (
          normalizeComparableText(vacancy.operation?.city?.name || vacancy.city || '') === normalizeComparableText(vacancyHints.city)
        ))
        : [];
      const body = buildVacancyAssociationPrompt({
        dataCaptured: true,
        hasCv: hasHv(updated),
        city: vacancyHints.city,
        cityVacancyOptions: cityVacancies
      });
      return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_vacancy_prompt' });
    }

    if (currentMissingFields.length === 1 && missingAfterUpdate.length === 0) {
      return routeAfterConfirmation(updated);
    }

    if (
      isMedicalRestrictionsClarificationRequest(cleanText)
      && missingAfterUpdate.length === 1
      && missingAfterUpdate[0] === 'restricciones medicas'
    ) {
      const body = buildMedicalRestrictionsClarifier();
      return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
    }

    if (shouldAskForConfirmation(updated, normalizedData, currentVacancy)) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.CONFIRMING_DATA } });
      const confirmationText = buildConfirmationSummary(updated, {}, currentVacancy);
      const body = askedVacancyQuestion
        ? buildQuestionFollowUpReply(currentVacancy, cleanText, confirmationText, updated)
        : confirmationText;
      return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
    }

    const followUp = buildMissingFieldsReply(updated, normalizedData, currentVacancy);
    const body = askedVacancyQuestion
      ? buildQuestionFollowUpReply(currentVacancy, cleanText, followUp, updated)
      : followUp;
    return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
  }
}

async function scheduleMultilineWindow(prisma, candidateId, context = {}) {
  const windowMs = getMultilineWindowMs(context);
  return scheduleCandidateMultilineWindow(prisma, {
    candidateId,
    windowMs,
    now: new Date()
  });
}

async function fetchPendingTextBatch(prisma, candidateId) {
  return prisma.message.findMany({
    where: {
      candidateId,
      direction: MessageDirection.INBOUND,
      messageType: MessageType.TEXT,
      respondedAt: null
    },
    orderBy: { createdAt: 'asc' },
    take: 12
  });
}

async function tryAcquireMultilineProcessing(prisma, candidateId, scheduling = {}) {
  const acquired = await acquireCandidateMultilineBatch(prisma, {
    candidateId,
    expected: { multilineBatchVersion: scheduling.batchVersion },
    now: new Date()
  });
  return acquired.count === 1;
}

async function markPotentialDuplicateByDocument(prisma, candidateId) {
  if (typeof prisma.candidate.findFirst !== 'function') return;
  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: { id: true, phone: true, documentType: true, documentNumber: true }
  });
  if (!candidate?.documentType || !candidate?.documentNumber) return;

  const duplicate = await prisma.candidate.findFirst({
    where: {
      id: { not: candidate.id },
      documentType: candidate.documentType,
      documentNumber: candidate.documentNumber,
      phone: { not: candidate.phone }
    },
    select: { id: true, phone: true }
  });

  if (!duplicate) return;

  await prisma.candidate.update({
    where: { id: candidate.id },
    data: {
      potentialDuplicate: true,
      potentialDuplicateAt: new Date(),
      potentialDuplicateNote: `Documento coincide con ${duplicate.phone}`
    }
  });
}

export function webhookRouter(prisma) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.sendStatus(403);
  });

  router.post('/', async (req, res, next) => {
    try {
      const messages = extractMessages(req.body);
      if (!messages.length) return res.sendStatus(200);

      for (const message of messages) {
        const from = message.from;
        if (!from) continue;

        if (isSupervisorPhone(from)) {
          if (message.type === 'text') {
            await handleSupervisorInbound(prisma, message);
          } else {
            console.info('[ADMIN_SUPERVISOR_NON_TEXT_IGNORED]', JSON.stringify({ type: message.type || 'unknown', from }));
          }
          continue;
        }

        if (!checkRateLimit(from)) continue;

        const candidate = await prisma.candidate.upsert({ where: { phone: from }, update: {}, create: { phone: from } });

        if (message.type === 'text') {
          const body = message.text?.body || '';
          const cleanText = normalizeText(body);
          const inbound = await saveInboundMessage(prisma, candidate.id, message, body, MessageType.TEXT, from);
          if (!inbound.isNew) continue;

          await cancelReminderOnInbound(prisma, candidate.id);

          let freshCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id } });
          freshCandidate = await prepareCandidateForInboundAutomation(prisma, freshCandidate);
          if (shouldBlockAutomation(freshCandidate, { direction: 'INBOUND' })) continue;

          const scheduling = await scheduleMultilineWindow(prisma, candidate.id, {
            currentStep: freshCandidate.currentStep,
            vacancyResolved: Boolean(freshCandidate.vacancyId),
            text: cleanText
          });
          await sleep(scheduling.windowMs);

          const stillOwner = await tryAcquireMultilineProcessing(prisma, candidate.id, scheduling);
          if (!stillOwner) continue;

          const pendingBatch = await fetchPendingTextBatch(prisma, candidate.id);
          if (!pendingBatch.length) continue;

          const consolidatedText = consolidateTextMessages(pendingBatch);
          const anchorMessage = pendingBatch[pendingBatch.length - 1];
          let candidateForBatch = await prisma.candidate.findUnique({ where: { id: candidate.id } });
          candidateForBatch = await prepareCandidateForInboundAutomation(prisma, candidateForBatch);
          if (shouldBlockAutomation(candidateForBatch, { direction: 'INBOUND' })) continue;

          const debugTrace = createDebugTrace({ phone: from, currentStepBefore: candidateForBatch.currentStep });

          try {
            await processText(prisma, candidateForBatch, from, consolidatedText, debugTrace, {
              batchedMessageCount: pendingBatch.length,
              usedMultilineContext: pendingBatch.length > 1,
              consolidatedInputSummary: summarizeConsolidatedInput(consolidatedText)
            });
            await markPotentialDuplicateByDocument(prisma, candidate.id);
            await markConversationMessagesResponded(prisma, {
              messageIds: pendingBatch.map((item) => item.id),
              respondedAt: new Date()
            });
          } catch (error) {
            debugTrace.error_summary = summarizeError(error);
            console.error('[AI_TRACE]', JSON.stringify({ phone: from, error: debugTrace.error_summary }));
            throw error;
          } finally {
            const updatedCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id }, select: { currentStep: true } });
            debugTrace.currentStep_after = updatedCandidate?.currentStep || debugTrace.currentStep_before;
            console.log('[AI_TRACE]', JSON.stringify(debugTrace));
            await attachDebugTrace(prisma, anchorMessage.id, debugTrace);
          }
          continue;
        }

        const inboundType = resolveInboundMessageType(message);
        const inboundBody = buildInboundBody(message);
        const inbound = await saveInboundMessage(prisma, candidate.id, message, inboundBody, inboundType, from);
        if (!inbound.isNew) continue;

        await cancelReminderOnInbound(prisma, candidate.id);

        let freshCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id } });
        freshCandidate = await prepareCandidateForInboundAutomation(prisma, freshCandidate);
        const automationBlocked = shouldBlockAutomation(freshCandidate, { direction: 'INBOUND' });
        const debugTrace = createDebugTrace({ phone: from, currentStepBefore: freshCandidate.currentStep });
        debugTrace.cv_detected = message.type === 'document';
        const recentOutbound = await getRecentOutboundMessages(prisma, candidate.id);
        const shouldSuppressAttachmentReply = async (kind) => {
          const decision = await resolveVacancyFirstGate({
            prisma,
            candidate: freshCandidate,
            inboundText: '',
            currentStep: freshCandidate.currentStep,
            recentMessages: recentOutbound,
            attachmentContext: { isAttachment: true, kind }
          });
          if (decision.action === VacancyFirstGateAction.SUPPRESS_REPLY) {
            debugTrace.vacancy_first_gate = {
              action: decision.action,
              reason: decision.reason,
              attachmentKind: kind
            };
            return true;
          }
          return false;
        };
        const canQueueAdminForward = isFeatureEnabled('FF_ASYNC_ADMIN_MEDIA_FORWARD', false)
          && Boolean(process.env.ADMIN_MEDIA_FORWARD_NUMBERS)
          && Boolean(prisma?.jobQueue?.create);

        try {
          if (message.type === 'image') {
            const recentAttachmentsCount = await countRecentInboundAttachments(prisma, candidate.id, 15);
            debugTrace.recent_attachment_count = recentAttachmentsCount;
            if (await hasRecentResumePhotoReply(prisma, candidate.id, 15)) {
              debugTrace.attachment_photo_reply_suppressed = true;
              continue;
            }
            if (recentAttachmentsCount >= 4) {
              debugTrace.attachment_high_volume = true;
              await pauseInterviewFlow(prisma, candidate.id, 'Multiples adjuntos no procesables requieren revision humana');
              if (!automationBlocked) {
                await reply(prisma, candidate.id, from, 'Recibí varios adjuntos. Para evitar confundirme, dejo tu caso marcado para revisión del equipo; si tu hoja de vida está en PDF, DOC o DOCX, envíala en un solo archivo.', '', { source: 'bot_attachment_rate_limit', fallbackReason: 'attachment_high_volume' });
              }
              continue;
            }
            if (canQueueAdminForward) {
              await enqueueJob(prisma, {
                type: JOB_TYPES.ADMIN_FORWARD_ATTACHMENT,
                payload: { phone: from, candidateId: candidate.id, mediaType: 'image', image: message.image || {} },
                runAt: new Date(),
                dedupeKey: `admin-image:${candidate.id}:${message.id || Date.now()}`,
                maxAttempts: 4
              }).catch((error) => console.warn('[ADMIN_FORWARD_IMAGE_QUEUE_ERROR]', error?.message || error));
            }
            await notifySupervisorAttachment(prisma, freshCandidate, {
              mediaType: 'image',
              media: message.image || {},
              caption: message.image?.caption || ''
            }).catch((error) => console.warn('[ADMIN_SUPERVISOR_IMAGE_ERROR]', error?.message || error));
            if (isFeatureEnabled('FF_ATTACHMENT_ANALYZER', false)) {
              if (await shouldSuppressAttachmentReply('image')) continue;
              const syntheticAnalysis = {
                classification: 'CV_IMAGE_ONLY',
                confidence: 0.55,
                rationale: 'image_without_structured_cv',
                evidence: ['image']
              };
              await composeContextualAttachmentReply(prisma, {
                candidate: freshCandidate,
                from,
                inboundText: message.image?.caption || '',
                recentOutbound,
                situation: 'attachment_resume_photo',
                decision: 'no_save_cv_request_pdf_docx',
                attachmentAnalysis: syntheticAnalysis,
                fallbackIntent: 'request_cv_pdf_word',
                rawPayload: { replyIntent: 'request_cv_pdf_word' }
              });
            }
            continue;
          }

          if (message.type === 'audio') {
            if (canQueueAdminForward) {
              await enqueueJob(prisma, {
                type: JOB_TYPES.ADMIN_FORWARD_ATTACHMENT,
                payload: { phone: from, candidateId: candidate.id, mediaType: 'audio', audio: message.audio || {} },
                runAt: new Date(),
                dedupeKey: `admin-audio:${candidate.id}:${message.id || Date.now()}`,
                maxAttempts: 4
              }).catch((error) => console.warn('[ADMIN_FORWARD_AUDIO_QUEUE_ERROR]', error?.message || error));
            }
            await notifySupervisorAttachment(prisma, freshCandidate, {
              mediaType: 'audio',
              media: message.audio || {},
              caption: message.audio?.mime_type || ''
            }).catch((error) => console.warn('[ADMIN_SUPERVISOR_AUDIO_ERROR]', error?.message || error));
            continue;
          }

          if (message.type === 'document') {
            if (canQueueAdminForward) {
              await enqueueJob(prisma, {
                type: JOB_TYPES.ADMIN_FORWARD_ATTACHMENT,
                payload: { phone: from, candidateId: candidate.id, mediaType: 'document', document: message.document || {} },
                runAt: new Date(),
                dedupeKey: `admin-document:${candidate.id}:${message.id || Date.now()}`,
                maxAttempts: 4
              }).catch((error) => console.warn('[ADMIN_FORWARD_DOCUMENT_QUEUE_ERROR]', error?.message || error));
            }
            const recentDocumentsCount = await countRecentInboundDocuments(prisma, candidate.id, 15);
            debugTrace.recent_document_count = recentDocumentsCount;
            await notifySupervisorAttachment(prisma, freshCandidate, {
              mediaType: 'document',
              media: message.document || {},
              caption: message.document?.filename || '',
              sequence: recentDocumentsCount
            }).catch((error) => console.warn('[ADMIN_SUPERVISOR_DOCUMENT_ERROR]', error?.message || error));
            if (recentDocumentsCount >= 2) {
              debugTrace.attachment_multiple_documents = true;
              await pauseSilentlyForManualReview(
                prisma,
                freshCandidate,
                'Multiples documentos requieren seleccion humana de hoja de vida',
                message.document?.filename || '',
                { reviewType: 'multiple_documents', extra: { recentDocumentsCount } }
              );
              continue;
            }
            const mimeType = message.document?.mime_type || '';
            const filename = message.document?.filename || 'hoja_de_vida';
            if (!isCvMimeTypeAllowed(mimeType, filename)) {
              debugTrace.cv_invalid_mime = true;
              console.warn('[CV_ERROR]', JSON.stringify({ phone: from, mimeType, filename, reason: 'invalid_mime' }));
              if (!automationBlocked) {
                if (await shouldSuppressAttachmentReply('document')) continue;
                await composeContextualAttachmentReply(prisma, {
                  candidate: freshCandidate,
                  from,
                  inboundText: filename,
                  recentOutbound,
                  situation: 'attachment_other_doc',
                  decision: 'reject_non_supported_format_request_pdf_docx',
                  attachmentAnalysis: {
                    classification: 'OTHER',
                    confidence: 0.99,
                    rationale: 'invalid_mime',
                    evidence: [mimeType || 'unknown_mime']
                  },
                  fallbackIntent: 'request_cv_pdf_word'
                });
              }
            } else {
              try {
                const metadata = await fetchMediaMetadata(message.document.id);
                const cvBuffer = await downloadMedia(metadata.url);
                const attachmentAnalyzerEnabled = isFeatureEnabled('FF_ATTACHMENT_ANALYZER', false);
                const candidateBeforeSave = await prisma.candidate.findUnique({
                  where: { id: candidate.id },
                  select: { cvStorageKey: true, cvData: true, cvOriginalName: true, cvMimeType: true }
                });
                const shouldProtectExistingCv = !attachmentAnalyzerEnabled && hasHv(candidateBeforeSave);
                const analysis = attachmentAnalyzerEnabled
                  ? await analyzeAttachment({ buffer: cvBuffer, mimeType, filename })
                  : (shouldProtectExistingCv
                    ? await analyzeAttachment({ buffer: cvBuffer, mimeType, filename })
                    : { classification: 'CV_VALID', confidence: 1, evidence: 'legacy_flow' });
                await saveAttachmentAnalysis(
                  prisma,
                  candidate.id,
                  inbound.id,
                  { mimeType, fileName: filename },
                  analysis
                );

                if (analysis.classification === 'CV_VALID') {
                  await storeCandidateCv(prisma, candidate.id, cvBuffer, {
                    mimeType: mimeType || null,
                    originalName: filename
                  });
                  debugTrace.cv_saved = true;
                } else {
                  debugTrace.cv_saved = false;
                  const requiresHumanReview = shouldEscalateHumanReview({ attachmentAnalysis: analysis })
                    || (recentDocumentsCount >= 4 && analysis.classification === 'UNREADABLE');
                  if (requiresHumanReview) {
                    await pauseForManualQuestionReview(prisma, freshCandidate, from, filename || '');
                  } else {
                    const attachmentDecision = deriveAttachmentDecision(analysis.classification);
                    if (await shouldSuppressAttachmentReply('document')) continue;
                    await composeContextualAttachmentReply(prisma, {
                      candidate: freshCandidate,
                      from,
                      inboundText: filename,
                      recentOutbound,
                      situation: attachmentDecision.situation,
                      decision: 'attachment_not_saved_request_valid_cv',
                      attachmentAnalysis: analysis,
                      fallbackIntent: attachmentDecision.fallbackIntent,
                      requiresHumanReview: false,
                      rawPayload: { replyIntent: attachmentDecision.fallbackIntent }
                    });
                  }
                  continue;
                }
                console.log('[CV_TRACE]', JSON.stringify({ phone: from, filename, mimeType }));
                const afterCvSave = await prisma.candidate.findUnique({ where: { id: candidate.id } });
                if (!automationBlocked && afterCvSave.currentStep !== ConversationStep.DONE) {
                  if (!afterCvSave.vacancyId) {
                    debugTrace.vacancy_resolution = {
                      resolved: false,
                      vacancyId: null,
                      city: null,
                      roleHint: null,
                      reason: 'cv_saved_waiting_vacancy'
                    };
                    await prisma.candidate.update({
                      where: { id: candidate.id },
                      data: { currentStep: ConversationStep.GREETING_SENT }
                    });
                    await reply(prisma, candidate.id, from, ASK_VACANCY_FOR_CV, '', { body: ASK_VACANCY_FOR_CV, source: 'bot_vacancy_prompt' });
                    continue;
                  }
                  if (afterCvSave.currentStep === ConversationStep.SCHEDULING || afterCvSave.currentStep === ConversationStep.SCHEDULED) {
                    const activeBooking = await loadActiveInterviewBooking(prisma, candidate.id);
                    const body = activeBooking
                      ? `Hoja de vida actualizada. Tu entrevista sigue registrada para ${formatInterviewDate(new Date(activeBooking.scheduledAt))}.`
                      : 'Hoja de vida actualizada correctamente. Tu proceso de entrevista sigue en curso.';
                    await reply(prisma, candidate.id, from, body, '', { body, source: 'bot_flow' });
                    continue;
                  }
                  const afterCvVacancy = afterCvSave.vacancyId
                    ? await loadVacancyContext(prisma, afterCvSave.vacancyId)
                    : null;
                  const missing = getMissingFieldLabels(afterCvSave, afterCvVacancy);
                  if (shouldFinalizeAfterCv({ missingFields: missing })) {
                    await finalizeCandidateAfterCv(prisma, afterCvSave, from);
                  } else {
                    if (afterCvSave.currentStep !== ConversationStep.COLLECTING_DATA && afterCvSave.currentStep !== ConversationStep.CONFIRMING_DATA) {
                      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.COLLECTING_DATA } });
                    }
                    await composeContextualAttachmentReply(prisma, {
                      candidate: afterCvSave,
                      from,
                      inboundText: filename,
                      recentOutbound,
                      vacancy: afterCvVacancy,
                      situation: 'request_missing_data',
                      decision: 'cv_saved_request_remaining_fields',
                      attachmentAnalysis: analysis,
                      missingFields: missing,
                      fallbackIntent: 'request_missing_data'
                    });
                  }
                }
              } catch (error) {
                debugTrace.cv_download_failed = true;
                debugTrace.error_summary = summarizeError(error);
                console.error('[CV_ERROR]', JSON.stringify({ phone: from, error: debugTrace.error_summary }));
                if (!automationBlocked) {
                  await reply(prisma, candidate.id, from, 'No pude descargar tu hoja de vida en este momento. Inténtalo nuevamente en unos minutos.', '', { source: 'bot_flow' });
                }
              }
            }
          } else if (!automationBlocked && freshCandidate.currentStep === ConversationStep.DONE) {
            await reply(prisma, candidate.id, from, MENSAJE_DONE_CV_REPEAT, '', { source: 'bot_cv_request' });
          } else if (!automationBlocked) {
            await reply(prisma, candidate.id, from, 'Recibí tu mensaje. Para continuar el registro, envíame la información solicitada por escrito o la hoja de vida en PDF, DOC o DOCX si aplica.', '', { source: 'bot_flow' });
          }
        } finally {
          const updatedCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id }, select: { currentStep: true } });
          debugTrace.currentStep_after = updatedCandidate?.currentStep || debugTrace.currentStep_before;
          console.log('[CV_TRACE]', JSON.stringify(debugTrace));
          await attachDebugTrace(prisma, inbound.id, debugTrace);
        }
      }

      res.sendStatus(200);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
