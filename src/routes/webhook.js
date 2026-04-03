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

const FAQ_RESPONSE = 'En este momento estamos recolectando hojas de vida. La entrevista está prevista para el 8 de abril. Por favor mantente pendiente del llamado del equipo de reclutamiento.';

const SALUDO_INICIAL = `Hola, gracias por comunicarte con LoginPro.
Te comparto la información de la vacante disponible:

*Vacante: Auxiliar de Cargue y Descargue*

Estamos en búsqueda de personal para trabajar en Ibagué, en el sector aeropuerto.

*Condiciones del cargo:*
- Pago quincenal
- Disponibilidad para turnos rotativos
- Horas extras
- Contrato por obra labor directamente con la empresa
- Prestaciones de ley
- Debe contar con medio de transporte (moto o bicicleta)
- La entrevista está prevista para el 8 de abril
- Debes estar pendiente del llamado para entrevista

Si estás interesado en continuar, respóndeme y te solicitaré tus datos.`;

const SOLICITAR_DATOS = 'Perfecto. Envíame por favor estos datos para continuar: nombre completo, tipo de documento, número de documento, edad, barrio, si tienes experiencia en el cargo y cuánto tiempo, si tienes restricciones médicas y qué medio de transporte tienes. Puedes enviarlos en un solo mensaje, como te sea más fácil.';
const DESCARTE_MSG = 'Gracias por tu interés. En este caso no es posible continuar con tu postulación porque no cumples con uno de los requisitos definidos para esta vacante.';
const CIERRE_NO_INTERES = 'Entendido. Si más adelante deseas continuar con la postulación, puedes volver a escribirme y con gusto retomamos el proceso.';
const SOLICITAR_HV = '¡Gracias! Ya tengo tus datos. Por favor adjunta tu hoja de vida (HV) en PDF o Word (.doc/.docx) para finalizar tu postulación.';
const RECORDATORIO_HV = 'Para continuar necesito que adjuntes tu Hoja de vida (HV) en PDF o Word (.doc/.docx). Cuando la envíes, finalizamos tu proceso.';
const MENSAJE_FINAL = 'Tu información y Hoja de vida (HV) fueron recibidas correctamente. Las entrevistas están previstas para el 8 de abril. Debes estar pendiente del mensaje o llamada del reclutador; por ese medio te confirmarán la hora y el lugar.';
const MENSAJE_DONE_ACK = '¡Con gusto! Ya quedó tu registro completo. Si surge una novedad, te contactamos por este medio.';
const MENSAJE_DONE_CV_REPEAT = 'Ya tenemos tu registro completo. Si deseas actualizar tu hoja de vida, puedes enviarla y la adjuntamos a tu postulación.';
const GUIA_CONTINUAR = 'Puedo ayudarte a continuar con la postulación. Si deseas seguir, envíame tus datos y te voy guiando.';
const CONFIRMACION_PROMPT = '¿Está correcto? Responde Sí para continuar o envíame la corrección.';

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

