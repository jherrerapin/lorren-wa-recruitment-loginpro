/**
 * webhook.js — Sprint 3 v2
 *
 * Refactor completo del router de WhatsApp.
 * Cambios principales frente a v1:
 *
 * - processText() ahora usa runAITurn() con historial completo de conversación
 *   y estado del candidato. El reply viene del modelo, no de constantes hardcoded.
 * - Nuevo flujo action-driven: el "action" retornado por la IA determina el
 *   siguiente paso del state machine, en lugar de condicionales if/else anidados.
 * - Soporte a imágenes: si el candidato manda una foto, se descarga, se pasa a
 *   runAITurn() como imageBase64 y el modelo puede leer el anuncio de la vacante.
 * - buildConversationHistory(): construye el historial desde la DB (max 20 mensajes).
 * - buildCandidateStateSnapshot(): normaliza el candidato para el prompt.
 * - applyAIFields(): persiste los campos detectados por la IA con la misma lógica
 *   de splitFieldDecisions que usaba v1 (sin pérdida de protecciones).
 * - handleActionFromAI(): state machine central, reemplaza la cascada de ifs.
 * - Compatibilidad total con todos los servicios auxiliares (multiline, reminder,
 *   botAutomationPolicy, cvFlow, debugTrace, candidateData, etc.)
 */

import express from 'express';
import pkg from '@prisma/client';
const { CandidateStatus, ConversationStep, MessageDirection, MessageType } = pkg;
import { extractMessages, sendTextMessage } from '../services/whatsapp.js';
import { fetchMediaMetadata, downloadMedia } from '../services/media.js';
import { runAITurn, tryOpenAIParse } from '../services/aiParser.js';
import { createDebugTrace, inferIntent, sanitizeForRawPayload, splitFieldDecisions, summarizeError } from '../services/debugTrace.js';
import { isCvMimeTypeAllowed, resolveStepAfterDataCompletion, shouldFinalizeAfterCv } from '../services/cvFlow.js';
import { isHighConfidenceLocalField, normalizeCandidateFields, parseNaturalData } from '../services/candidateData.js';
import { consolidateTextMessages, getMultilineWindowMs, summarizeConsolidatedInput } from '../services/multiline.js';
import { cancelReminderOnInbound, scheduleReminderForCandidate } from '../services/reminder.js';
import { shouldBlockAutomation } from '../services/botAutomationPolicy.js';
import { DEFAULT_VACANCY_SEED, getActiveVacancyCatalog } from '../services/vacancyCatalog.js';

// ---------------------------------------------------------------------------
// Mensajes de fallback (solo para cuando la IA está offline / disabled)
// ---------------------------------------------------------------------------
const FB_FAQ = 'En este momento estamos recolectando hojas de vida. La entrevista está prevista para el 8 de abril. Por favor mantente pendiente del llamado del equipo de reclutamiento.';
const FB_SOLICITAR_DATOS = 'Perfecto. Envíame por favor estos datos para continuar: nombre completo, tipo de documento, número de documento, edad, barrio, si tienes experiencia en el cargo y cuánto tiempo, si tienes restricciones médicas y qué medio de transporte tienes. Puedes enviarlos en un solo mensaje, como te sea más fácil.';
const FB_DESCARTE = 'Gracias por tu interés. En este caso no es posible continuar con tu postulación porque no cumples con uno de los requisitos definidos para esta vacante.';
const FB_CIERRE_NO_INTERES = 'Entendido. Si más adelante deseas continuar con la postulación, puedes volver a escribirme y con gusto retomamos el proceso.';
const FB_SOLICITAR_HV = '¡Gracias! Ya tengo tus datos. Por favor adjunta tu hoja de vida (HV) en PDF o Word (.doc/.docx) para finalizar tu postulación.';
const FB_MENSAJE_FINAL = 'Tu información y Hoja de vida (HV) fueron recibidas correctamente. Las entrevistas están previstas para el 8 de abril. Debes estar pendiente del mensaje o llamada del reclutador; por ese medio te confirmarán la hora y el lugar.';
const FB_DONE_ACK = '¡Con gusto! Ya quedó tu registro completo. Si surge una novedad, te contactamos por este medio.';
const FB_DONE_CV_REPEAT = 'Ya tenemos tu registro completo. Si deseas actualizar tu hoja de vida, puedes enviarla y la adjuntamos a tu postulación.';

