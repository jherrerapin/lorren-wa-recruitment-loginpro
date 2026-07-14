import axios from 'axios';
import { MessageDirection, MessageType } from '@prisma/client';
import { sendAudioMessage, sendDocumentMessage, sendImageMessage, sendTextMessage } from './whatsapp.js';
import { normalizeKnowledgeContent } from './botKnowledge.js';
import { isCvMimeTypeAllowed } from './cvFlow.js';
import { fetchMediaMetadata, downloadMedia } from './media.js';
import { storeCandidateCv } from './cvStorage.js';
import {
  persistInboundConversationMessage,
  persistOutboundConversationMessage,
  updateConversationMessagePayload
} from './conversationMessageRepository.js';

const DEFAULT_SUPERVISOR_PHONE = '3052982551';
const WINDOW_WARNING_AFTER_MS = 23 * 60 * 60 * 1000;
const WINDOW_CLOSED_AFTER_MS = 24 * 60 * 60 * 1000;
const DOT_COOLDOWN_MS = 60 * 60 * 1000;
const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const SUPERVISOR_REPLY_MODEL = process.env.OPENAI_SUPERVISOR_REPLY_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4-mini-2026-03-17';

export function getSupervisorPhone() {
  return String(process.env.ADMIN_WHATSAPP_NUMBER || process.env.FORWARD_MEDIA_TO || DEFAULT_SUPERVISOR_PHONE).replace(/\D/g, '');
}

export function isSupervisorPhone(phone = '') {
  return String(phone || '').replace(/\D/g, '') === getSupervisorPhone();
}

function includesAny(value = '', terms = []) {
  const normalized = String(value || '').toLowerCase();
  return terms.some((term) => normalized.includes(String(term).toLowerCase()));
}

export function localizeManualReviewReason(reason = '', reviewType = 'question', extra = {}) {
  const semanticIntent = Array.isArray(extra?.semanticIntent)
    ? extra.semanticIntent.join(' ')
    : String(extra?.semanticIntent || '');
  const normalizedReason = String(reason || '').toLowerCase();
  const normalizedIntent = semanticIntent.toUpperCase();

  if (normalizedIntent.includes('ASK_INTERVIEW_ADDRESS')) {
    return 'El candidato tiene una entrevista activa y pidió información de dirección que debe validarse con la información disponible.';
  }
  if (normalizedIntent.includes('ASK_INTERVIEW_CONTACT_PERSON')) {
    return 'El candidato tiene una entrevista activa y preguntó por una persona o punto de contacto al llegar; falta validar ese dato.';
  }
  if (normalizedIntent.includes('ASK_REQUIRED_DOCUMENTS')) {
    return 'El candidato tiene una entrevista activa y preguntó por documentos o requisitos; falta validar la información exacta.';
  }
  if (includesAny(normalizedReason, ['active appointment', 'appointment', 'interview', 'not answerable'])) {
    return 'El candidato tiene una entrevista activa y envió una duda o novedad que Lórren no puede responder con seguridad desde la vacante o la cita registrada.';
  }
  if (normalizedReason.includes('vacancy')) {
    return 'Se requiere validar información de la vacante antes de responder al candidato.';
  }
  if (normalizedReason.includes('document')) {
    return 'El candidato envió o preguntó por documentos y se requiere validación del equipo.';
  }
  return 'Se requiere apoyo del equipo para responder con precisión al candidato.';
}

async function getOrCreateSupervisorCandidate(prisma) {
  const supervisorPhone = getSupervisorPhone();
  return prisma.candidate.upsert({
    where: { phone: supervisorPhone },
    update: {},
    create: { phone: supervisorPhone, fullName: 'Administrador del sistema' }
  });
}

async function saveSupervisorThreadOutbound(prisma, body, rawPayload = {}) {
  const supervisor = await getOrCreateSupervisorCandidate(prisma);
  return saveSupervisorOutbound(prisma, supervisor.id, body, rawPayload);
}

function isManualCandidateOutbound(message = {}) {
  const payload = message.rawPayload || {};
  const source = String(payload.source || payload.sourceCategory || '').toLowerCase();
  if (payload.target === 'admin_supervisor') return false;
  return payload.actor === 'RECRUITER'
    || source === 'manual_authorized'
    || source === 'admin_outbound'
    || source.startsWith('admin_manual_')
    || source.startsWith('admin_');
}

