import express from 'express';
import { CandidateStatus, ConversationStep, MessageDirection, MessageType } from '@prisma/client';
import { extractMessages, sendTextMessage } from '../services/whatsapp.js';
import { fetchMediaMetadata, downloadMedia } from '../services/media.js';
import { tryOpenAIParse } from '../services/aiParser.js';
import { createDebugTrace, inferIntent, sanitizeForRawPayload, splitFieldDecisions, summarizeError } from '../services/debugTrace.js';
import { isCvMimeTypeAllowed, resolveStepAfterDataCompletion, shouldFinalizeAfterCv } from '../services/cvFlow.js';
import { isHighConfidenceLocalField, normalizeCandidateFields, parseNaturalData } from '../services/candidateData.js';
import { consolidateTextMessages, getMultilineWindowMs, summarizeConsolidatedInput } from '../services/multiline.js';
import { cancelReminderOnInbound, scheduleReminderForCandidate } from '../services/reminder.js';
import { detectConversationIntent, isPostCompletionAck } from '../services/conversationIntent.js';
import { conversationUnderstanding } from '../services/conversationUnderstanding.js';
import { shouldBlockAutomation } from '../services/botAutomationPolicy.js';
import { runChatEngine } from '../services/chatEngine.js';
import { normalizeResolverText, resolveVacancyFromText } from '../services/vacancyResolver.js';
import { cancelCandidateBookings, createBooking, formatInterviewDate, getNextAvailableSlot, getNextAvailableSlotAfter, getInterviewReminderAt, hydrateOfferedSlot } from '../services/interviewScheduler.js';
import { generateBookingConfirmation, generateInterviewOffer } from '../services/naturalReply.js';

const FAQ_RESPONSE = 'Con gusto te ayudo. ¿Desde qué ciudad nos escribes y para qué vacante o cargo estás interesado?';
const SALUDO_INICIAL = 'Hola, gracias por comunicarte con LoginPro. ¿Desde qué ciudad nos escribes y para qué vacante o cargo estás interesado?';

const SOLICITAR_DATOS = 'Perfecto. Enviáme por favor estos datos para continuar: nombre completo, tipo de documento, número de documento, edad, barrio, si tienes experiencia en el cargo y cuánto tiempo, si tienes restricciones médicas y qué medio de transporte tienes. Puedes enviarlos en un solo mensaje, como te sea más fácil.';
const DESCARTE_MSG = 'Gracias por tu interés. En este caso no es posible continuar con tu postulación porque no cumples con uno de los requisitos definidos para esta vacante.';
const CIERRE_NO_INTERES = 'Entendido. Si más adelante deseas continuar con la postulación, puedes volver a escribirme y con gusto retomamos el proceso.';
const SOLICITAR_HV = '¡Gracias! Ya tengo tus datos. Por favor adjunta tu hoja de vida (HV) en PDF o Word (.doc/.docx) para finalizar tu postulación.';
const RECORDATORIO_HV = 'Para continuar necesito que adjuntes tu Hoja de vida (HV) en PDF o Word (.doc/.docx). Cuando la envíes, finalizamos tu proceso.';
const MENSAJE_FINAL = 'Tu información y hoja de vida quedaron registradas correctamente. El equipo de selección revisará tu perfil y, si el proceso continúa, te contactará por este medio.';
const MENSAJE_DONE_ACK = '¡Con gusto! Ya quedó tu registro completo. Si surge una novedad, te contactamos por este medio.';
const MENSAJE_DONE_CV_REPEAT = 'Ya tenemos tu registro completo. Si deseas actualizar tu hoja de vida, puedes enviarla y la adjuntamos a tu postulación.';
const GUIA_CONTINUAR = 'Puedo ayudarte a continuar con la postulación. Si deseas seguir, envíame tus datos y te voy guiando.';
const CONFIRMACION_PROMPT = '¿Está correcto? Responde Sí para continuar o envíame la corrección.';
const INTERVIEW_OFFER_SOURCES = new Set(['interview_offer', 'interview_reschedule']);

const REQUIRED_FIELDS = [
  'fullName',
  'documentType',
  'documentNumber',
  'age',
  'neighborhood',
  'experienceInfo',
  'experienceTime',
  'medicalRestrictions',
  'transportMode'
];

