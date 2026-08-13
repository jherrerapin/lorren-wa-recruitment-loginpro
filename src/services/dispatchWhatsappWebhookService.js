import axios from 'axios';
import { prisma } from '../lib/prisma.js';
import { sendDispatchCompletionEmail } from './dispatchCompletionEmail.js';
import { recalculateDispatchServiceRequestStatus } from './dispatchOperationalCoverage.js';
import {
  AUTOMATIC_CONFIRMATION_REPLY,
  DELIVERY_RANK,
  INBOUND_LINK_STATUSES,
  TERMINAL_LINK_STATUSES,
  dispatchWhatsappScopeDefinition,
  normalizeDispatchWhatsappPhone,
  resolveDispatchWhatsappScopeByPhoneNumberId,
  setDispatchWhatsappRuntimeState
} from './dispatchWhatsappCloudConfig.js';
import { claimDispatchAssignmentConfirmation, claimDispatchAssignmentNovelty } from './dispatchWhatsappAssignmentService.js';
import { dispatchWhatsappProviderErrorMessage, sendDispatchWhatsappTextMessage } from './dispatchWhatsappCloudClient.js';
import {
  recordDispatchWhatsappInboundWindow,
  sendDispatchNoveltyAdminAlert
} from './dispatchWhatsappAdminAlerts.js';
import { recordDispatchWhatsappMessageAudit } from './dispatchWhatsappMonitor.js';

function normalizeConfirmationText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function isAutomaticConfirmationReply(value) {
  const text = normalizeConfirmationText(value);
  return ['confirmado', 'confirmada', 'confirmo', 'si confirmado', 'si confirmo', 'si', 'ok', 'okay', 'listo', 'recibido', 'enterado'].includes(text)
    || /^confirmad[oa]\b/.test(text)
    || /^confirmo\b/.test(text)
    || /^si\b.*\b(confirmad[oa]|confirmo|asisto|voy|listo|recibido)\b/.test(text);
}

function inboundText(message = {}) {
  return [
    message.text?.body,
    message.button?.text,
    message.button?.payload,
    message.interactive?.button_reply?.title,
    message.interactive?.button_reply?.id,
    message.interactive?.list_reply?.title,
    message.interactive?.list_reply?.id
  ].find((value) => typeof value === 'string' && value.trim()) || '';
}

function inboundPayload(message = {}) {
  return [message.button?.payload, message.interactive?.button_reply?.id, message.interactive?.list_reply?.id]
    .find((value) => typeof value === 'string' && value.trim()) || '';
}