async function hasManualCandidateOutboundAfter(prisma, candidateId, createdAt) {
  const message = await prisma.message.findFirst({
    where: {
      candidateId,
      direction: MessageDirection.OUTBOUND,
      messageType: MessageType.TEXT,
      createdAt: { gte: createdAt || new Date(0) }
    },
    orderBy: { createdAt: 'desc' }
  });
  return Boolean(message && isManualCandidateOutbound(message));
}

function formatCandidateName(candidate = {}) {
  return String(candidate?.fullName || 'Sin nombre').trim() || 'Sin nombre';
}

function hasScheduledInterviewFromCandidate(candidate = {}) {
  return candidate?.currentStep === 'SCHEDULED' || candidate?.status === 'SCHEDULED';
}

async function hasScheduledInterview(prisma, candidate = {}) {
  if (candidate?.id && prisma?.interviewBooking?.findFirst) {
    const booking = await prisma.interviewBooking.findFirst({
      where: {
        candidateId: candidate.id,
        status: { in: ['SCHEDULED', 'CONFIRMED'] }
      },
      select: { id: true }
    }).catch(() => null);
    if (booking) return true;
  }
  return hasScheduledInterviewFromCandidate(candidate);
}

function formatInterviewStatus(hasInterview) {
  return hasInterview ? 'Sí' : 'No';
}

async function saveSupervisorOutbound(prisma, candidateId, body, rawPayload = {}) {
  if (!prisma?.message?.create || !candidateId) return null;
  const result = await persistOutboundConversationMessage(prisma, {
    candidateId,
    messageType: MessageType.TEXT,
    body,
    rawPayload: {
      ...rawPayload,
      target: 'admin_supervisor',
      visibility: 'internal',
      neverSendToCandidate: true,
      language: 'es-CO',
      supervisorPhone: getSupervisorPhone(),
      body
    }
  });
  return result.message;
}

export async function ensureSupervisorWindowOpen(prisma, { now = new Date() } = {}) {
  const supervisorPhone = getSupervisorPhone();
  const supervisor = await prisma?.candidate?.findUnique?.({ where: { phone: supervisorPhone } });
  if (!supervisor?.id || !supervisor.lastInboundAt) return false;

  const lastInboundAge = now.getTime() - new Date(supervisor.lastInboundAt).getTime();
  if (lastInboundAge < WINDOW_WARNING_AFTER_MS || lastInboundAge >= WINDOW_CLOSED_AFTER_MS) return false;

  const recentDot = await prisma.message.findFirst({
    where: {
      candidateId: supervisor.id,
      direction: MessageDirection.OUTBOUND,
      body: '.',
      createdAt: { gte: new Date(now.getTime() - DOT_COOLDOWN_MS) }
    },
    orderBy: { createdAt: 'desc' }
  });
  if (recentDot) return false;

  await sendTextMessage(supervisorPhone, '.');
  await saveSupervisorOutbound(prisma, supervisor.id, '.', { source: 'admin_window_keepalive_dot' });
  await prisma.candidate.update({ where: { id: supervisor.id }, data: { lastOutboundAt: now } });
  return true;
}

export async function notifySupervisorManualReview(prisma, candidate, { reason = 'Intervención humana requerida', inboundText = '', reviewType = 'question', extra = {} } = {}) {
  const supervisorPhone = getSupervisorPhone();
  const publicReason = localizeManualReviewReason(reason, reviewType, extra);
  const scheduledInterview = await hasScheduledInterview(prisma, candidate);
  const body = [
    'Apoyo Lórren',
    `Número: ${candidate?.phone || ''}`,
    `Nombre: ${formatCandidateName(candidate)}`,
    `Entrevista agendada: ${formatInterviewStatus(scheduledInterview)}`,
    inboundText ? `Candidato: ${inboundText}` : null,
    'Responder con info para el candidato.'
  ].filter(Boolean).join('\n');

  await sendTextMessage(supervisorPhone, body);
  await saveSupervisorThreadOutbound(prisma, body, {
    ...extra,
    source: 'admin_manual_review_request',
    manualReviewType: reviewType,
    candidateId: candidate.id,
    candidatePhone: candidate.phone,
    reason: publicReason,
    technicalReason: reason,
    inboundText,
    hasScheduledInterview: scheduledInterview,
    resolved: false
  });
}