const REQUIRED_FIELDS = [
  'fullName', 'documentType', 'documentNumber', 'age',
  'neighborhood', 'experienceInfo', 'experienceTime',
  'medicalRestrictions', 'transportMode'
];

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function getNaturalDelayMs(inputText = '', outputText = '') {
  if (process.env.NODE_ENV === 'test') return 0;
  const l = Math.max(String(inputText || '').trim().length, String(outputText || '').trim().length, 1);
  return Math.max(1500, Math.min(2500, 1500 + Math.min(1000, Math.round(l * 8))));
}

function getMissingFields(candidate) {
  const m = [];
  if (!candidate.fullName)            m.push('nombre completo');
  if (!candidate.documentType)        m.push('tipo de documento');
  if (!candidate.documentNumber)      m.push('número de documento');
  if (!candidate.age)                 m.push('edad');
  if (!candidate.neighborhood)        m.push('barrio');
  if (!candidate.experienceInfo)      m.push('experiencia en el cargo');
  if (!candidate.experienceTime)      m.push('tiempo de experiencia');
  if (!candidate.medicalRestrictions) m.push('restricciones médicas');
  if (!candidate.transportMode)       m.push('medio de transporte');
  return m;
}

function allRequiredFieldsFilled(candidate) {
  return REQUIRED_FIELDS.every((f) => candidate[f] !== null && candidate[f] !== undefined && candidate[f] !== '');
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------
export async function saveInboundMessage(prisma, candidateId, message, body, type, phone) {
  const waMessageId = message?.id || null;
  const insertResult = await prisma.message.createMany({
    data: [{ candidateId, waMessageId, direction: MessageDirection.INBOUND, messageType: type, body, rawPayload: sanitizeForRawPayload(message) }],
    skipDuplicates: true
  });

  if (insertResult.count === 0) {
    console.log('[INBOUND_DUPLICATE_IGNORED]', JSON.stringify({ phone: phone || null, waMessageId, duplicate_ignored: true }));
    return { isNew: false, id: null };
  }

  if (prisma.candidate?.update) {
    await prisma.candidate.update({ where: { id: candidateId }, data: { lastInboundAt: new Date() } });
  }

  if (!waMessageId) return { isNew: true, id: null };
  const created = await prisma.message.findUnique({ where: { waMessageId }, select: { id: true } });
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
  if (!body || !body.trim()) return;
  await sleep(getNaturalDelayMs(inboundText, body));
  await sendTextMessage(to, body);
  await saveOutboundMessage(prisma, candidateId, body, rawPayload);
  await scheduleReminderForCandidate(prisma, candidateId);
}

async function getActiveVacancies(prisma) {
  if (typeof prisma.vacancy?.findMany === 'function') {
    const rows = await prisma.vacancy.findMany({ where: { isActive: true }, orderBy: { displayOrder: 'asc' } });
    const catalog = getActiveVacancyCatalog(rows);
    if (catalog.length) return catalog;
  }
  return getActiveVacancyCatalog(DEFAULT_VACANCY_SEED);
}

async function getAvailableInterviewSlots(prisma) {
  if (typeof prisma.interviewSlot?.findMany !== 'function') return [];
  return prisma.interviewSlot.findMany({
    where: { isActive: true, scheduledAt: { gt: new Date() } },
    orderBy: { scheduledAt: 'asc' },
    take: 5,
    select: { id: true, label: true, scheduledAt: true }
  }).catch(() => []);
}

// ---------------------------------------------------------------------------
// Historial de conversación para runAITurn
// ---------------------------------------------------------------------------

/**
 * Construye el historial [{role, content}] desde los últimos mensajes de la DB.
 * Máximo 20 mensajes (10 turnos). Inbound = 'user', outbound = 'assistant'.
 */
async function buildConversationHistory(prisma, candidateId) {
  const messages = await prisma.message.findMany({
    where: { candidateId, messageType: MessageType.TEXT },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { direction: true, body: true }
  });

  return messages
    .reverse()
    .filter((m) => m.body && m.body.trim())
    .map((m) => ({
      role: m.direction === MessageDirection.INBOUND ? 'user' : 'assistant',
      content: m.body
    }));
}

/**
 * Snapshot del candidato para el prompt de la IA.
 * Solo envía campos relevantes para no desperdiciar tokens.
 */
function buildCandidateStateSnapshot(candidate) {
  return {
    fullName:            candidate.fullName || null,
    documentType:        candidate.documentType || null,
    documentNumber:      candidate.documentNumber || null,
    age:                 candidate.age || null,
    neighborhood:        candidate.neighborhood || null,
    locality:            candidate.locality || null,
    experienceInfo:      candidate.experienceInfo || null,
    experienceTime:      candidate.experienceTime || null,
    medicalRestrictions: candidate.medicalRestrictions || null,
    transportMode:       candidate.transportMode || null,
    hasCv:               Boolean(candidate.cvData),
    currentStep:         candidate.currentStep || null,
    vacancyKey:          candidate.vacancy?.key || null
  };
}

// ---------------------------------------------------------------------------
// Persistencia de campos detectados por la IA
// ---------------------------------------------------------------------------

/**
 * Aplica los fields detectados por runAITurn() con la misma lógica de
 * splitFieldDecisions que protege sobreescrituras incorrectas.
 */
async function applyAIFields(prisma, candidate, aiFields, debugTrace, inputText = '') {
  if (!aiFields || !Object.keys(aiFields).length) return candidate;

  // Merge con parser local para campos de alta confianza
  const localParsed = parseNaturalData(inputText);
  const sourceByField = {};
  const mergedData = {};

  for (const [field, value] of Object.entries(localParsed)) {
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
  const current = await prisma.candidate.findUnique({ where: { id: candidate.id } });

  const explicitCorrection = /\b(corrijo|correccion|quise decir|actualizo|de hecho|mejor|perd[oó]n)\b/i.test(inputText);
  const allowOverwriteFields = [];
  if (explicitCorrection) allowOverwriteFields.push(...Object.keys(normalizedData));

  const decisions = splitFieldDecisions(normalizedData, current, { sourceByField, allowOverwriteFields });
  if (debugTrace) {
    debugTrace.persisted_fields.push(...decisions.persistedFields);
    debugTrace.rejected_fields.push(...decisions.rejectedFields);
    debugTrace.ignored_low_confidence_fields.push(...decisions.ignoredLowConfidenceFields);
    debugTrace.suspicious_full_name_rejected = decisions.suspiciousFullNameRejected;
    debugTrace.rejected_name_reason = decisions.rejectedNameReason;
  }

  if (decisions.suspiciousFullNameRejected) {
    console.warn('[AI_REJECTED_NAME]', JSON.stringify({ phone: candidate.phone, fullName: normalizedData.fullName || null, reason: decisions.rejectedNameReason || 'suspicious_name' }));
  }

  if (Object.keys(decisions.persistedData).length) {
    await prisma.candidate.update({ where: { id: candidate.id }, data: decisions.persistedData });
  }

  return prisma.candidate.findUnique({ where: { id: candidate.id }, include: { vacancy: true } });
}

// ---------------------------------------------------------------------------
// State machine central — action-driven
// ---------------------------------------------------------------------------

/**
 * Recibe el resultado de runAITurn() y ejecuta la acción correspondiente.
 * Retorna true si se envió una respuesta, false si se debe usar fallback.
 *
 * Acciones soportadas:
 *   ask_vacancy         → pide al candidato que especifique la vacante
 *   save_vacancy        → registra vacancyId y avanza a GREETING_SENT/COLLECTING_DATA
 *   save_fields         → persiste datos y calcula siguiente paso
 *   ask_locality        → pide localidad por requisito de cercanía
 *   confirm_proximity_ko→ informa sobre posible inconveniente de distancia
 *   request_confirm_data→ envía resumen de datos para confirmación
 *   save_confirmed_data → confirma y avanza
 *   request_cv          → pide HV
 *   schedule_interview  → agenda entrevista
 *   confirm_interview   → confirma entrevista agendada
 *   close               → cierra el proceso (DONE / REGISTRADO)
 *   send_info           → FAQ / información general
 *   noop                → no hace nada (IA offline o sin acción)
 */
async function handleActionFromAI(prisma, candidate, from, aiResult, inputText, debugTrace, activeVacancies) {
  const { action, reply: aiReply, fields, vacancyKey, proximityVerdict, interviewSlotId, intent } = aiResult;

  // Sin respuesta utilizable de la IA → fallback al flujo legacy
  if (!aiReply && action === 'noop') return false;

  // --- ask_vacancy ---
  if (action === 'ask_vacancy') {
    await reply(prisma, candidate.id, from, aiReply, inputText, { body: aiReply, source: 'bot_vacancy_resolution' });
    return true;
  }

  // --- save_vacancy ---
  if (action === 'save_vacancy' && vacancyKey) {
    const vacancy = activeVacancies.find((v) => v.key === vacancyKey);
    if (vacancy?.id && candidate.vacancyId !== vacancy.id) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { vacancyId: vacancy.id } });
    }
    if (candidate.currentStep === ConversationStep.MENU) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.GREETING_SENT } });
    }
    await reply(prisma, candidate.id, from, aiReply, inputText, { body: aiReply, source: 'bot_vacancy_greeting' });
    return true;
  }

  // --- save_fields (+ evaluación siguiente paso) ---
  if (action === 'save_fields') {
    const updated = await applyAIFields(prisma, candidate, fields, debugTrace, inputText);
    const missing = getMissingFields(updated);

    if (candidate.currentStep === ConversationStep.MENU || candidate.currentStep === ConversationStep.GREETING_SENT) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.COLLECTING_DATA } });
    }

    // Si todos los campos están completos, avanzar
    if (!missing.length) {
      const needsCv = resolveStepAfterDataCompletion({ hasCv: Boolean(updated.cvData) }) !== ConversationStep.DONE;
      if (needsCv) {
        await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.ASK_CV } });
        const hvMsg = aiReply || FB_SOLICITAR_HV;
        await reply(prisma, candidate.id, from, hvMsg, inputText, { body: hvMsg, source: 'bot_cv_request' });
      } else {
        await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.DONE, status: CandidateStatus.REGISTRADO } });
        const closeMsg = aiReply || FB_MENSAJE_FINAL;
        await reply(prisma, candidate.id, from, closeMsg, inputText, { body: closeMsg, source: 'bot_flow' });
      }
      return true;
    }

    // Datos parciales: enviar reply de la IA (que ya conoce los faltantes)
    const msg = aiReply || `Gracias. Para continuar solo me falta: ${missing.join(', ')}`;
    await reply(prisma, candidate.id, from, msg, inputText, { body: msg, source: 'bot_flow' });
    return true;
  }

  // --- ask_locality ---
  if (action === 'ask_locality') {
    await reply(prisma, candidate.id, from, aiReply, inputText, { body: aiReply, source: 'bot_locality_check' });
    return true;
  }

  // --- confirm_proximity_ko ---
  if (action === 'confirm_proximity_ko') {
    // No rechazar, solo informar. El reclutador decide.
    await reply(prisma, candidate.id, from, aiReply, inputText, { body: aiReply, source: 'bot_proximity_warn' });
    if (debugTrace) debugTrace.proximity_verdict = 'no_viable';
    return true;
  }

  // --- request_confirm_data ---
  if (action === 'request_confirm_data') {
    await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.CONFIRMING_DATA } });
    await reply(prisma, candidate.id, from, aiReply, inputText, { body: aiReply, source: 'bot_confirm_data' });
    return true;
  }

  // --- save_confirmed_data ---
  if (action === 'save_confirmed_data') {
    if (fields && Object.keys(fields).length) {
      await applyAIFields(prisma, candidate, fields, debugTrace, inputText);
    }
    const refreshed = await prisma.candidate.findUnique({ where: { id: candidate.id }, include: { vacancy: true } });
    const missing = getMissingFields(refreshed);
    if (missing.length) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.COLLECTING_DATA } });
      const msg = aiReply || `Gracias. Para continuar solo me falta: ${missing.join(', ')}`;
      await reply(prisma, candidate.id, from, msg, inputText, { body: msg, source: 'bot_flow' });
      return true;
    }
    const needsCv = resolveStepAfterDataCompletion({ hasCv: Boolean(refreshed.cvData) }) !== ConversationStep.DONE;
    if (needsCv) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.ASK_CV } });
      const hvMsg = aiReply || FB_SOLICITAR_HV;
      await reply(prisma, candidate.id, from, hvMsg, inputText, { body: hvMsg, source: 'bot_cv_request' });
    } else {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.DONE, status: CandidateStatus.REGISTRADO } });
      const closeMsg = aiReply || FB_MENSAJE_FINAL;
      await reply(prisma, candidate.id, from, closeMsg, inputText, { body: closeMsg, source: 'bot_flow' });
    }
    return true;
  }

  // --- request_cv ---
  if (action === 'request_cv') {
    await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.ASK_CV } });
    const msg = aiReply || FB_SOLICITAR_HV;
    await reply(prisma, candidate.id, from, msg, inputText, { body: msg, source: 'bot_cv_request' });
    return true;
  }

  // --- schedule_interview ---
  if (action === 'schedule_interview' && interviewSlotId) {
    if (typeof prisma.interviewSlot?.update === 'function') {
      await prisma.interviewSlot.update({
        where: { id: interviewSlotId },
        data: { candidateId: candidate.id, bookedAt: new Date() }
      }).catch(() => {});
    }
    await reply(prisma, candidate.id, from, aiReply, inputText, { body: aiReply, source: 'bot_interview_scheduled' });
    return true;
  }

  // --- confirm_interview ---
  if (action === 'confirm_interview') {
    await reply(prisma, candidate.id, from, aiReply, inputText, { body: aiReply, source: 'bot_interview_confirmed' });
    return true;
  }

  // --- close ---
  if (action === 'close') {
    await prisma.candidate.update({
      where: { id: candidate.id },
      data: { currentStep: ConversationStep.DONE, status: CandidateStatus.REGISTRADO }
    });
    const msg = aiReply || FB_MENSAJE_FINAL;
    await reply(prisma, candidate.id, from, msg, inputText, { body: msg, source: 'bot_flow' });
    return true;
  }

  // --- send_info (FAQ) ---
  if (action === 'send_info') {
    const msg = aiReply || FB_FAQ;
    await reply(prisma, candidate.id, from, msg, inputText, { body: msg, source: 'bot_faq' });
    return true;
  }

  // Si hay reply aunque la acción no sea reconocida, enviarlo igual
  if (aiReply) {
    await reply(prisma, candidate.id, from, aiReply, inputText, { body: aiReply, source: 'bot_flow' });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Flujo de texto principal
// ---------------------------------------------------------------------------

async function processText(prisma, candidate, from, text, debugTrace, options = {}) {
  const { activeVacancies = [], availableSlots = [], imageBase64 = null, imageMimeType = 'image/jpeg' } = options;
  debugTrace.batched_message_count = options.batchedMessageCount || 1;
  debugTrace.used_multiline_context = Boolean(options.usedMultilineContext);
  debugTrace.consolidated_input_summary = options.consolidatedInputSummary || null;

  // Candidatos rechazados: siempre el mismo mensaje
  if (candidate.status === CandidateStatus.RECHAZADO) {
    return reply(prisma, candidate.id, from, FB_DESCARTE);
  }

  // Estado DONE: respuestas cortadas
  if (candidate.currentStep === ConversationStep.DONE) {
    // Si manda un CV nuevo en estado DONE, lo maneja el handler de documentos
    // Aquí solo respondemos textos post-done
    const doneAiResult = await runAITurn({
      conversationHistory: await buildConversationHistory(prisma, candidate.id),
      candidateState: buildCandidateStateSnapshot(candidate),
      activeVacancies,
      currentVacancyKey: candidate.vacancy?.key || null,
      availableSlots
    });
    debugTrace.openai_used = doneAiResult.used;
    debugTrace.openai_status = doneAiResult.status === 'error' ? 'fallback' : doneAiResult.status;
    debugTrace.openai_intent = doneAiResult.intent;
    if (doneAiResult.reply) {
      return reply(prisma, candidate.id, from, doneAiResult.reply, text, { body: doneAiResult.reply, source: 'bot_done_ack' });
    }
    // Fallback silencioso post-done
    return;
  }

  // Construir historial y estado para runAITurn
  const conversationHistory = await buildConversationHistory(prisma, candidate.id);
  const candidateState = buildCandidateStateSnapshot(candidate);

  // Llamada principal a la IA
  const aiResult = await runAITurn({
    conversationHistory,
    candidateState,
    activeVacancies,
    currentVacancyKey: candidate.vacancy?.key || null,
    availableSlots,
    imageBase64,
    imageMimeType
  });

  // Debug trace
  debugTrace.openai_used = aiResult.used;
  debugTrace.openai_status = aiResult.status === 'error' ? 'fallback' : aiResult.status;
  debugTrace.openai_intent = aiResult.intent;
  debugTrace.openai_model = aiResult.model || debugTrace.openai_model;
  debugTrace.openai_detected_fields = Object.keys(aiResult.fields || {});
  debugTrace.ai_action = aiResult.action;
  debugTrace.proximity_verdict = aiResult.proximityVerdict;

  if (aiResult.status === 'error') {
    debugTrace.error_summary = summarizeError(aiResult.error);
    console.warn('[AI_FALLBACK]', JSON.stringify({ phone: candidate.phone, error: debugTrace.error_summary }));
  } else if (aiResult.status === 'disabled') {
    console.log('[AI_DISABLED]', JSON.stringify({ phone: candidate.phone, reason: 'openai_key_missing' }));
  }

  // Ejecutar acción de la IA
  const handled = await handleActionFromAI(prisma, candidate, from, aiResult, text, debugTrace, activeVacancies);

  // Fallback si la IA no retornó nada útil
  if (!handled) {
    console.warn('[AI_NO_ACTION]', JSON.stringify({ phone: candidate.phone, step: candidate.currentStep, action: aiResult.action }));
    const missingFallback = getMissingFields(candidate);
    if (missingFallback.length) {
      return reply(prisma, candidate.id, from, FB_SOLICITAR_DATOS, text, { body: FB_SOLICITAR_DATOS, source: 'bot_fallback' });
    }
    return reply(prisma, candidate.id, from, FB_SOLICITAR_HV, text, { body: FB_SOLICITAR_HV, source: 'bot_fallback' });
  }
}

// ---------------------------------------------------------------------------
// Multiline helpers
// ---------------------------------------------------------------------------
async function scheduleMultilineWindow(prisma, candidateId) {
  const windowMs = getMultilineWindowMs();
  const windowUntil = new Date(Date.now() + windowMs);
  const updated = await prisma.candidate.update({
    where: { id: candidateId },
    data: { multilineWindowUntil: windowUntil, multilineBatchVersion: { increment: 1 } },
    select: { multilineBatchVersion: true }
  });
  return { windowMs, batchVersion: updated.multilineBatchVersion };
}

async function fetchPendingTextBatch(prisma, candidateId) {
  return prisma.message.findMany({
    where: { candidateId, direction: MessageDirection.INBOUND, messageType: MessageType.TEXT, respondedAt: null },
    orderBy: { createdAt: 'asc' },
    take: 12
  });
}

async function tryAcquireMultilineProcessing(prisma, candidateId, batchVersion) {
  const acquired = await prisma.candidate.updateMany({
    where: { id: candidateId, multilineBatchVersion: batchVersion, multilineWindowUntil: { lte: new Date() } },
    data: { multilineWindowUntil: null, multilineBatchVersion: { increment: 1 } }
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
    where: { id: { not: candidate.id }, documentType: candidate.documentType, documentNumber: candidate.documentNumber, phone: { not: candidate.phone } },
    select: { id: true, phone: true }
  });
  if (!duplicate) return;
  await prisma.candidate.update({
    where: { id: candidate.id },
    data: { potentialDuplicate: true, potentialDuplicateAt: new Date(), potentialDuplicateNote: `Documento coincide con ${duplicate.phone}` }
  });
}

// ---------------------------------------------------------------------------
// Handler de imágenes (anuncios de vacante)
// ---------------------------------------------------------------------------

/**
 * Descarga la imagen de WhatsApp y retorna el buffer en base64.
 * Soporta message.type === 'image' con message.image.id
 */
async function downloadImageAsBase64(message) {
  try {
    const mediaId = message.image?.id;
    if (!mediaId) return null;
    const metadata = await fetchMediaMetadata(mediaId);
    const buffer = await downloadMedia(metadata.url);
    return Buffer.isBuffer(buffer) ? buffer.toString('base64') : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Router principal
// ---------------------------------------------------------------------------

export function webhookRouter(prisma) {
  const router = express.Router();

  // Verificación Meta
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

        const candidate = await prisma.candidate.upsert({ where: { phone: from }, update: {}, create: { phone: from } });
        const activeVacancies = await getActiveVacancies(prisma);
        const availableSlots = await getAvailableInterviewSlots(prisma);

        // ---------------------------------------------------------------
        // Mensajes de texto (con soporte a imágenes en siguiente bloque)
        // ---------------------------------------------------------------
        if (message.type === 'text') {
          const body = message.text?.body || '';
          const inbound = await saveInboundMessage(prisma, candidate.id, message, body, MessageType.TEXT, from);
          if (!inbound.isNew) continue;

          await cancelReminderOnInbound(prisma, candidate.id);

          const freshCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id } });
          if (shouldBlockAutomation(freshCandidate)) continue;

          // Ventana multiline
          const scheduling = await scheduleMultilineWindow(prisma, candidate.id);
          await sleep(scheduling.windowMs);

          const stillOwner = await tryAcquireMultilineProcessing(prisma, candidate.id, scheduling.batchVersion);
          if (!stillOwner) continue;

          const pendingBatch = await fetchPendingTextBatch(prisma, candidate.id);
          if (!pendingBatch.length) continue;

          const consolidatedText = consolidateTextMessages(pendingBatch);
          const anchorMessage = pendingBatch[pendingBatch.length - 1];
          const candidateForBatch = await prisma.candidate.findUnique({ where: { id: candidate.id }, include: { vacancy: true } });
          const debugTrace = createDebugTrace({ phone: from, currentStepBefore: candidateForBatch.currentStep });

          try {
            await processText(prisma, candidateForBatch, from, consolidatedText, debugTrace, {
              activeVacancies,
              availableSlots,
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

        // ---------------------------------------------------------------
        // Imágenes — el candidato manda foto del anuncio de la vacante
        // ---------------------------------------------------------------
        if (message.type === 'image') {
          const inbound = await saveInboundMessage(prisma, candidate.id, message, '[imagen]', MessageType.TEXT, from);
          if (!inbound.isNew) continue;

          await cancelReminderOnInbound(prisma, candidate.id);
          const freshCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id }, include: { vacancy: true } });
          if (shouldBlockAutomation(freshCandidate)) continue;

          const debugTrace = createDebugTrace({ phone: from, currentStepBefore: freshCandidate.currentStep });
          debugTrace.image_received = true;

          const imageBase64 = await downloadImageAsBase64(message);
          debugTrace.image_downloaded = Boolean(imageBase64);

          try {
            // Pasar imagen a processText para que runAITurn la procese con visión
            const conversationHistory = await buildConversationHistory(prisma, candidate.id);
            const candidateState = buildCandidateStateSnapshot(freshCandidate);
            const aiResult = await runAITurn({
              conversationHistory,
              candidateState,
              activeVacancies,
              currentVacancyKey: freshCandidate.vacancy?.key || null,
              availableSlots,
              imageBase64,
              imageMimeType: message.image?.mime_type || 'image/jpeg'
            });

            debugTrace.openai_used = aiResult.used;
            debugTrace.openai_intent = aiResult.intent;
            debugTrace.ai_action = aiResult.action;

            const handled = await handleActionFromAI(prisma, freshCandidate, from, aiResult, '[imagen]', debugTrace, activeVacancies);
            if (!handled) {
              await reply(prisma, candidate.id, from, 'Recibí tu imagen. Si deseas aplicar a alguna vacante, cuéntame a cuál te interesas y con gusto te ayudo.', '', { source: 'bot_flow' });
            }
          } finally {
            const updatedCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id }, select: { currentStep: true } });
            debugTrace.currentStep_after = updatedCandidate?.currentStep || debugTrace.currentStep_before;
            console.log('[IMAGE_TRACE]', JSON.stringify(debugTrace));
            await attachDebugTrace(prisma, inbound.id, debugTrace);
          }
          continue;
        }

        // ---------------------------------------------------------------
        // Documentos — CV del candidato
        // ---------------------------------------------------------------
        const inbound = await saveInboundMessage(prisma, candidate.id, message, message.document?.filename || '', MessageType.DOCUMENT, from);
        if (!inbound.isNew) continue;

        await cancelReminderOnInbound(prisma, candidate.id);

        const freshCandidate = await prisma.candidate.findUnique({ where: { id: candidate.id } });
        if (shouldBlockAutomation(freshCandidate)) continue;

        const debugTrace = createDebugTrace({ phone: from, currentStepBefore: freshCandidate.currentStep });
        debugTrace.cv_detected = message.type === 'document';

        try {
          if (message.type === 'document') {
            const mimeType = message.document?.mime_type || '';
            if (!isCvMimeTypeAllowed(mimeType)) {
              debugTrace.cv_invalid_mime = true;
              console.warn('[CV_ERROR]', JSON.stringify({ phone: from, mimeType, reason: 'invalid_mime' }));
              await reply(prisma, candidate.id, from, 'Recibí tu archivo, pero por favor envíalo como PDF o Word (.doc/.docx).', '', { source: 'bot_flow' });
            } else {
              try {
                const metadata = await fetchMediaMetadata(message.document.id);
                const cvBuffer = await downloadMedia(metadata.url);
                await prisma.candidate.update({
                  where: { id: candidate.id },
                  data: { cvData: cvBuffer, cvMimeType: mimeType, cvOriginalName: message.document?.filename || 'hoja_de_vida' }
                });
                debugTrace.cv_saved = true;
                console.log('[CV_TRACE]', JSON.stringify({ phone: from, filename: message.document?.filename || null, mimeType }));

                const afterCvSave = await prisma.candidate.findUnique({ where: { id: candidate.id } });
                const missing = getMissingFields(afterCvSave);

                if (shouldFinalizeAfterCv({ missingFields: missing })) {
                  await prisma.candidate.update({
                    where: { id: candidate.id },
                    data: { currentStep: ConversationStep.DONE, status: CandidateStatus.REGISTRADO }
                  });
                  await reply(prisma, candidate.id, from, FB_MENSAJE_FINAL, '', { body: FB_MENSAJE_FINAL, source: 'bot_flow' });
                } else {
                  if (afterCvSave.currentStep !== ConversationStep.COLLECTING_DATA && afterCvSave.currentStep !== ConversationStep.CONFIRMING_DATA) {
                    await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.COLLECTING_DATA } });
                  }
                  await reply(prisma, candidate.id, from, `Hoja de vida recibida. Aún necesito estos datos para completar tu registro: ${missing.join(', ')}`, '', { source: 'bot_flow' });
                }
              } catch (error) {
                debugTrace.cv_download_failed = true;
                debugTrace.error_summary = summarizeError(error);
                console.error('[CV_ERROR]', JSON.stringify({ phone: from, error: debugTrace.error_summary }));
                await reply(prisma, candidate.id, from, 'No pude descargar tu hoja de vida en este momento. Inténtalo nuevamente en unos minutos.', '', { source: 'bot_flow' });
              }
            }
          } else if (freshCandidate.currentStep === ConversationStep.DONE) {
            await reply(prisma, candidate.id, from, FB_DONE_CV_REPEAT, '', { source: 'bot_cv_request' });
          } else {
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
