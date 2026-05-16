import axios from 'axios';
import { MessageDirection, MessageType } from '@prisma/client';
import { sendDocumentMessage, sendImageMessage, sendTextMessage } from './whatsapp.js';
import { normalizeKnowledgeContent } from './botKnowledge.js';
import { isCvMimeTypeAllowed } from './cvFlow.js';
import { fetchMediaMetadata, downloadMedia } from './media.js';
import { storeCandidateCv } from './cvStorage.js';

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

function normalizeAckText(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isBareSupervisorAcknowledgement(value = '') {
  const n = normalizeAckText(value);
  if (!n) return true;
  return /^(ok|okay|listo|perfecto|vale|dale|bueno|gracias|muchas gracias|super|excelente|entendido|de acuerdo|correcto|si|sí|sii|esta bien|muy bien)$/.test(n);
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

function formatCandidateLabel(candidate = {}) {
  return candidate?.fullName ? `${candidate.phone} (${candidate.fullName})` : candidate?.phone;
}

async function saveSupervisorOutbound(prisma, candidateId, body, rawPayload = {}) {
  if (!prisma?.message?.create || !candidateId) return null;
  return prisma.message.create({
    data: {
      candidateId,
      direction: MessageDirection.OUTBOUND,
      messageType: MessageType.TEXT,
      body,
      rawPayload: {
        target: 'admin_supervisor',
        supervisorPhone: getSupervisorPhone(),
        ...rawPayload,
        body
      }
    }
  });
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

export async function notifySupervisorManualReview(prisma, candidate, { reason = 'Intervencion humana requerida', inboundText = '', reviewType = 'question', extra = {} } = {}) {
  const supervisorPhone = getSupervisorPhone();
  const label = formatCandidateLabel(candidate);
  const body = [
    'Lórren requiere apoyo humano.',
    `Candidato: ${label}`,
    `Motivo: ${reason}`,
    inboundText ? `Mensaje/duda del candidato: ${inboundText}` : null,
    'Responde por este chat con la información que Lórren debe enviar al candidato. Lórren no avisará al candidato mientras espera.'
  ].filter(Boolean).join('\n');

  await sendTextMessage(supervisorPhone, body);
  await saveSupervisorOutbound(prisma, candidate.id, body, {
    source: 'admin_manual_review_request',
    manualReviewType: reviewType,
    reason,
    inboundText,
    resolved: false,
    ...extra
  });
}

export async function notifySupervisorAttachment(prisma, candidate, { mediaType, media = {}, caption = '', sequence = null, total = null } = {}) {
  const supervisorPhone = getSupervisorPhone();
  const label = formatCandidateLabel(candidate);
  const position = sequence ? ` (${sequence}${total ? ` de ${total}` : ''})` : '';
  const body = `${mediaType === 'document' ? 'Documento' : 'Adjunto'}${position} recibido de ${label}${caption ? `: ${caption}` : ''}`;
  await sendTextMessage(supervisorPhone, body);
  await saveSupervisorThreadOutbound(prisma, body, {
    source: 'admin_attachment_forward_notice',
    candidateId: candidate.id,
    candidatePhone: candidate.phone,
    mediaType,
    mediaId: media?.id || null,
    fileName: media?.filename || null,
    mimeType: media?.mime_type || null
  });
  if (mediaType === 'document' && media?.id) {
    await sendDocumentMessage(supervisorPhone, { id: media.id, filename: media.filename }, caption || media.filename || 'documento');
  } else if (mediaType === 'image' && media?.id) {
    await sendImageMessage(supervisorPhone, { id: media.id }, caption || '');
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
      const candidate = await prisma.candidate.findUnique({ where: { id: message.candidateId } });
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
              fullName: candidate?.fullName || null,
              currentStep: candidate?.currentStep || null,
              status: candidate?.status || null
            },
            reviewType: payload?.manualReviewType || 'question',
            reason: payload?.reason || null
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

  await prisma.message.createMany({
    data: [{
      candidateId: supervisor.id,
      waMessageId: message?.id || null,
      direction: MessageDirection.INBOUND,
      messageType: MessageType.TEXT,
      body,
      rawPayload: message
    }],
    skipDuplicates: true
  });
  await prisma.candidate.update({ where: { id: supervisor.id }, data: { lastInboundAt: new Date() } });

  if (!body || body === '.') return { handled: true, action: 'keepalive' };

  const pending = await findPendingManualRequest(prisma);
  if (!pending) return { handled: true, action: 'no_pending_request' };

  const { request, candidate } = pending;
  const payload = request.rawPayload || {};

  if (isBareSupervisorAcknowledgement(body)) {
    const resolvedByManualOutbound = await hasManualCandidateOutboundAfter(prisma, candidate.id, request.createdAt);
    if (resolvedByManualOutbound) {
      await prisma.message.update({
        where: { id: request.id },
        data: { rawPayload: { ...payload, resolved: true, resolvedAt: new Date().toISOString(), resolvedBy: 'manual_candidate_outbound_ack' } }
      });
      return { handled: true, action: 'ack_resolved_after_manual_outbound', candidateId: candidate.id };
    }
    return { handled: true, action: 'ack_ignored_pending_request', candidateId: candidate.id };
  }

  const candidateQuestion = payload.inboundText || '';
  let candidateReplyResult = null;
  let candidateReply = '';

  if (payload.manualReviewType === 'multiple_documents') {
    const selected = await saveSelectedDocumentAsCv(prisma, candidate, body).catch((error) => ({ saved: false, reason: error?.message || 'save_failed' }));
    if (selected.saved) {
      candidateReply = 'Recibí los documentos. Dejé guardada tu hoja de vida; para el proceso solo necesito la hoja de vida.';
      candidateReplyResult = { text: candidateReply, model: null, fallbackUsed: true, reason: 'multiple_documents_selected' };
    }
  }

  if (!candidateReply) {
    candidateReplyResult = await buildAiSupervisorCandidateReply({
      candidateQuestion,
      adminInstruction: body,
      candidate,
      payload
    }).catch((error) => {
      console.warn('[ADMIN_SUPERVISOR_AI_REPLY_ERROR]', error?.message || error);
      return { text: normalizeCandidateInstruction(body), model: SUPERVISOR_REPLY_MODEL, fallbackUsed: true, reason: 'ai_error' };
    });
    candidateReply = candidateReplyResult.text;
  }

  await sendTextMessage(candidate.phone, candidateReply);
  await prisma.message.create({
    data: {
      candidateId: candidate.id,
      direction: MessageDirection.OUTBOUND,
      messageType: MessageType.TEXT,
      body: candidateReply,
      rawPayload: {
        source: 'admin_supervisor_answer',
        supervisorPhone,
        originalSupervisorInstruction: body,
        aiModel: candidateReplyResult?.model || null,
        aiFallbackUsed: Boolean(candidateReplyResult?.fallbackUsed),
        aiReason: candidateReplyResult?.reason || null,
        requestMessageId: request.id
      }
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
  await prisma.message.update({ where: { id: request.id }, data: { rawPayload: { ...payload, resolved: true, resolvedAt: new Date().toISOString() } } });
  await addSupervisorKnowledge(
    prisma,
    candidate,
    buildKnowledgeContent({ candidateQuestion, adminInstruction: body, candidateReply }),
    `admin_whatsapp,manual_review${payload.manualReviewType ? `,type:${payload.manualReviewType}` : ''}`
  );
  return { handled: true, action: 'answered_candidate', candidateId: candidate.id };
}