export async function notifySupervisorAttachment(prisma, candidate, { mediaType, media = {}, caption = '', sequence = null, total = null } = {}) {
  const supervisorPhone = getSupervisorPhone();
  const scheduledInterview = await hasScheduledInterview(prisma, candidate);
  const position = sequence ? ` ${sequence}${total ? `/${total}` : ''}` : '';
  const typeLabel = mediaType === 'document' ? 'Documento' : (mediaType === 'audio' ? 'Audio' : (mediaType === 'image' ? 'Foto' : 'Adjunto'));
  const displayCaption = media?.filename || caption;
  const body = [
    `${typeLabel}${position}`,
    `Número: ${candidate?.phone || ''}`,
    `Nombre: ${formatCandidateName(candidate)}`,
    `Entrevista agendada: ${formatInterviewStatus(scheduledInterview)}`,
    displayCaption ? `Archivo: ${displayCaption}` : null
  ].filter(Boolean).join('\n');
  await sendTextMessage(supervisorPhone, body);
  await saveSupervisorThreadOutbound(prisma, body, {
    source: 'admin_attachment_forward_notice',
    candidateId: candidate.id,
    candidatePhone: candidate.phone,
    mediaType,
    mediaId: media?.id || null,
    fileName: media?.filename || null,
    mimeType: media?.mime_type || null,
    hasScheduledInterview: scheduledInterview
  });
  if (mediaType === 'document' && media?.id) {
    await sendDocumentMessage(supervisorPhone, { id: media.id, filename: media.filename });
  } else if (mediaType === 'image' && media?.id) {
    await sendImageMessage(supervisorPhone, { id: media.id });
  } else if (mediaType === 'audio' && media?.id) {
    await sendAudioMessage(supervisorPhone, { id: media.id });
  }
}

async function findPendingManualRequest(prisma) {
  const recentRequests = await prisma.message.findMany({
    where: {
      direction: MessageDirection.OUTBOUND,
      messageType: MessageType.TEXT
    },
    orderBy: { createdAt: 'desc' },
    take: 50
  });
  for (const message of recentRequests) {
    const payload = message.rawPayload || {};
    if (payload.target === 'admin_supervisor' && payload.source === 'admin_manual_review_request' && payload.resolved !== true) {
      const reviewCandidateId = payload.candidateId || message.candidateId;
      const candidate = await prisma.candidate.findUnique({ where: { id: reviewCandidateId } });
      if (candidate?.botPaused) return { request: message, candidate };
    }
  }
  return null;
}


function parseStructuredOutput(data = {}) {
  const output = data?.output || [];
  for (const item of output) {
    for (const part of item?.content || []) {
      if (part?.parsed && typeof part.parsed === 'object') return part.parsed;
      if (typeof part?.text === 'string') {
        try { return JSON.parse(part.text); } catch {}
      }
    }
  }
  return null;
}

function normalizeCandidateInstruction(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
}

function fallbackSupervisorInboundDecision({ adminMessage = '', manualOutboundAfterRequest = false } = {}) {
  const normalized = normalizeCandidateInstruction(adminMessage);
  if (!normalized) return { action: 'INTERNAL_ACK', candidateInstruction: '', reason: 'mensaje_vacio', confidence: 1, fallbackUsed: true };
  const tokenCount = normalized.split(/\s+/).filter(Boolean).length;
  const hasExplicitDetail = /\d|[:@]|\?|¿/.test(normalized);
  if (manualOutboundAfterRequest && tokenCount <= 3 && !hasExplicitDetail) {
    return { action: 'INTERNAL_ACK', candidateInstruction: '', reason: 'respuesta_manual_previa_ya_resolvio_el_caso', confidence: 0.68, fallbackUsed: true };
  }
  return { action: 'ANSWER_CANDIDATE', candidateInstruction: normalized, reason: 'respuesta_para_enviar_al_candidato', confidence: 0.5, fallbackUsed: true };
}

