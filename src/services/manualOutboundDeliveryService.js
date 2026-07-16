import { createHash } from 'node:crypto';
import { MessageType } from '@prisma/client';
import { safeErrorMessage } from './errorSanitization.js';
import {
  claimManualOutboundDelivery,
  finalizeManualOutboundDelivery,
  MANUAL_OUTBOUND_SENDING_MODE,
  MANUAL_OUTBOUND_UNKNOWN_MODE,
  markManualOutboundDeliveryUnknown,
  restoreManualOutboundDelivery
} from './candidateStateService.js';
import {
  findRecentOutboundConversationDelivery,
  persistOutboundConversationMessage,
  updateOutboundConversationDelivery
} from './conversationMessageRepository.js';

const DEFAULT_DEDUPE_WINDOW_MS = 30_000;
const PENDING_RECONCILIATION_MESSAGE = 'WhatsApp confirmó el envío, pero la actualización interna quedó pendiente. No reenvíes el mensaje; revisa la conversación y el estado del candidato.';

function requireNonEmptyString(value, label, { preserve = false } = {}) {
  const raw = String(value ?? '');
  if (!raw.trim()) throw new TypeError(`${label}_required`);
  return preserve ? raw : raw.trim();
}

function requirePrismaRoot(prisma) {
  if (
    !prisma
    || typeof prisma.$transaction !== 'function'
    || typeof prisma?.candidate?.findUnique !== 'function'
    || typeof prisma?.message?.findMany !== 'function'
  ) {
    throw new TypeError('manual_outbound_prisma_root_required');
  }
  return prisma;
}

function requireSendText(sendText) {
  if (typeof sendText !== 'function') {
    throw new TypeError('manual_outbound_send_text_required');
  }
  return sendText;
}

function requireNow(now) {
  if (typeof now !== 'function') throw new TypeError('manual_outbound_clock_required');
  return () => {
    const value = now();
    if (value === null || typeof value === 'boolean') {
      throw new TypeError('manual_outbound_clock_invalid');
    }
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError('manual_outbound_clock_invalid');
    return date;
  };
}

function normalizeRawPayload(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('manual_outbound_raw_payload_invalid');
  }
  return value;
}

function normalizeNullableDate(value) {
  if (value == null) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('manual_outbound_candidate_snapshot_invalid');
  return date;
}

function candidateSnapshot(candidate = {}) {
  if (typeof candidate.botPaused !== 'boolean' || !candidate.reminderState) {
    throw new TypeError('manual_outbound_candidate_snapshot_invalid');
  }
  return {
    botPaused: candidate.botPaused,
    botPausedAt: normalizeNullableDate(candidate.botPausedAt),
    botPausedBy: candidate.botPausedBy ?? null,
    botPauseReason: candidate.botPauseReason ?? null,
    botResumeMode: candidate.botResumeMode ?? null,
    reminderScheduledFor: normalizeNullableDate(candidate.reminderScheduledFor),
    reminderState: String(candidate.reminderState),
    lastOutboundAt: normalizeNullableDate(candidate.lastOutboundAt)
  };
}

function buildDedupeKey({ candidateId, body, source, action }) {
  return createHash('sha256')
    .update([candidateId, source || '', action || '', body].join('\u0000'))
    .digest('hex');
}