const USE_CONVERSATION_ENGINE = process.env.USE_CONVERSATION_ENGINE === 'true';

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
setInterval(() => {
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
  return /^(si|sí|correcto|esta bien|está bien|todo bien|confirmo|de acuerdo|ok|listo)\b/.test(n);
}
function isNegativeInterest(text) { const n = normalizeText(text).toLowerCase(); return /^(no+|nop+|negativo)$|no gracias|no me interesa|no estoy interesad|no deseo|paso|ya no|prefiero no/i.test(n); }
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
function shouldRejectByRequirements(text, parsed = {}) {
  const n = normalizeComparableText(text);
  if (parsed.age && (parsed.age < 18 || parsed.age > 50)) return { reject: true, reason: 'Edad fuera del rango permitido', details: `Edad detectada: ${parsed.age}` };
  if (explicitlyLacksValidDocument(n)) return { reject: true, reason: 'Documento no vigente', details: 'El candidato indicó no tener documento vigente.' };
  if (mentionsForeigner(text) && hasValidForeignDocumentMention(text, parsed)) return { reject: false };
  return { reject: false };
}
function getMissingFields(candidate) {
  const m = [];
  if (!candidate.fullName) m.push('nombre completo');
  if (!candidate.documentType) m.push('tipo de documento');
  if (!candidate.documentNumber) m.push('número de documento');
  if (!candidate.age) m.push('edad');
  if (!candidate.neighborhood) m.push('barrio');
  if (!candidate.experienceInfo) m.push('experiencia en el cargo');
  if (!candidate.experienceTime) m.push('tiempo de experiencia');
  if (!candidate.medicalRestrictions) m.push('restricciones médicas');
  if (!candidate.transportMode) m.push('medio de transporte');
  return m;
}
function containsCandidateData(text) { return Object.keys(parseNaturalData(text)).length > 0; }
function hasHv(candidate) { return Boolean(candidate?.cvData); }
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
  if (message.type === 'interactive') {
    return message.interactive?.button_reply?.title
      || message.interactive?.list_reply?.title
      || '';
  }
  return '';
}
function getNaturalDelayMs(inputText = '', outputText = '') { if (process.env.NODE_ENV === 'test') return 0; const l = Math.max(normalizeText(inputText).length, normalizeText(outputText).length, 1); return Math.max(1500, Math.min(2500, 1500 + Math.min(1000, Math.round(l * 8)))); }
function isQuestionLike(text = '') {
  const n = normalizeComparableText(text);
  return String(text || '').includes('?') || /\b(que|cual|cuales|como|cuando|donde|cuanto|quien|requisitos|condiciones|horario|pago|direccion|ubicacion|cargo)\b/.test(n);
}
function buildVacancyLocation(vacancy) {
  return [vacancy?.operation?.city?.name || vacancy?.city || null, vacancy?.operation?.name || null]
    .filter(Boolean)
    .join(' - ');
}
function buildVacancyQuestionLead(vacancy, text = '') {
  const n = normalizeComparableText(text);
  const location = buildVacancyLocation(vacancy);
  const addressLabel = vacancy?.schedulingEnabled ? 'la dirección de entrevista' : 'el punto de operación';
  if (/(donde|direccion|ubicacion|queda|sector)/.test(n)) {
    return vacancy?.operationAddress
      ? `Claro. La vacante está registrada para ${location || 'esa operación'} y ${addressLabel} es ${vacancy.operationAddress}.`
      : `Claro. La vacante está registrada para ${location || 'esa operación'}.`;
  }
  if (/(requisit|document|edad|experien|perfil)/.test(n) && vacancy?.requirements) {
    return `Claro. Los requisitos registrados para esta vacante son: ${vacancy.requirements}.`;
  }
  if (/(pago|salario|sueldo|turno|horario|condicion|beneficio|contrato)/.test(n) && vacancy?.conditions) {
    return `Claro. Las condiciones registradas para esta vacante son: ${vacancy.conditions}.`;
  }
  if (/(funcion|cargo|labor|hacer|rol)/.test(n)) {
    const description = vacancy?.roleDescription || vacancy?.role || vacancy?.title;
    return `Claro. El cargo registrado es ${vacancy?.title || vacancy?.role || 'la vacante consultada'}${description ? ` y la descripción disponible es: ${description}.` : '.'}`;
  }
  return 'Claro. Te comparto la información real que tengo registrada para esa vacante.';
}
function buildVacancyContinuePrompt(candidate) {
  if (candidate.currentStep === ConversationStep.ASK_CV) return RECORDATORIO_HV;
  if (candidate.currentStep === ConversationStep.COLLECTING_DATA || candidate.currentStep === ConversationStep.CONFIRMING_DATA) {
    const missing = getMissingFields(candidate);
    if (missing.length) return `Si deseas continuar, aún me faltan estos datos: ${missing.join(', ')}.`;
    return SOLICITAR_HV;
  }
  if (candidate.currentStep === ConversationStep.DONE) return MENSAJE_DONE_ACK;
  return 'Si estás interesado en continuar, respóndeme y te solicitaré tus datos.';
}
function buildMissingFieldsReply(candidate, normalizedData = {}) {
  const missing = getMissingFields(candidate);
  if (!missing.length) return '';
  const capturedCount = Object.keys(normalizedData || {})
    .filter((field) => REQUIRED_FIELDS.includes(field) && candidate[field] !== undefined && candidate[field] !== null && candidate[field] !== '')
    .length;
  if (capturedCount >= 2) return `Perfecto, ya registré esos datos. Para seguir necesito: ${missing.join(', ')}.`;
  if (capturedCount === 1) return `Listo, ese dato ya quedó registrado. Ahora necesito: ${missing.join(', ')}.`;
  return `Para continuar necesito: ${missing.join(', ')}.`;
}
function buildQuestionFollowUpReply(vacancy, inboundText = '', followUpText = '') {
  const answer = buildVacancyQuestionLead(vacancy, inboundText);
  return followUpText ? `${answer}\n\n${followUpText}` : answer;
}
function buildVacancyReply(vacancy, candidate, inboundText = '') {
  const lines = [];
  lines.push(isQuestionLike(inboundText) ? buildVacancyQuestionLead(vacancy, inboundText) : 'Hola, gracias por comunicarte con LoginPro.');
  lines.push('', 'Te comparto la información de la vacante disponible:', '', `*Vacante:* ${vacancy.title || vacancy.role}`);
  if (vacancy.role && vacancy.role !== vacancy.title) lines.push(`*Cargo:* ${vacancy.role}`);
  const location = buildVacancyLocation(vacancy);
  if (location) lines.push(`*Ciudad / operación:* ${location}`);
  if (vacancy.operationAddress) lines.push(`*${vacancy.schedulingEnabled ? 'Dirección de entrevista' : 'Dirección de operación'}:* ${vacancy.operationAddress}`);
  if (vacancy.roleDescription) lines.push(`*Descripción del cargo:* ${vacancy.roleDescription}`);
  if (vacancy.requirements) lines.push(`*Requisitos:* ${vacancy.requirements}`);
  if (vacancy.conditions) lines.push(`*Condiciones:* ${vacancy.conditions}`);
  lines.push('', buildVacancyContinuePrompt(candidate));
  return lines.join('\n');
}