async function classifySupervisorInboundDecision({ adminMessage = '', candidateQuestion = '', candidate = {}, payload = {}, manualOutboundAfterRequest = false } = {}) {
  const normalized = normalizeCandidateInstruction(adminMessage);
  if (!process.env.OPENAI_API_KEY) return fallbackSupervisorInboundDecision({ adminMessage: normalized, manualOutboundAfterRequest });

  const response = await axios.post(RESPONSES_URL, {
    model: SUPERVISOR_REPLY_MODEL,
    input: [
      {
        role: 'system',
        content: [{
          type: 'input_text',
          text: [
            'Eres el módulo de coordinación entre administrador, Lórren y candidato.',
            'Tu tarea es decidir la intención operativa del mensaje del administrador según el contexto completo, no por palabras sueltas.',
            'Clasifica si el administrador está: dando una instrucción o información para responder al candidato; dejando un acuse interno porque ya intervino por otro canal; o seleccionando cuál documento del candidato debe guardarse como hoja de vida.',
            'No uses longitud del texto como criterio único. Una frase corta puede ser instrucción si aporta decisión para el candidato, y una frase larga puede ser nota interna.',
            'Si ya existe una respuesta manual posterior a la solicitud y el nuevo mensaje solo valida internamente que quedó bien, clasifícalo como INTERNAL_ACK.',
            'Si el caso es de varios documentos y el administrador señala cuál guardar, clasifícalo como DOCUMENT_SELECTION.',
            'Si el mensaje contiene la información que Lórren debe transmitir al candidato o una orden explícita de responderle, clasifícalo como ANSWER_CANDIDATE.',
            'El campo reason debe estar siempre en español.'
          ].join(' ')
        }]
      },
      {
        role: 'user',
        content: [{
          type: 'input_text',
          text: JSON.stringify({
            adminMessage: normalized,
            candidateQuestion,
            pendingReview: {
              reviewType: payload?.manualReviewType || 'question',
              hasScheduledInterview: Boolean(payload?.hasScheduledInterview)
            },
            candidate: {
              hasScheduledInterview: Boolean(payload?.hasScheduledInterview || hasScheduledInterviewFromCandidate(candidate))
            },
            conversationState: {
              manualOutboundAfterRequest
            }
          })
        }]
      }
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'supervisor_inbound_decision',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['ANSWER_CANDIDATE', 'INTERNAL_ACK', 'DOCUMENT_SELECTION'] },
            candidateInstruction: { type: 'string' },
            reason: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 }
          },
          required: ['action', 'candidateInstruction', 'reason', 'confidence']
        }
      }
    }
  }, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
  });

  const parsed = parseStructuredOutput(response.data) || {};
  if (!['ANSWER_CANDIDATE', 'INTERNAL_ACK', 'DOCUMENT_SELECTION'].includes(parsed.action)) {
    return fallbackSupervisorInboundDecision({ adminMessage: normalized, manualOutboundAfterRequest });
  }
  return {
    action: parsed.action,
    candidateInstruction: normalizeCandidateInstruction(parsed.candidateInstruction || normalized),
    reason: parsed.reason || 'decision_del_modelo',
    confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0,
    fallbackUsed: false
  };
}

async function buildAiSupervisorCandidateReply({ candidateQuestion = '', adminInstruction = '', candidate = {}, payload = {} } = {}) {
  const normalizedInstruction = normalizeCandidateInstruction(adminInstruction);
  if (!normalizedInstruction) return { text: '', model: null, fallbackUsed: true, reason: 'empty_instruction' };
  if (!process.env.OPENAI_API_KEY) {
    return { text: normalizedInstruction, model: null, fallbackUsed: true, reason: 'openai_disabled' };
  }

  const response = await axios.post(RESPONSES_URL, {
    model: SUPERVISOR_REPLY_MODEL,
    input: [
      {
        role: 'system',
        content: [{
          type: 'input_text',
          text: [
            'Eres Lórren, reclutador humano por WhatsApp. Convierte la instrucción del administrador en una respuesta breve, natural y amable para el candidato.',
            'No copies literalmente la instrucción si suena interna o telegráfica.',
            'No agregues información, promesas, requisitos, horarios, salarios, fechas, direcciones ni condiciones que no estén explícitamente en la instrucción del administrador.',
            'No menciones al administrador, revisión humana, escalamiento, IA, bot ni proceso interno.',
            'Responde directamente la duda del candidato y conserva el español colombiano profesional.'
          ].join(' ')
        }]
      },
      {
        role: 'user',
        content: [{
          type: 'input_text',
          text: JSON.stringify({
            candidateQuestion,
            adminInstruction: normalizedInstruction,
            candidate: {
              hasScheduledInterview: Boolean(payload?.hasScheduledInterview || hasScheduledInterviewFromCandidate(candidate))
            },
            reviewType: payload?.manualReviewType || 'question'
          })
        }]
      }
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'supervisor_candidate_reply',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            reply: { type: 'string' },
            reason: { type: 'string' }
          },
          required: ['reply', 'reason']
        }
      }
    }
  }, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  });

  const parsed = parseStructuredOutput(response.data);
  const reply = String(parsed?.reply || '').trim();
  if (!reply) return { text: normalizedInstruction, model: SUPERVISOR_REPLY_MODEL, fallbackUsed: true, reason: 'empty_model_reply' };
  return { text: reply.slice(0, 1200), model: SUPERVISOR_REPLY_MODEL, fallbackUsed: false, reason: parsed?.reason || 'ok' };
}