function normalizeText(text = '') { return text.trim(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function isFAQ(text) { const n = normalizeText(text).toLowerCase(); return /(cu[aá]ndo\s+(empiezan|me llaman|inicia|arranca|se comunican)|para\s+cu[aá]ndo)/i.test(n); }
function isAffirmativeInterest(text) {
  const n = normalizeText(text).toLowerCase(); if (!n) return false;
  const patterns = ['si', 'sí', 'claro', 'listo', 'ok', 'okay', 'dale', 'de una', 'hagámosle', 'vamos', 'estoy interesado', 'estoy interesada', 'me interesa', 'quiero aplicar', 'quiero postularme', 'quiero participar', 'deseo continuar', 'me gustaría postularme', 'quiero seguir', 'continuar'];
  if (patterns.some((p) => n === p || n.includes(p))) return true;
  return /(quiero|deseo|me gustar[ií]a|vamos|listo|claro).*(aplicar|postular|continuar|seguir|participar)/i.test(n);
}
function isAffirmativeConfirmation(text) {
  const n = normalizeText(text).toLowerCase();
  return /^(si|sí|correcto|esta bien|está bien|todo bien|confirmo|de acuerdo|ok|listo)\b/.test(n);
}
function isNegativeInterest(text) { const n = normalizeText(text).toLowerCase(); return /^(no+|nop+|negativo)$|no gracias|no me interesa|no estoy interesad|no deseo|paso|ya no|prefiero no/i.test(n); }
function shouldRejectByRequirements(text, parsed = {}) {
  const n = normalizeText(text).toLowerCase();
  if (parsed.age && (parsed.age < 18 || parsed.age > 50)) return { reject: true, reason: 'Edad fuera del rango permitido', details: `Edad detectada: ${parsed.age}` };
  if (/no\s+tengo\s+documento\s+vigente|documento\s+vencido|sin\s+documento\s+vigente/.test(n)) {
    return { reject: true, reason: 'Documento no vigente', details: 'El candidato indicó no tener documento vigente.' };
  }
  if (/(soy\s+extranjero|soy\s+venezolan|extranjera?|no\s+soy\s+colombian)/.test(n)) {
    const type = parsed.documentType || '';
    if (!['CE', 'PPT', 'Pasaporte'].includes(type)) {
      return {
        reject: true,
        reason: 'Extranjero sin documento válido',
        details: 'Para candidatos extranjeros solo son válidos CE, PPT o Pasaporte.'
      };
    }
  }
  // TODO(city+vacancy): cuando la vacante marque transporte como excluyente, aplicar descarte explícito
  // con parsed.transportMode === 'Sin medio de transporte'.
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
function getNaturalDelayMs(inputText = '', outputText = '') { if (process.env.NODE_ENV === 'test') return 0; const l = Math.max(normalizeText(inputText).length, normalizeText(outputText).length, 1); return Math.max(1500, Math.min(2500, 1500 + Math.min(1000, Math.round(l * 8)))); }

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

  const understanding = await conversationUnderstanding(cleanText);
  const aiResult = await tryOpenAIParse(cleanText);
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
  if (resolvedIntent) debugTrace.openai_intent = resolvedIntent;
  debugTrace.openai_detected_fields = Object.keys(aiFields).filter((k) => normalizedData[k] !== undefined);
  debugTrace.source_by_field = sourceByField;
  debugTrace.normalized_fields = normalizedData;

  if (aiResult.status === 'error') {
    debugTrace.error_summary = summarizeError(aiResult.error);
    console.warn('[AI_FALLBACK]', JSON.stringify({ phone: candidate.phone, error: debugTrace.error_summary }));
  } else if (aiResult.status === 'disabled') {
    console.log('[AI_FALLBACK]', JSON.stringify({ phone: candidate.phone, reason: 'openai_disabled' }));
  }

  if (resolvedIntent === 'faq' || isFAQ(cleanText)) return reply(prisma, candidate.id, from, FAQ_RESPONSE, cleanText, { body: FAQ_RESPONSE, source: 'bot_flow' });
  if (candidate.status === CandidateStatus.RECHAZADO) return reply(prisma, candidate.id, from, DESCARTE_MSG);
  if (candidate.currentStep === ConversationStep.MENU) {
    await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.GREETING_SENT } });
    return reply(prisma, candidate.id, from, SALUDO_INICIAL, cleanText, { body: SALUDO_INICIAL, source: 'bot_flow' });
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
    if (missing.length) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.COLLECTING_DATA } });
      return reply(prisma, candidate.id, from, `Gracias. Para continuar solo me falta: ${missing.join(', ')}`, cleanText, { source: 'bot_flow' });
    }

    if (resolveStepAfterDataCompletion({ hasCv: hasHv(updatedCandidate) }) === ConversationStep.DONE) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.DONE, status: CandidateStatus.REGISTRADO } });
      return reply(prisma, candidate.id, from, MENSAJE_FINAL, cleanText, { body: MENSAJE_FINAL, source: 'bot_flow' });
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
    if (resolvedIntent === 'confirmation_no_or_correction' && Object.keys(normalizedData).length === 0) {
      return reply(prisma, candidate.id, from, 'Gracias por avisar. Indícame por favor el dato que deseas corregir y lo actualizo.');
    }
    const latest = await prisma.candidate.findUnique({ where: { id: candidate.id } });
    return reply(prisma, candidate.id, from, buildConfirmationSummary(latest));
  }

  if (candidate.currentStep === ConversationStep.GREETING_SENT) {
      if (isNegativeInterest(cleanText)) { await reply(prisma, candidate.id, from, CIERRE_NO_INTERES, cleanText, { body: CIERRE_NO_INTERES, source: 'bot_flow' }); return; }
    if (isAffirmativeInterest(cleanText) || hasDataIntent) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.COLLECTING_DATA } });
      if (hasDataIntent) {
        const rejection = shouldRejectByRequirements(cleanText, normalizedData);
        if (rejection.reject) return rejectCandidate(prisma, candidate.id, from, rejection);
        const updated = await applyDecisionsAndUpdate();
        if (shouldAskForConfirmation(updated, normalizedData)) {
          await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.CONFIRMING_DATA } });
          return reply(prisma, candidate.id, from, buildConfirmationSummary(updated));
        }
        const missing = getMissingFields(updated);
        return reply(prisma, candidate.id, from, `Gracias. Para continuar solo me falta: ${missing.join(', ')}`, cleanText, { source: 'bot_flow' });
      }
      return reply(prisma, candidate.id, from, SOLICITAR_DATOS, cleanText, { body: SOLICITAR_DATOS, source: 'bot_flow' });
    }

    const rejection = shouldRejectByRequirements(cleanText, normalizedData);
    if (rejection.reject) return rejectCandidate(prisma, candidate.id, from, rejection);

    if (Object.keys(normalizedData).length >= 1) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.COLLECTING_DATA } });
      const updated = await applyDecisionsAndUpdate();
      if (shouldAskForConfirmation(updated, normalizedData)) {
        await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.CONFIRMING_DATA } });
        return reply(prisma, candidate.id, from, buildConfirmationSummary(updated));
      }
      const missing = getMissingFields(updated);
      return reply(prisma, candidate.id, from, `Gracias. Para continuar solo me falta: ${missing.join(', ')}`, cleanText, { source: 'bot_flow' });
    }
    return reply(prisma, candidate.id, from, GUIA_CONTINUAR, cleanText, { body: GUIA_CONTINUAR, source: 'bot_flow' });
  }

  if (candidate.currentStep === ConversationStep.COLLECTING_DATA || candidate.currentStep === ConversationStep.ASK_CV) {
    const rejection = shouldRejectByRequirements(cleanText, normalizedData);
    if (rejection.reject) return rejectCandidate(prisma, candidate.id, from, rejection);
    const updated = await applyDecisionsAndUpdate();

    if (shouldAskForConfirmation(updated, normalizedData)) {
      await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.CONFIRMING_DATA } });
      return reply(prisma, candidate.id, from, buildConfirmationSummary(updated));
    }

    const missing = getMissingFields(updated);
    return reply(prisma, candidate.id, from, `Gracias. Para continuar solo me falta: ${missing.join(', ')}`, cleanText, { source: 'bot_flow' });
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
                await prisma.candidate.update({ where: { id: candidate.id }, data: { cvData: cvBuffer, cvMimeType: mimeType, cvOriginalName: message.document?.filename || 'hoja_de_vida' } });
                debugTrace.cv_saved = true;
                console.log('[CV_TRACE]', JSON.stringify({ phone: from, filename: message.document?.filename || null, mimeType }));
                const afterCvSave = await prisma.candidate.findUnique({ where: { id: candidate.id } });
                const missing = getMissingFields(afterCvSave);
                if (shouldFinalizeAfterCv({ missingFields: missing })) {
                  await prisma.candidate.update({ where: { id: candidate.id }, data: { currentStep: ConversationStep.DONE, status: CandidateStatus.REGISTRADO } });
                  await reply(prisma, candidate.id, from, MENSAJE_FINAL, '', { body: MENSAJE_FINAL, source: 'bot_flow' });
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
            await reply(prisma, candidate.id, from, MENSAJE_DONE_CV_REPEAT, '', { source: 'bot_cv_request' });
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