function isSchedulingEligibleCandidate(candidate, vacancy) {
  return Boolean(vacancy?.schedulingEnabled && candidate?.gender !== 'FEMALE');
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

function buildInterviewReplyPayload(body, source, nextSlot) {
  return {
    body,
    source,
    slotId: nextSlot?.slot?.id || null,
    scheduledAt: nextSlot?.date?.toISOString?.() || null,
    formattedDate: nextSlot?.formattedDate || null,
    reminderAt: nextSlot?.reminderAt?.toISOString?.() || null,
    skipCount: nextSlot?.skipCount ?? 0
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
      slotId: true,
      scheduledAt: true
    }
  });
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

function buildConfirmationSummary(candidate) {
  const documentLabel = candidate.documentType && candidate.documentNumber
    ? `${candidate.documentType} ${candidate.documentNumber}`
    : 'Pendiente';
  return [
    'Perfecto, por favor confirma estos datos:',
    `• Nombre completo: ${candidate.fullName || 'Pendiente'}`,
    `• Documento: ${documentLabel}`,
    `• Edad: ${candidate.age ? `${candidate.age} años` : 'Pendiente'}`,
    `• Barrio: ${candidate.neighborhood || 'Pendiente'}`,
    `• Experiencia: ${candidate.experienceInfo || 'Pendiente'}`,
    `• Tiempo de experiencia: ${candidate.experienceTime || 'Pendiente'}`,
    `• Restricciones médicas: ${candidate.medicalRestrictions || 'Pendiente'}`,
    `• Medio de transporte: ${candidate.transportMode || 'Pendiente'}`,
    CONFIRMACION_PROMPT
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
    candidateName: candidate.fullName
  });
}

function shouldAskForConfirmation(candidate, normalizedData) {
  if (candidate.currentStep === ConversationStep.CONFIRMING_DATA) return true;
  const missing = getMissingFields(candidate);
  const hasMainBlock = REQUIRED_FIELDS.every((field) => candidate[field] !== null && candidate[field] !== undefined && candidate[field] !== '');
  if (hasMainBlock) return true;
  if (!missing.length) return true;

  const correctedFields = Object.keys(normalizedData || {});
  const requiresReconfirm = correctedFields.some((field) => REQUIRED_FIELDS.includes(field));
  return requiresReconfirm && correctedFields.length >= 2 && missing.length <= 2;
}

async function buildEngineContext(prisma, candidate, inboundText = '', providedVacancy = null) {
  const vacancy = providedVacancy || (candidate.vacancyId
    ? await loadVacancyContext(prisma, candidate.vacancyId)
    : null);

  const recentMessagesRaw = await prisma.message.findMany({
    where: { candidateId: candidate.id },
    orderBy: { createdAt: 'desc' },
    take: 8,
    select: { direction: true, body: true },
  });

  const recentMessages = recentMessagesRaw
    .reverse()
    .map((m) => ({ direction: m.direction, body: m.body || '' }));

  const nextSlot = vacancy
    ? await resolveInterviewSlotContext(prisma, candidate, vacancy, inboundText)
    : null;

  return { vacancy, recentMessages, nextSlot };
}