function buildKnowledgeContent({ candidateQuestion = '', adminInstruction = '', candidateReply = '' } = {}) {
  const question = normalizeKnowledgeContent(candidateQuestion);
  const instruction = normalizeKnowledgeContent(adminInstruction);
  const reply = normalizeKnowledgeContent(candidateReply);
  return normalizeKnowledgeContent([
    question ? `Duda del candidato: ${question}` : null,
    instruction ? `Instruccion validada por administrador: ${instruction}` : null,
    reply ? `Respuesta sugerida por Lorren: ${reply}` : null
  ].filter(Boolean).join('\n'));
}

function parseDocumentSelection(text = '') {
  const n = String(text || '').toLowerCase();
  const digit = n.match(/\b([1-9])\b/);
  if (digit) return Number(digit[1]);
  if (/\bprimer[oa]?\b/.test(n)) return 1;
  if (/\bsegund[oa]?\b/.test(n)) return 2;
  if (/\btercer[oa]?\b/.test(n)) return 3;
  if (/\bcuart[oa]?\b/.test(n)) return 4;
  return null;
}

async function saveSelectedDocumentAsCv(prisma, candidate, selectionText = '') {
  const selectedIndex = parseDocumentSelection(selectionText);
  if (!selectedIndex) return { saved: false, reason: 'no_selection' };

  const docs = await prisma.message.findMany({
    where: {
      candidateId: candidate.id,
      direction: MessageDirection.INBOUND,
      messageType: MessageType.DOCUMENT
    },
    orderBy: { createdAt: 'desc' },
    take: 8
  });
  const ordered = docs.reverse();
  const selected = ordered[selectedIndex - 1];
  const document = selected?.rawPayload?.document;
  if (!document?.id) return { saved: false, reason: 'missing_document' };

  const mimeType = document.mime_type || '';
  const filename = document.filename || 'hoja_de_vida';
  if (!isCvMimeTypeAllowed(mimeType, filename)) return { saved: false, reason: 'invalid_mime' };

  const metadata = await fetchMediaMetadata(document.id);
  const buffer = await downloadMedia(metadata.url);
  await storeCandidateCv(prisma, candidate.id, buffer, { mimeType: mimeType || null, originalName: filename });
  return { saved: true, filename, selectedIndex };
}

async function addSupervisorKnowledge(prisma, candidate, content, tags = 'admin_whatsapp') {
  if (!prisma?.botKnowledge?.create) return;
  const normalized = normalizeKnowledgeContent(content);
  if (!normalized) return;
  await prisma.botKnowledge.create({
    data: {
      scope: candidate.vacancyId ? 'VACANCY' : 'GLOBAL',
      content: normalized,
      tags,
      candidateId: null,
      vacancyId: candidate.vacancyId || null,
      createdBy: 'admin_whatsapp',
      updatedBy: 'admin_whatsapp'
    }
  }).catch((error) => console.warn('[ADMIN_SUPERVISOR_KNOWLEDGE_ERROR]', error?.message || error));
}