function assignmentActionFromInboundPayload(message = {}) {
  const match = inboundPayload(message).trim().match(/^dispatch_(confirm|novelty|decline):([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  return {
    action: match[1] === 'confirm' ? 'CONFIRM' : 'NOVELTY',
    assignmentId: match[2]
  };
}

function assignmentIdFromInboundPayload(message = {}) {
  return assignmentActionFromInboundPayload(message)?.assignmentId || null;
}

function isAutomaticNoveltyReply(value) {
  const text = normalizeConfirmationText(value);
  return ['reportar novedad', 'novedad', 'tengo una novedad', 'reporto novedad'].includes(text)
    || /\breport(?:ar|o)\b.*\bnovedad\b/.test(text);
}

function inboundReceivedAt(message = {}) {
  const timestamp = Number(message.timestamp || 0);
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000) : new Date();
}

function inboundAuditBody(message = {}) {
  const visibleText = inboundText(message);
  if (visibleText) return visibleText;
  const type = String(message.type || 'mensaje').trim().toUpperCase();
  return `[${type || 'MENSAJE'}]`;
}

async function findConfirmationTarget({ scope, message, prismaClient }) {
  const definition = dispatchWhatsappScopeDefinition(scope);
  const phone = normalizeDispatchWhatsappPhone(message.from);
  if (!phone) return null;
  const where = {
    phone,
    status: { in: INBOUND_LINK_STATUSES },
    expiresAt: { gt: new Date() }
  };
  const assignmentId = assignmentIdFromInboundPayload(message);
  if (assignmentId) where.assignmentId = assignmentId;

  const link = await prismaClient.dispatchWhatsappConfirmation.findFirst({
    where,
    orderBy: { createdAt: 'desc' },
    include: { assignment: { include: { worker: true, serviceRequest: true } } }
  });
  if (!link?.assignment) return null;
  const allowed = [...definition.pendingAssignmentStatuses, definition.confirmedAssignmentStatus];
  if (!allowed.includes(link.assignment.status)) return null;
  if (definition.requestSource && link.assignment.serviceRequest?.source !== definition.requestSource) return null;
  if (scope === 'operational' && link.assignment.serviceRequest?.source === 'DEV_TEST') return null;
  if (normalizeDispatchWhatsappPhone(link.assignment.worker?.phone) !== phone) return null;
  return { link, assignment: link.assignment, phone };
}

export async function processDispatchWhatsappInboundMessage({
  scope = 'operational', message = {}, prismaClient = prisma, axiosClient = axios
} = {}) {
  const receivedAt = inboundReceivedAt(message);
  await recordDispatchWhatsappInboundWindow({ scope, message, prismaClient });
  await recordDispatchWhatsappMessageAudit({
    prismaClient,
    scope,
    direction: 'INBOUND',
    phone: message.from,
    body: inboundAuditBody(message),
    messageType: message.type || 'UNKNOWN',
    messageId: message.id,
    source: 'WEBHOOK_INBOUND',
    occurredAt: receivedAt
  });

  const buttonAction = assignmentActionFromInboundPayload(message);
  const inbound = inboundText(message);
  const inferredAction = buttonAction?.action
    || (isAutomaticNoveltyReply(inbound) ? 'NOVELTY' : isAutomaticConfirmationReply(inbound) ? 'CONFIRM' : null);
  if (!inferredAction) return { handled: false, reason: 'not_assignment_response' };
  const target = await findConfirmationTarget({ scope, message, prismaClient });
  if (!target) return { handled: false, reason: 'no_pending_assignment' };
  const confirmationMessageId = String(message.id || '').trim();
  if (!confirmationMessageId) return { handled: false, reason: 'missing_message_id' };

  if (inferredAction === 'NOVELTY') {
    const novelty = await claimDispatchAssignmentNovelty({
      scope,
      assignment: target.assignment,
      responseMessageId: confirmationMessageId,
      responseReceivedAt: receivedAt,
      prismaClient
    });
    let adminAlertSent = false;
    if (novelty.noveltyReported) {
      const adminAlert = await sendDispatchNoveltyAdminAlert({
        scope, link: target.link, assignment: target.assignment, prismaClient, axiosClient
      }).catch((error) => ({ sent: false, error }));
      adminAlertSent = Boolean(adminAlert?.sent);
    }
    setDispatchWhatsappRuntimeState(scope, { lastInboundAt: new Date().toISOString(), lastError: null });
    console.info(`[dispatch-wa-cloud] Novedad de auxiliar procesada. scope=${scope} assignment=${target.assignment.id} reported=${novelty.noveltyReported ? 'yes' : 'no'} adminAlert=${adminAlertSent ? 'sent' : 'not-sent'}.`);
    return {
      handled: novelty.noveltyReported || novelty.duplicate,
      duplicate: novelty.duplicate,
      noveltyReported: novelty.noveltyReported,
      adminAlertSent,
      replySent: false
    };
  }

  const claim = await claimDispatchAssignmentConfirmation({
    scope,
    assignment: target.assignment,
    confirmationMessageId,
    confirmationReceivedAt: receivedAt,
    prismaClient
  });
  if (!claim.shouldReply) {
    return { handled: claim.duplicate, duplicate: claim.duplicate, assignmentConfirmed: claim.assignmentConfirmed, replySent: false };
  }
  if (claim.assignmentConfirmed && scope === 'operational') {
    const statusResult = await recalculateDispatchServiceRequestStatus(prismaClient, target.assignment.serviceRequestId);
    if (statusResult?.status === 'ASSIGNMENT_COMPLETE') {
      const completionEmail = await sendDispatchCompletionEmail(prismaClient, target.assignment.serviceRequestId);
      if (completionEmail?.error) {
        console.warn(`[dispatch-wa-cloud] Asignación completa, pero falló el correo de cierre. assignment=${target.assignment.id}.`);
      }
    }
  }

  let replySent = false;
  try {
    const replyProviderMessageId = await sendDispatchWhatsappTextMessage({ scope, phone: target.phone, text: AUTOMATIC_CONFIRMATION_REPLY, axiosClient });
    replySent = true;
    await recordDispatchWhatsappMessageAudit({
      prismaClient,
      scope,
      direction: 'OUTBOUND',
      phone: target.phone,
      body: AUTOMATIC_CONFIRMATION_REPLY,
      messageType: 'TEXT',
      providerMessageId: replyProviderMessageId,
      dedupeKey: `auto-reply:${confirmationMessageId}`,
      source: 'AUTO_CONFIRMATION_REPLY',
      occurredAt: new Date()
    });
    await prismaClient.dispatchWhatsappConfirmation.updateMany({
      where: { assignmentId: target.assignment.id, confirmationMessageId, status: 'CONFIRMED_REPLY_PENDING' },
      data: { status: 'CONFIRMED' }
    });
  } catch (error) {
    setDispatchWhatsappRuntimeState(scope, { lastError: dispatchWhatsappProviderErrorMessage(error) });
    console.warn(`[dispatch-wa-cloud] Confirmación registrada, pero no fue posible responder Gracias. scope=${scope} assignment=${target.assignment.id}.`);
  }
  setDispatchWhatsappRuntimeState(scope, {
    lastInboundAt: new Date().toISOString(),
    ...(replySent ? { lastError: null } : {})
  });
  console.info(`[dispatch-wa-cloud] Confirmación inbound procesada. scope=${scope} assignment=${target.assignment.id} changed=${claim.assignmentConfirmed ? 'yes' : 'no'} reply=${replySent ? 'sent' : 'pending'}.`);
  return { handled: true, duplicate: false, assignmentConfirmed: claim.assignmentConfirmed, replySent };
}

function normalizedProviderStatus(value) {
  const status = String(value || '').trim().toUpperCase();
  return ['SENT', 'DELIVERED', 'READ', 'FAILED'].includes(status) ? status : null;
}

export async function processDispatchWhatsappProviderStatus({
  scope = 'operational', status = {}, prismaClient = prisma
} = {}) {
  const providerMessageId = String(status.id || '').trim();
  const nextStatus = normalizedProviderStatus(status.status);
  if (!providerMessageId || !nextStatus) return { handled: false };
  const link = await prismaClient.dispatchWhatsappConfirmation.findFirst({
    where: { providerMessageId }, select: { id: true, status: true }
  });
  if (!link || TERMINAL_LINK_STATUSES.has(link.status) || link.status === 'CONFIRMED_REPLY_PENDING') {
    return { handled: false };
  }
  const currentRank = DELIVERY_RANK.get(link.status);
  const nextRank = DELIVERY_RANK.get(nextStatus);
  const shouldUpdate = nextStatus === 'FAILED'
    ? link.status !== 'READ'
    : nextRank !== undefined && (currentRank === undefined || nextRank >= currentRank);
  if (!shouldUpdate) return { handled: false };

  await prismaClient.dispatchWhatsappConfirmation.update({ where: { id: link.id }, data: { status: nextStatus } });
  setDispatchWhatsappRuntimeState(scope, {
    lastProviderStatus: nextStatus,
    lastProviderStatusAt: new Date().toISOString(),
    lastError: nextStatus === 'FAILED' ? 'Meta reportó un fallo de entrega en un mensaje de despacho.' : null
  });
  return { handled: true, status: nextStatus };
}

function webhookValues(payload = {}) {
  const values = [];
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field === 'messages' && change?.value) values.push(change.value);
    }
  }
  return values;
}

export async function processDispatchWhatsappWebhook(payload, { prismaClient = prisma, axiosClient = axios } = {}) {
  let messagesProcessed = 0;
  let statusesProcessed = 0;
  for (const value of webhookValues(payload)) {
    const scope = resolveDispatchWhatsappScopeByPhoneNumberId(value?.metadata?.phone_number_id);
    if (!scope) continue;
    for (const status of Array.isArray(value.statuses) ? value.statuses : []) {
      if ((await processDispatchWhatsappProviderStatus({ scope, status, prismaClient })).handled) statusesProcessed += 1;
    }
    for (const message of Array.isArray(value.messages) ? value.messages : []) {
      if ((await processDispatchWhatsappInboundMessage({ scope, message, prismaClient, axiosClient })).handled) messagesProcessed += 1;
    }
  }
  return { messagesProcessed, statusesProcessed };
}