async function replyWithEngine(prisma, candidate, from, inboundText, providedVacancy = null) {
  const { vacancy, recentMessages, nextSlot } = await buildEngineContext(prisma, candidate, inboundText, providedVacancy);
  const engineResult = await runChatEngine({
    prisma,
    candidate,
    vacancy,
    inboundText,
    recentMessages,
    nextSlot,
  });
  const candidateAfterActions = await prisma.candidate.findUnique({ where: { id: candidate.id } }) || candidate;

  const primaryAction = getPrimaryEngineAction(engineResult.actions);
  let body = engineResult.reply;
  let source = 'engine';

  if (primaryAction === 'offer_interview' || primaryAction === 'reschedule') {
    body = await buildInterviewOfferReply(candidateAfterActions, vacancy, nextSlot, primaryAction === 'reschedule' || Boolean(nextSlot?.isAlternative));
    source = (primaryAction === 'reschedule' || nextSlot?.isAlternative) ? 'interview_reschedule' : 'interview_offer';
  } else if (primaryAction === 'confirm_booking') {
    body = await buildInterviewConfirmationReply(candidateAfterActions, vacancy, nextSlot);
    source = 'interview_booking_confirmation';
  }

  const rawPayload = source.startsWith('interview_')
    ? buildInterviewReplyPayload(body, source, nextSlot)
    : { body, source };

  return reply(prisma, candidate.id, from, body, inboundText, rawPayload);
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

async function finalizeCandidateAfterCv(prisma, candidate, from) {
  const vacancy = candidate.vacancyId ? await loadVacancyContext(prisma, candidate.vacancyId) : null;

  if (isSchedulingEligibleCandidate(candidate, vacancy)) {
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
    return reply(prisma, candidate.id, from, body, '', buildInterviewReplyPayload(body, 'interview_offer', nextSlot));
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
  const insertResult = await prisma.message.createMany({
    data: [{ candidateId, waMessageId, direction: MessageDirection.INBOUND, messageType: type, body, rawPayload: sanitizeForRawPayload(message) }],
    skipDuplicates: true
  });

  if (insertResult.count === 0) {
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
  const current = await prisma.message.findUnique({ where: { id: messageId }, select: { rawPayload: true } });
  await prisma.message.update({ where: { id: messageId }, data: { rawPayload: { ...(current?.rawPayload || {}), debugTrace } } });
}
async function saveOutboundMessage(prisma, candidateId, body, rawPayload = { body }) {
  const payload = { body, source: 'bot_flow', ...(rawPayload || {}) };
  await prisma.message.create({ data: { candidateId, direction: MessageDirection.OUTBOUND, messageType: MessageType.TEXT, body, rawPayload: payload } });
  await prisma.candidate.update({ where: { id: candidateId }, data: { lastOutboundAt: new Date() } });
}
async function reply(prisma, candidateId, to, body, inboundText = '', rawPayload = { body, source: 'bot_flow' }) {
  await sleep(getNaturalDelayMs(inboundText, body));
  await sendTextMessage(to, body);
  await saveOutboundMessage(prisma, candidateId, body, rawPayload);
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
  await prisma.candidate.update({
    where: { id: candidateId },
    data: {
      status: CandidateStatus.RECHAZADO,
      currentStep: ConversationStep.DONE,
      rejectionReason: rejection.reason || 'No cumple requisitos',
      rejectionDetails: rejection.details || null,
      reminderScheduledFor: null,
      reminderState: 'SKIPPED'
    }
  });
  await reply(prisma, candidateId, from, DESCARTE_MSG, '', { body: DESCARTE_MSG, source: 'bot_flow' });
}

async function processText(prisma, candidate, from, text, debugTrace, options = {}) {
  const cleanText = normalizeText(text);
  const hasDataIntent = containsCandidateData(cleanText);
  const fallbackIntent = detectConversationIntent(cleanText, { isDoneStep: candidate.currentStep === ConversationStep.DONE });
  debugTrace.openai_intent = inferIntent(cleanText);
  debugTrace.batched_message_count = options.batchedMessageCount || 1;
  debugTrace.used_multiline_context = Boolean(options.usedMultilineContext);
  debugTrace.consolidated_input_summary = options.consolidatedInputSummary || null;

  const aiResult = await tryOpenAIParse(cleanText);
  const understanding = await conversationUnderstanding(cleanText, { aiResult });
  const localParsedData = parseNaturalData(cleanText);
  const aiFields = aiResult.parsedFields || {};
  const sourceByField = {};
  const mergedData = {};

  for (const [field, value] of Object.entries(localParsedData)) {
    if (value === undefined || value === null || value === '') continue;
    if (isHighConfidenceLocalField(field, value)) {
      mergedData[field] = value;
      sourceByField[field] = 'local';
    }
  }
  for (const [field, value] of Object.entries(aiFields)) {
    if (value === undefined || value === null || value === '') continue;
    mergedData[field] = value;
    sourceByField[field] = sourceByField[field] ? 'merged' : 'openai';
  }
  const normalizedData = normalizeCandidateFields(mergedData);

  debugTrace.openai_used = aiResult.used;
  debugTrace.openai_status = aiResult.status === 'error' ? 'fallback' : aiResult.status;
  debugTrace.openai_model = aiResult.model || debugTrace.openai_model;
  debugTrace.openai_temperature_omitted = typeof aiResult.temperature_omitted === 'boolean'
    ? aiResult.temperature_omitted
    : debugTrace.openai_temperature_omitted;
  const resolvedIntent = aiResult.intent || understanding.intent || fallbackIntent;
  const vacancyHints = {
    city: aiFields.city || understanding.cityDetection?.value || null,
    roleHint: aiFields.roleHint || understanding.vacancyDetection?.value || null,
  };
  if (resolvedIntent) debugTrace.openai_intent = resolvedIntent;
  debugTrace.openai_detected_fields = Object.keys(aiFields).filter((k) => normalizedData[k] !== undefined);
  debugTrace.source_by_field = sourceByField;
  debugTrace.normalized_fields = normalizedData;
  debugTrace.vacancy_hint_city = vacancyHints.city;
  debugTrace.vacancy_hint_role = vacancyHints.roleHint;

  const resolveVacancyForCandidate = async () => {
    const resolution = await resolveVacancyFromText(prisma, cleanText, {
      cityHint: vacancyHints.city,
      roleHint: vacancyHints.roleHint,
    });
    debugTrace.vacancy_resolution = {
      resolved: resolution.resolved,
      vacancyId: resolution.vacancy?.id || null,
      city: resolution.city,
      roleHint: resolution.roleHint,
      reason: resolution.reason,
    };
    return resolution;
  };

  const replyWithVacancyContext = async (candidateState, vacancy = null) => {
    const effectiveVacancy = vacancy || await loadVacancyContext(prisma, candidateState.vacancyId);
    if (!effectiveVacancy) {
      return reply(prisma, candidate.id, from, FAQ_RESPONSE, cleanText, { body: FAQ_RESPONSE, source: 'bot_vacancy_prompt' });
    }
    if (USE_CONVERSATION_ENGINE && isQuestionLike(cleanText)) {
      return replyWithEngine(prisma, candidateState, from, cleanText, effectiveVacancy);
    }
    const body = buildVacancyReply(effectiveVacancy, candidateState, cleanText);
    return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_vacancy_context' });
  };

  if (aiResult.status === 'error') {
    debugTrace.error_summary = summarizeError(aiResult.error);
    console.warn('[AI_FALLBACK]', JSON.stringify({ phone: candidate.phone, error: debugTrace.error_summary }));
  } else if (aiResult.status === 'disabled') {
    console.log('[AI_FALLBACK]', JSON.stringify({ phone: candidate.phone, reason: 'openai_disabled' }));
  }

  if (candidate.status === CandidateStatus.RECHAZADO) return reply(prisma, candidate.id, from, DESCARTE_MSG);

  if (candidate.currentStep === ConversationStep.MENU) {
    const resolution = await resolveVacancyForCandidate();
    const updateData = { currentStep: ConversationStep.GREETING_SENT };
    if (resolution.resolved && resolution.vacancy) updateData.vacancyId = resolution.vacancy.id;
    await prisma.candidate.update({ where: { id: candidate.id }, data: updateData });

    if (resolution.resolved && resolution.vacancy) {
      const candidateState = { ...candidate, currentStep: ConversationStep.GREETING_SENT, vacancyId: resolution.vacancy.id };
      return replyWithVacancyContext(candidateState, resolution.vacancy);
    }

    return reply(prisma, candidate.id, from, SALUDO_INICIAL, cleanText, { body: SALUDO_INICIAL, source: 'bot_vacancy_prompt' });
  }

  if (candidate.currentStep === ConversationStep.GREETING_SENT && !candidate.vacancyId) {
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

    const resolution = await resolveVacancyForCandidate();
    if (resolution.resolved && resolution.vacancy) {
      await prisma.candidate.update({
        where: { id: candidate.id },
        data: { vacancyId: resolution.vacancy.id }
      });
      const candidateState = { ...candidate, vacancyId: resolution.vacancy.id };
      return replyWithVacancyContext(candidateState, resolution.vacancy);
    }

    return reply(prisma, candidate.id, from, SALUDO_INICIAL, cleanText, { body: SALUDO_INICIAL, source: 'bot_vacancy_prompt' });
  }

  const currentVacancy = candidate.vacancyId ? await loadVacancyContext(prisma, candidate.vacancyId) : null;
  const askedVacancyQuestion = Boolean(currentVacancy && isQuestionLike(cleanText));

  if (resolvedIntent === 'faq' || isFAQ(cleanText)) {
    if (currentVacancy) return replyWithVacancyContext(candidate, currentVacancy);
    return reply(prisma, candidate.id, from, FAQ_RESPONSE, cleanText, { body: FAQ_RESPONSE, source: 'bot_vacancy_prompt' });
  }

  if (askedVacancyQuestion && !hasDataIntent) {
    return replyWithVacancyContext(candidate, currentVacancy);
  }

  if ((candidate.currentStep === ConversationStep.SCHEDULING || candidate.currentStep === ConversationStep.SCHEDULED) && currentVacancy && isSchedulingEligibleCandidate(candidate, currentVacancy)) {
    if (USE_CONVERSATION_ENGINE) {
      return replyWithEngine(prisma, candidate, from, cleanText, currentVacancy);
    }

    const nextSlot = await resolveInterviewSlotContext(prisma, candidate, currentVacancy, cleanText);

    if (isSchedulingRescheduleIntent(cleanText)) {
      if (!nextSlot?.slot) {
        await pauseInterviewFlow(prisma, candidate.id, 'No hay un siguiente slot valido para reagendar');
        const body = 'En este momento no tengo un siguiente horario válido para ofrecerte. El equipo te contactará para ayudarte con la reprogramación.';
        return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
      }

      await prisma.candidate.update({
        where: { id: candidate.id },
        data: {
          currentStep: ConversationStep.SCHEDULING,
          reminderScheduledFor: null,
          reminderState: 'SKIPPED'
        }
      });
      const body = await buildInterviewOfferReply(candidate, currentVacancy, nextSlot, true);
      return reply(prisma, candidate.id, from, body, cleanText, buildInterviewReplyPayload(body, 'interview_reschedule', nextSlot));
    }

    if (isSchedulingConfirmationIntent(cleanText)) {
      if (!nextSlot?.slot) {
        await pauseInterviewFlow(prisma, candidate.id, 'No se encontro un slot vigente para confirmar');
        const body = 'No pude confirmar el horario en este momento. El equipo de selección te contactará para terminar el agendamiento.';
        return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
      }

      await cancelCandidateBookings(
        prisma,
        candidate.id,
        candidate.currentStep === ConversationStep.SCHEDULED ? 'RESCHEDULED' : 'CANCELLED'
      );
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
      return reply(prisma, candidate.id, from, body, cleanText, buildInterviewReplyPayload(body, 'interview_booking_confirmation', nextSlot));
    }

    if (isQuestionLike(cleanText)) {
      return replyWithVacancyContext(candidate, currentVacancy);
    }

    if (nextSlot?.slot) {
      const body = await buildInterviewOfferReply(candidate, currentVacancy, nextSlot, Boolean(nextSlot.isAlternative));
      const source = nextSlot.isAlternative ? 'interview_reschedule' : 'interview_offer';
      return reply(prisma, candidate.id, from, body, cleanText, buildInterviewReplyPayload(body, source, nextSlot));
    }

    const body = 'Quedó registrado tu interés en entrevista. En este momento no tengo un horario válido para ofrecerte, así que el equipo de selección te contactará por este medio.';
    return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
  }

  if (candidate.currentStep === ConversationStep.ASK_CV && !hasDataIntent) return reply(prisma, candidate.id, from, RECORDATORIO_HV, cleanText, { body: RECORDATORIO_HV, source: 'bot_cv_request' });

  if (candidate.currentStep === ConversationStep.DONE) {
    if (resolvedIntent === 'cv_intent') return reply(prisma, candidate.id, from, MENSAJE_DONE_CV_REPEAT, cleanText, { body: MENSAJE_DONE_CV_REPEAT, source: 'bot_cv_request' });
    if (resolvedIntent === 'post_completion_ack' || isPostCompletionAck(cleanText) || ['thanks', 'farewell'].includes(resolvedIntent)) {
      const ackSent = await wasDoneAckSent(prisma, candidate.id);
      if (ackSent) return;
      return reply(prisma, candidate.id, from, MENSAJE_DONE_ACK, cleanText, { body: MENSAJE_DONE_ACK, source: 'bot_done_ack' });
    }
    return;
  }

  const applyDecisionsAndUpdate = async () => {
    const current = await prisma.candidate.findUnique({ where: { id: candidate.id } });
    const explicitCorrection = /\b(corrijo|correccion|quise decir|actualizo|de hecho|mejor|perd[oó]n)\b/i.test(cleanText);
    const allowOverwriteFields = [];
    if (explicitCorrection) {
      allowOverwriteFields.push(...Object.keys(normalizedData));
    } else if (
      current?.transportMode === 'Sin medio de transporte'
      && normalizedData.transportMode
      && normalizedData.transportMode !== 'Sin medio de transporte'
      && /\b(tengo|cuento con|si tengo|sí tengo)\s+(moto|motocicleta|bicicleta|bici)\b/i.test(cleanText)
    ) {
      allowOverwriteFields.push('transportMode');
    }
    const decisions = splitFieldDecisions(normalizedData, current, { sourceByField, allowOverwriteFields });
    debugTrace.persisted_fields.push(...decisions.persistedFields);
    debugTrace.consolidated_fields?.push(...(decisions.consolidatedFields || []));
    debugTrace.rejected_fields.push(...decisions.rejectedFields);
    debugTrace.ignored_low_confidence_fields.push(...decisions.ignoredLowConfidenceFields);
    debugTrace.suspicious_full_name_rejected = decisions.suspiciousFullNameRejected;
    debugTrace.rejected_name_reason = decisions.rejectedNameReason;
    if (decisions.suspiciousFullNameRejected) console.warn('[AI_REJECTED_NAME]', JSON.stringify({ phone: candidate.phone, fullName: normalizedData.fullName || null, reason: decisions.rejectedNameReason || 'suspicious_name' }));
    if (Object.keys(decisions.persistedData).length) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: decisions.persistedData });
    }
    return prisma.candidate.findUnique({ where: { id: candidate.id } });
  };

  const routeAfterConfirmation = async (updatedCandidate) => {
    const missing = getMissingFields(updatedCandidate);

    if (USE_CONVERSATION_ENGINE) {
      return replyWithEngine(prisma, updatedCandidate, from, cleanText);
    }

    if (missing.length) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.COLLECTING_DATA } });
      const replyText = buildMissingFieldsReply(updatedCandidate, normalizedData);
      return reply(prisma, candidate.id, from, replyText, cleanText, { body: replyText, source: 'bot_flow' });
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

    const updated = await applyDecisionsAndUpdate();

    if (USE_CONVERSATION_ENGINE) {
      return replyWithEngine(prisma, updated, from, cleanText);
    }

    if (resolvedIntent === 'confirmation_no_or_correction' && Object.keys(normalizedData).length === 0) {
      return reply(prisma, candidate.id, from, 'Gracias por avisar. Indícame por favor el dato que deseas corregir y lo actualizo.');
    }
    const latest = await prisma.candidate.findUnique({ where: { id: candidate.id } });
    return reply(prisma, candidate.id, from, buildConfirmationSummary(latest));
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

    if (isAffirmativeInterest(cleanText) || hasDataIntent) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.COLLECTING_DATA } });
      if (hasDataIntent) {
        const rejection = shouldRejectByRequirements(cleanText, normalizedData);
        if (rejection.reject) return rejectCandidate(prisma, candidate.id, from, rejection);
        const updated = await applyDecisionsAndUpdate();

        if (USE_CONVERSATION_ENGINE) {
          return replyWithEngine(prisma, updated, from, cleanText);
        }

        if (shouldAskForConfirmation(updated, normalizedData)) {
          await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.CONFIRMING_DATA } });
          const confirmationText = buildConfirmationSummary(updated);
          const body = askedVacancyQuestion
            ? buildQuestionFollowUpReply(currentVacancy, cleanText, confirmationText)
            : confirmationText;
          return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
        }
        const followUp = buildMissingFieldsReply(updated, normalizedData);
        const body = askedVacancyQuestion
          ? buildQuestionFollowUpReply(currentVacancy, cleanText, followUp)
          : followUp;
        return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
      }

      if (USE_CONVERSATION_ENGINE) {
        const updatedCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id } });
        return replyWithEngine(prisma, updatedCandidate, from, cleanText);
      }

      const body = askedVacancyQuestion
        ? buildQuestionFollowUpReply(currentVacancy, cleanText, SOLICITAR_DATOS)
        : SOLICITAR_DATOS;
      return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
    }

    const rejection = shouldRejectByRequirements(cleanText, normalizedData);
    if (rejection.reject) return rejectCandidate(prisma, candidate.id, from, rejection);

    if (Object.keys(normalizedData).length >= 1) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.COLLECTING_DATA } });
      const updated = await applyDecisionsAndUpdate();

      if (USE_CONVERSATION_ENGINE) {
        return replyWithEngine(prisma, updated, from, cleanText);
      }

      if (shouldAskForConfirmation(updated, normalizedData)) {
        await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.CONFIRMING_DATA } });
        const confirmationText = buildConfirmationSummary(updated);
        const body = askedVacancyQuestion
          ? buildQuestionFollowUpReply(currentVacancy, cleanText, confirmationText)
          : confirmationText;
        return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
      }
      const followUp = buildMissingFieldsReply(updated, normalizedData);
      const body = askedVacancyQuestion
        ? buildQuestionFollowUpReply(currentVacancy, cleanText, followUp)
        : followUp;
      return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
    }

    if (USE_CONVERSATION_ENGINE) {
      const updatedCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id } });
      return replyWithEngine(prisma, updatedCandidate, from, cleanText);
    }

    return reply(prisma, candidate.id, from, GUIA_CONTINUAR, cleanText, { body: GUIA_CONTINUAR, source: 'bot_flow' });
  }

  if (candidate.currentStep === ConversationStep.COLLECTING_DATA || candidate.currentStep === ConversationStep.ASK_CV) {
    const rejection = shouldRejectByRequirements(cleanText, normalizedData);
    if (rejection.reject) return rejectCandidate(prisma, candidate.id, from, rejection);
    const updated = await applyDecisionsAndUpdate();

    if (USE_CONVERSATION_ENGINE) {
      return replyWithEngine(prisma, updated, from, cleanText);
    }

    if (shouldAskForConfirmation(updated, normalizedData)) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.CONFIRMING_DATA } });
      const confirmationText = buildConfirmationSummary(updated);
      const body = askedVacancyQuestion
        ? buildQuestionFollowUpReply(currentVacancy, cleanText, confirmationText)
        : confirmationText;
      return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
    }

    const followUp = buildMissingFieldsReply(updated, normalizedData);
    const body = askedVacancyQuestion
      ? buildQuestionFollowUpReply(currentVacancy, cleanText, followUp)
      : followUp;
    return reply(prisma, candidate.id, from, body, cleanText, { body, source: 'bot_flow' });
  }
}