export async function handleSupervisorInbound(prisma, message = {}) {
  const supervisorPhone = getSupervisorPhone();
  const body = String(message?.text?.body || '').trim();
  const supervisor = await getOrCreateSupervisorCandidate(prisma);

  await persistInboundConversationMessage(prisma, {
  candidateId: supervisor.id,
  waMessageId: message?.id || null,
  messageType: MessageType.TEXT,
  body,
  rawPayload: message
});
  await prisma.candidate.update({ where: { id: supervisor.id }, data: { lastInboundAt: new Date() } });

  if (!body || body === '.') return { handled: true, action: 'keepalive' };

  const pending = await findPendingManualRequest(prisma);
  if (!pending) return { handled: true, action: 'no_pending_request' };

  const { request, candidate } = pending;
  const payload = request.rawPayload || {};

  const candidateQuestion = payload.inboundText || '';
  const manualOutboundAfterRequest = await hasManualCandidateOutboundAfter(prisma, candidate.id, request.createdAt);
  let supervisorDecision = null;
  let candidateReplyResult = null;
  let candidateReply = '';

  if (payload.manualReviewType === 'multiple_documents') {
    const selected = await saveSelectedDocumentAsCv(prisma, candidate, body).catch((error) => ({ saved: false, reason: error?.message || 'save_failed' }));
    if (selected.saved) {
      supervisorDecision = {
        action: 'DOCUMENT_SELECTION',
        candidateInstruction: body,
        reason: 'documento_seleccionado_por_administrador_para_guardar_como_hoja_de_vida',
        confidence: 1,
        fallbackUsed: true
      };
      candidateReply = 'Recibí los documentos. Dejé guardada tu hoja de vida; para el proceso solo necesito la hoja de vida.';
      candidateReplyResult = { text: candidateReply, model: null, fallbackUsed: true, reason: 'multiple_documents_selected' };
    }
  }

  if (!supervisorDecision) {
    supervisorDecision = await classifySupervisorInboundDecision({
      adminMessage: body,
      candidateQuestion,
      candidate,
      payload,
      manualOutboundAfterRequest
    }).catch((error) => {
      console.warn('[ADMIN_SUPERVISOR_DECISION_ERROR]', error?.message || error);
      return fallbackSupervisorInboundDecision({ adminMessage: body, manualOutboundAfterRequest });
    });
  }

  if (supervisorDecision.action === 'INTERNAL_ACK') {
    await updateConversationMessagePayload(prisma, {
    messageId: request.id,
    rawPayload: {
      ...payload,
      resolved: Boolean(manualOutboundAfterRequest),
      resolvedAt: manualOutboundAfterRequest ? new Date().toISOString() : payload.resolvedAt,
      resolvedBy: manualOutboundAfterRequest ? 'manual_candidate_outbound_confirmed_by_supervisor_context' : payload.resolvedBy,
      supervisorDecision
    }
  });
    return {
      handled: true,
      action: manualOutboundAfterRequest ? 'internal_ack_resolved_after_manual_outbound' : 'internal_ack_kept_pending',
      candidateId: candidate.id
    };
  }

  if (!candidateReply) {
    const adminInstruction = supervisorDecision.candidateInstruction || body;
    candidateReplyResult = await buildAiSupervisorCandidateReply({
      candidateQuestion,
      adminInstruction,
      candidate,
      payload
    }).catch((error) => {
      console.warn('[ADMIN_SUPERVISOR_AI_REPLY_ERROR]', error?.message || error);
      return { text: normalizeCandidateInstruction(adminInstruction), model: SUPERVISOR_REPLY_MODEL, fallbackUsed: true, reason: 'ai_error' };
    });
    candidateReply = candidateReplyResult.text;
  }

  await sendTextMessage(candidate.phone, candidateReply);
  await persistOutboundConversationMessage(prisma, {
  candidateId: candidate.id,
  messageType: MessageType.TEXT,
  body: candidateReply,
  rawPayload: {
    source: 'admin_supervisor_answer',
    supervisorPhone,
    originalSupervisorInstruction: body,
    aiModel: candidateReplyResult?.model || null,
    aiFallbackUsed: Boolean(candidateReplyResult?.fallbackUsed),
    aiReason: candidateReplyResult?.reason || null,
    requestMessageId: request.id,
    supervisorDecision
  }
});
  await prisma.candidate.update({
    where: { id: candidate.id },
    data: {
      botPaused: false,
      botPausedAt: null,
      botPausedBy: null,
      botPauseReason: null,
      botResumeMode: null,
      lastOutboundAt: new Date()
    }
  });
  await updateConversationMessagePayload(prisma, {
  messageId: request.id,
  rawPayload: {
    ...payload,
    resolved: true,
    resolvedAt: new Date().toISOString()
  }
});
  await addSupervisorKnowledge(
    prisma,
    candidate,
    buildKnowledgeContent({ candidateQuestion, adminInstruction: body, candidateReply }),
    `admin_whatsapp,manual_review${payload.manualReviewType ? `,type:${payload.manualReviewType}` : ''}`
  );
  return { handled: true, action: 'answered_candidate', candidateId: candidate.id };
}
