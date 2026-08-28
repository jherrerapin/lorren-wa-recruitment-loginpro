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
  resolveDispatchAttendanceFailureCoordinatorDecision,
  sendDispatchAllConfirmedAdminAlert,
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

function attendanceFailureDecisionFromInboundPayload(message = {}) {
  const match = inboundPayload(message).trim().match(
    /^dispatch_attendance_(accept|reject):(attendance_failure_[a-f0-9]{48})$/
  );
  if (!match) return null;
  return {
    decision: match[1] === 'accept' ? 'ACCEPT' : 'REJECT',
    failureEventId: match[2]
  };
}

function inboundContextMessageId(message = {}) {
  return String(message?.context?.id || '').trim();
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

function candidateMatchesScopeAndAssignment({ link, definition, scope, phone, receivedAt, allowSuperseded = false }) {
  if (!link?.assignment) return false;
  const allowedAssignmentStatuses = [...definition.pendingAssignmentStatuses, definition.confirmedAssignmentStatus];
  if (!allowedAssignmentStatuses.includes(link.assignment.status)) return false;
  if (definition.requestSource && link.assignment.serviceRequest?.source !== definition.requestSource) return false;
  if (scope === 'operational' && link.assignment.serviceRequest?.source === 'DEV_TEST') return false;
  if (normalizeDispatchWhatsappPhone(link.assignment.worker?.phone) !== phone) return false;

  const createdAt = new Date(link.createdAt || Number.NaN);
  if (Number.isNaN(createdAt.getTime()) || createdAt.getTime() > receivedAt.getTime()) return false;
  if (INBOUND_LINK_STATUSES.includes(link.status)) {
    const expiresAt = new Date(link.expiresAt || Number.NaN);
    return !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() > receivedAt.getTime();
  }
  return allowSuperseded && link.status === 'EXPIRED';
}

async function loadConfirmationCandidates(prismaClient, where) {
  return prismaClient.dispatchWhatsappConfirmation.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: { assignment: { include: { worker: true, serviceRequest: true } } }
  });
}

async function findFirstValidCandidate({ prismaClient, where, definition, scope, phone, receivedAt, allowSuperseded = false }) {
  const candidates = await loadConfirmationCandidates(prismaClient, where);
  const link = candidates.find((candidate) => candidateMatchesScopeAndAssignment({
    link: candidate,
    definition,
    scope,
    phone,
    receivedAt,
    allowSuperseded
  }));
  return link ? { link, assignment: link.assignment, phone } : null;
}

async function findConfirmationTarget({ scope, action, message, receivedAt, prismaClient }) {
  const definition = dispatchWhatsappScopeDefinition(scope);
  const phone = normalizeDispatchWhatsappPhone(message.from);
  if (!phone) return null;
  const assignmentId = assignmentIdFromInboundPayload(message);
  const contextMessageId = inboundContextMessageId(message);
  const allowSuperseded = action === 'CONFIRM';

  if (contextMessageId) {
    const exactContextTarget = await findFirstValidCandidate({
      prismaClient,
      where: { phone, providerMessageId: contextMessageId, createdAt: { lte: receivedAt } },
      definition,
      scope,
      phone,
      receivedAt,
      allowSuperseded
    });
    if (exactContextTarget) return exactContextTarget;
  }

  if (assignmentId) {
    return findFirstValidCandidate({
      prismaClient,
      where: { phone, assignmentId, createdAt: { lte: receivedAt } },
      definition,
      scope,
      phone,
      receivedAt,
      allowSuperseded
    });
  }

  return findFirstValidCandidate({
    prismaClient,
    where: {
      phone,
      status: { in: INBOUND_LINK_STATUSES },
      createdAt: { lte: receivedAt },
      expiresAt: { gt: receivedAt }
    },
    definition,
    scope,
    phone,
    receivedAt,
    allowSuperseded: false
  });
}