function extractProviderMessageId(response) {
  const value = response?.messages?.[0]?.id;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function providerErrorSummary(error) {
  const status = Number(error?.response?.status);
  const code = String(error?.code || '').trim();
  const message = safeErrorMessage({
    message: String(error?.message || 'unknown_provider_error').trim()
  }).split('\n')[0].trim();
  return [Number.isInteger(status) ? `http_${status}` : null, code || null, message || null]
    .filter(Boolean)
    .join(':')
    .slice(0, 400);
}

function isConfirmedProviderRejection(error) {
  const status = Number(error?.response?.status);
  return Number.isInteger(status) && status >= 400 && status < 500;
}

function manualOutboundError(code, userMessage, cause = null) {
  const error = new Error(code);
  error.code = code;
  error.userMessage = userMessage;
  if (cause) error.cause = cause;
  return error;
}

function duplicateRecentError() {
  return manualOutboundError(
    'manual_outbound_duplicate_recent',
    'Ya existe un envío idéntico reciente para este candidato. No se volvió a enviar.'
  );
}

function sentPendingReconciliationError({ providerMessageId, messageId, cause = null }) {
  const error = manualOutboundError(
    'manual_outbound_sent_pending_reconciliation',
    PENDING_RECONCILIATION_MESSAGE,
    cause
  );
  error.sent = true;
  error.deliveryState = 'SENDING';
  error.providerMessageId = providerMessageId || null;
  error.messageId = messageId;
  error.candidateStateCount = 0;
  error.persistencePending = true;
  return error;
}

async function loadCandidateForManualOutbound(client, candidateId) {
  return client.candidate.findUnique({
    where: { id: candidateId },
    select: {
      id: true,
      botPaused: true,
      botPausedAt: true,
      botPausedBy: true,
      botPauseReason: true,
      botResumeMode: true,
      reminderScheduledFor: true,
      reminderState: true,
      lastOutboundAt: true
    }
  });
}

async function persistProviderFailure(prisma, {
  candidateId,
  messageId,
  previous,
  claimed,
  error,
  occurredAt,
  confirmedRejection
}) {
  const lastError = providerErrorSummary(error);
  try {
    return await prisma.$transaction(async (tx) => {
      const candidateResult = confirmedRejection
        ? await restoreManualOutboundDelivery(tx, {
          candidateId,
          expected: claimed,
          previous
        })
        : await markManualOutboundDeliveryUnknown(tx, {
          candidateId,
          expected: claimed
        });

      await updateOutboundConversationDelivery(tx, {
        messageId,
        state: confirmedRejection ? 'FAILED' : 'UNKNOWN',
        occurredAt,
        lastError,
        candidateStateCount: candidateResult.count
      });

      return candidateResult;
    });
  } catch (persistenceError) {
    console.error('[manual_outbound_failure_persistence]', {
      candidateId,
      messageId,
      confirmedRejection,
      error: safeErrorMessage(persistenceError)
    });
    return null;
  }
}

export function getManualOutboundUserMessage(error, fallback = 'No fue posible enviar el mensaje.') {
  return typeof error?.userMessage === 'string' && error.userMessage.trim()
    ? error.userMessage
    : fallback;
}

export async function deliverManualOutboundText(prismaInput, input = {}, dependencies = {}) {
  const prisma = requirePrismaRoot(prismaInput);
  const sendText = requireSendText(dependencies.sendText);
  const now = requireNow(dependencies.now || (() => new Date()));
  const candidateId = requireNonEmptyString(input.candidateId, 'manual_outbound_candidate_id');
  const phone = requireNonEmptyString(input.phone, 'manual_outbound_phone');
  const body = requireNonEmptyString(input.body, 'manual_outbound_body', { preserve: true });
  const actor = requireNonEmptyString(input.actor || 'dashboard', 'manual_outbound_actor');
  const reason = requireNonEmptyString(
    input.reason || 'Conversacion tomada manualmente desde dashboard',
    'manual_outbound_reason'
  );
  const rawPayload = normalizeRawPayload(input.rawPayload);
  const source = String(rawPayload.source || 'admin_outbound');
  const action = String(rawPayload.action || 'manual_text');
  const dedupeKey = buildDedupeKey({ candidateId, body, source, action });
  const dedupeWindowMs = Number.isFinite(dependencies.dedupeWindowMs)
    ? Math.max(1, Number(dependencies.dedupeWindowMs))
    : DEFAULT_DEDUPE_WINDOW_MS;
  const startedAt = now();
  const duplicateQuery = {
    candidateId,
    body,
    dedupeKey,
    createdSince: new Date(startedAt.getTime() - dedupeWindowMs)
  };

  const duplicate = await findRecentOutboundConversationDelivery(prisma, duplicateQuery);
  if (duplicate.found) throw duplicateRecentError();

  let preparation;
  try {
    preparation = await prisma.$transaction(async (tx) => {
      const currentCandidate = await loadCandidateForManualOutbound(tx, candidateId);
      if (!currentCandidate) {
        throw manualOutboundError('manual_outbound_candidate_not_found', 'Candidato no encontrado.');
      }

      const previous = candidateSnapshot(currentCandidate);
      const claim = await claimManualOutboundDelivery(tx, {
        candidateId,
        expected: previous,
        actor,
        reason,
        now: startedAt
      });

      if (claim.count !== 1) {
        const blockedMode = claim.blockedReason || claim.candidate?.botResumeMode;
        const userMessage = [MANUAL_OUTBOUND_SENDING_MODE, MANUAL_OUTBOUND_UNKNOWN_MODE].includes(blockedMode)
          ? 'Ya existe una entrega manual en curso o pendiente de revisión para este candidato.'
          : 'El estado del candidato cambió antes del envío. Actualiza la página e intenta de nuevo.';
        throw manualOutboundError('manual_outbound_candidate_conflict', userMessage);
      }

      const duplicateAfterClaim = await findRecentOutboundConversationDelivery(tx, duplicateQuery);
      if (duplicateAfterClaim.found) throw duplicateRecentError();

      const claimed = candidateSnapshot(claim.candidate);
      const intentPayload = {
        ...rawPayload,
        delivery: {
          state: 'SENDING',
          provider: 'META_WHATSAPP',
          startedAt: startedAt.toISOString(),
          updatedAt: startedAt.toISOString(),
          dedupeKey,
          retryPolicy: 'MANUAL_REVIEW_ONLY'
        }
      };
      const intent = await persistOutboundConversationMessage(tx, {
        candidateId,
        messageType: MessageType.TEXT,
        body,
        rawPayload: intentPayload
      });

      return {
        previous,
        claimed,
        messageId: intent.message.id
      };
    });
  } catch (error) {
    if (error?.userMessage) throw error;
    throw manualOutboundError(
      'manual_outbound_preparation_failed',
      'No fue posible preparar el envío. No se envió ningún mensaje.',
      error
    );
  }

  let providerResponse;
  try {
    providerResponse = await sendText(phone, body);
  } catch (error) {
    const confirmedRejection = isConfirmedProviderRejection(error);
    const occurredAt = now();
    const failurePersistence = await persistProviderFailure(prisma, {
      candidateId,
      messageId: preparation.messageId,
      previous: preparation.previous,
      claimed: preparation.claimed,
      error,
      occurredAt,
      confirmedRejection
    });

    if (!failurePersistence) {
      throw manualOutboundError(
        confirmedRejection
          ? 'manual_outbound_provider_rejected_unreconciled'
          : 'manual_outbound_provider_unknown_unreconciled',
        confirmedRejection
          ? 'WhatsApp rechazó el mensaje, pero no se pudo actualizar el estado interno. Revisa la conversación antes de continuar.'
          : 'No se pudo confirmar si WhatsApp recibió el mensaje ni actualizar el estado interno. No lo reintentes hasta revisar la conversación.',
        error
      );
    }

    const candidateReconciled = failurePersistence.count === 1;
    throw manualOutboundError(
      confirmedRejection ? 'manual_outbound_provider_rejected' : 'manual_outbound_provider_unknown',
      confirmedRejection
        ? (candidateReconciled
          ? 'WhatsApp rechazó el mensaje y el candidato fue restaurado al estado anterior.'
          : 'WhatsApp rechazó el mensaje, pero el estado del candidato cambió durante la operación. Revisa la conversación antes de continuar.')
        : (candidateReconciled
          ? 'No se pudo confirmar si WhatsApp recibió el mensaje. No lo reintentes hasta revisar la conversación.'
          : 'No se pudo confirmar si WhatsApp recibió el mensaje y el estado del candidato cambió durante la operación. No lo reintentes hasta revisar la conversación.'),
      error
    );
  }

  const sentAt = now();
  const providerMessageId = extractProviderMessageId(providerResponse);
  let finalization;
  try {
    finalization = await prisma.$transaction(async (tx) => {
      const candidateResult = await finalizeManualOutboundDelivery(tx, {
        candidateId,
        expected: preparation.claimed,
        sentAt
      });

      await updateOutboundConversationDelivery(tx, {
        messageId: preparation.messageId,
        state: 'SENT',
        occurredAt: sentAt,
        providerMessageId,
        candidateStateCount: candidateResult.count
      });

      return candidateResult;
    });
  } catch (error) {
    console.error('[manual_outbound_post_send_persistence]', {
      candidateId,
      messageId: preparation.messageId,
      providerMessageId,
      error: safeErrorMessage(error)
    });
    throw sentPendingReconciliationError({
      providerMessageId,
      messageId: preparation.messageId,
      cause: error
    });
  }

  if (finalization.count !== 1) {
    throw sentPendingReconciliationError({
      providerMessageId,
      messageId: preparation.messageId
    });
  }

  return {
    sent: true,
    deliveryState: 'SENT',
    providerMessageId,
    messageId: preparation.messageId,
    candidateStateCount: finalization.count,
    persistencePending: false
  };
}