async function scheduleMultilineWindow(prisma, candidateId) {
  const windowMs = getMultilineWindowMs();
  const windowUntil = new Date(Date.now() + windowMs);
  const updated = await prisma.candidate.update({
    where: { id: candidateId },
    data: {
      multilineWindowUntil: windowUntil,
      multilineBatchVersion: { increment: 1 }
    },
    select: { multilineBatchVersion: true }
  });

  return { windowMs, batchVersion: updated.multilineBatchVersion };
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

async function tryAcquireMultilineProcessing(prisma, candidateId, batchVersion) {
  const acquired = await prisma.candidate.updateMany({
    where: {
      id: candidateId,
      multilineBatchVersion: batchVersion,
      multilineWindowUntil: { lte: new Date() }
    },
    data: {
      multilineWindowUntil: null,
      multilineBatchVersion: { increment: 1 }
    }
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

        if (!checkRateLimit(from)) continue;

        const candidate = await prisma.candidate.upsert({ where: { phone: from }, update: {}, create: { phone: from } });

        if (message.type === 'text') {
          const body = message.text?.body || '';
          const inbound = await saveInboundMessage(prisma, candidate.id, message, body, MessageType.TEXT, from);
          if (!inbound.isNew) continue;

          await cancelReminderOnInbound(prisma, candidate.id);

          const freshCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id } });
          if (shouldBlockAutomation(freshCandidate)) continue;

          const scheduling = await scheduleMultilineWindow(prisma, candidate.id);
          await sleep(scheduling.windowMs);

          const stillOwner = await tryAcquireMultilineProcessing(prisma, candidate.id, scheduling.batchVersion);
          if (!stillOwner) continue;

          const pendingBatch = await fetchPendingTextBatch(prisma, candidate.id);
          if (!pendingBatch.length) continue;

          const consolidatedText = consolidateTextMessages(pendingBatch);
          const anchorMessage = pendingBatch[pendingBatch.length - 1];
          const candidateForBatch = await prisma.candidate.findUnique({ where: { id: candidate.id } });
          const debugTrace = createDebugTrace({ phone: from, currentStepBefore: candidateForBatch.currentStep });

          try {
            await processText(prisma, candidateForBatch, from, consolidatedText, debugTrace, {
              batchedMessageCount: pendingBatch.length,
              usedMultilineContext: pendingBatch.length > 1,
              consolidatedInputSummary: summarizeConsolidatedInput(consolidatedText)
            });
            await markPotentialDuplicateByDocument(prisma, candidate.id);
            await prisma.message.updateMany({
              where: { id: { in: pendingBatch.map((item) => item.id) } },
              data: { respondedAt: new Date() }
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

        const freshCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id } });
        const automationBlocked = shouldBlockAutomation(freshCandidate);
        const debugTrace = createDebugTrace({ phone: from, currentStepBefore: freshCandidate.currentStep });
        debugTrace.cv_detected = message.type === 'document';

        try {
          if (message.type === 'document') {
            const mimeType = message.document?.mime_type || '';
            const filename = message.document?.filename || 'hoja_de_vida';
            if (!isCvMimeTypeAllowed(mimeType, filename)) {
              debugTrace.cv_invalid_mime = true;
              console.warn('[CV_ERROR]', JSON.stringify({ phone: from, mimeType, filename, reason: 'invalid_mime' }));
              if (!automationBlocked) {
                await reply(prisma, candidate.id, from, 'Recibí tu archivo, pero por favor envíalo como PDF o Word (.doc/.docx).', '', { source: 'bot_flow' });
              }
            } else {
              try {
                const metadata = await fetchMediaMetadata(message.document.id);
                const cvBuffer = await downloadMedia(metadata.url);
                await prisma.candidate.update({
                  where: { id: candidate.id },
                  data: {
                    cvData: cvBuffer,
                    cvMimeType: mimeType || null,
                    cvOriginalName: filename
                  }
                });
                debugTrace.cv_saved = true;
                console.log('[CV_TRACE]', JSON.stringify({ phone: from, filename, mimeType }));
                const afterCvSave = await prisma.candidate.findUnique({ where: { id: candidate.id } });
                if (!automationBlocked && afterCvSave.currentStep !== ConversationStep.DONE) {
                  if (afterCvSave.currentStep === ConversationStep.SCHEDULING || afterCvSave.currentStep === ConversationStep.SCHEDULED) {
                    const activeBooking = await loadActiveInterviewBooking(prisma, candidate.id);
                    const body = activeBooking
                      ? `Hoja de vida actualizada. Tu entrevista sigue registrada para ${formatInterviewDate(new Date(activeBooking.scheduledAt))}.`
                      : 'Hoja de vida actualizada correctamente. Tu proceso de entrevista sigue en curso.';
                    await reply(prisma, candidate.id, from, body, '', { body, source: 'bot_flow' });
                    continue;
                  }
                  const missing = getMissingFields(afterCvSave);
                  if (shouldFinalizeAfterCv({ missingFields: missing })) {
                    await finalizeCandidateAfterCv(prisma, afterCvSave, from);
                  } else {
                    if (afterCvSave.currentStep !== ConversationStep.COLLECTING_DATA && afterCvSave.currentStep !== ConversationStep.CONFIRMING_DATA) {
                      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.COLLECTING_DATA } });
                    }
                    await reply(prisma, candidate.id, from, `Hoja de vida recibida. Aún necesito estos datos para completar tu registro: ${missing.join(', ')}`, '', { source: 'bot_flow' });
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
            await reply(prisma, candidate.id, from, 'Por ahora solo puedo procesar mensajes de texto para continuar con tu registro.', '', { source: 'bot_flow' });
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