async function sendAttendanceDecisionReply({
  scope,
  message,
  result,
  prismaClient,
  axiosClient
}) {
  const phone = normalizeDispatchWhatsappPhone(message.from);
  if (!phone) return false;
  const text = result.duplicate
    ? (result.status === 'ACCEPTED'
        ? 'Esta marcación ya había sido aceptada y registrada.'
        : result.status === 'REJECTED'
          ? 'Este intento ya había sido rechazado.'
          : 'Esta decisión ya se está procesando.')
    : result.status === 'ACCEPTED'
      ? '✅ Marcación aceptada. Se registró con la hora original del intento.'
      : '❌ Intento rechazado. No se creó una marcación.';
  const providerMessageId = await sendDispatchWhatsappTextMessage({ scope, phone, text, axiosClient });
  await recordDispatchWhatsappMessageAudit({
    prismaClient,
    scope,
    direction: 'OUTBOUND',
    phone,
    body: text,
    messageType: 'TEXT',
    providerMessageId,
    dedupeKey: `attendance-decision:${String(message.id || '').trim()}`,
    source: 'ATTENDANCE_FAILURE_DECISION',
    occurredAt: new Date()
  });
  return true;
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

  const attendanceDecision = attendanceFailureDecisionFromInboundPayload(message);
  if (attendanceDecision) {
    let decisionResult;
    try {
      decisionResult = await resolveDispatchAttendanceFailureCoordinatorDecision({
        scope,
        failureEventId: attendanceDecision.failureEventId,
        decision: attendanceDecision.decision,
        coordinatorPhone: message.from,
        decidedAt: receivedAt,
        prismaClient
      });
    } catch (error) {
      console.warn('[dispatch-wa-cloud] Falló decisión de marcación por WhatsApp.', {
        code: String(error?.message || 'attendance_decision_failed').slice(0, 120)
      });
      const phone = normalizeDispatchWhatsappPhone(message.from);
      if (phone) {
        const text = 'No fue posible aplicar la decisión sobre esta marcación. Revísala en Asistencia operativa.';
        try {
          const providerMessageId = await sendDispatchWhatsappTextMessage({ scope, phone, text, axiosClient });
          await recordDispatchWhatsappMessageAudit({
            prismaClient,
            scope,
            direction: 'OUTBOUND',
            phone,
            body: text,
            messageType: 'TEXT',
            providerMessageId,
            dedupeKey: `attendance-decision-error:${String(message.id || '').trim()}`,
            source: 'ATTENDANCE_FAILURE_DECISION',
            occurredAt: new Date()
          });
        } catch (_replyError) {
          // La decisión fallida queda en auditoría; el aviso de error no debe duplicar la escritura.
        }
      }
      return { handled: true, attendanceDecision: false, reason: 'attendance_decision_failed' };
    }
    if (!decisionResult?.handled) {
      return { handled: false, reason: decisionResult?.reason || 'attendance_decision_not_handled' };
    }
    let replySent = false;
    try {
      replySent = await sendAttendanceDecisionReply({
        scope,
        message,
        result: decisionResult,
        prismaClient,
        axiosClient
      });
    } catch (error) {
      console.warn('[dispatch-wa-cloud] Decisión aplicada, pero falló confirmación al coordinador.', {
        code: String(error?.message || 'attendance_decision_reply_failed').slice(0, 120)
      });
    }
    setDispatchWhatsappRuntimeState(scope, {
      lastInboundAt: new Date().toISOString(),
      ...(replySent ? { lastError: null } : {})
    });
    return {
      handled: true,
      duplicate: Boolean(decisionResult.duplicate),
      attendanceDecision: true,
      decisionStatus: decisionResult.status,
      replySent
    };
  }

  const buttonAction = assignmentActionFromInboundPayload(message);
  const inbound = inboundText(message);
  const inferredAction = buttonAction?.action
    || (isAutomaticNoveltyReply(inbound) ? 'NOVELTY' : isAutomaticConfirmationReply(inbound) ? 'CONFIRM' : null);
  if (!inferredAction) return { handled: false, reason: 'not_assignment_response' };
  const target = await findConfirmationTarget({
    scope,
    action: inferredAction,
    message,
    receivedAt,
    prismaClient
  });
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
    confirmationLinkId: target.link.id,
    confirmationMessageId,
    confirmationReceivedAt: receivedAt,
    prismaClient
  });
  if (!claim.shouldReply) {
    return { handled: claim.duplicate, duplicate: claim.duplicate, assignmentConfirmed: claim.assignmentConfirmed, replySent: false };
  }
  let allConfirmedAlertSent = false;
  if (claim.assignmentConfirmed && scope === 'operational') {
    const statusResult = await recalculateDispatchServiceRequestStatus(prismaClient, target.assignment.serviceRequestId);
    const allConfirmedAlert = await sendDispatchAllConfirmedAdminAlert({
      scope, link: target.link, assignment: target.assignment, prismaClient, axiosClient, now: receivedAt
    }).catch((error) => ({ sent: false, error }));
    allConfirmedAlertSent = Boolean(allConfirmedAlert?.sent);
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
  console.info(`[dispatch-wa-cloud] Confirmación inbound procesada. scope=${scope} assignment=${target.assignment.id} changed=${claim.assignmentConfirmed ? 'yes' : 'no'} reply=${replySent ? 'sent' : 'pending'} allConfirmedAlert=${allConfirmedAlertSent ? 'sent' : 'not-sent'}.`);
  return { handled: true, duplicate: false, assignmentConfirmed: claim.assignmentConfirmed, replySent, allConfirmedAlertSent };
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