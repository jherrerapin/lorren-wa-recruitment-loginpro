import { MessageDirection, MessageType } from '@prisma/client';
import {
  persistOutboundConversationMessage,
  updateOutboundConversationDelivery
} from './conversationMessageRepository.js';
import {
  ReplySimilarityThreshold,
  isSubstantiallySimilarReply,
  normalizeReplySignature
} from './replySimilarityPolicy.js';

const SERIALIZABLE_ISOLATION_LEVEL = 'Serializable';
const MAX_SERIALIZABLE_RETRIES = 3;
const STRONG_SCOPE_WINDOW_MS = 15 * 60 * 1000;
const WEAK_SCOPE_WINDOW_MS = 30 * 1000;

function requireNonEmptyString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label}_required`);
  return normalized;
}

function requirePrisma(prisma) {
  if (
    !prisma
    || typeof prisma.$transaction !== 'function'
    || typeof prisma?.message?.findMany !== 'function'
    || typeof prisma?.message?.create !== 'function'
    || typeof prisma?.message?.findUnique !== 'function'
    || typeof prisma?.message?.update !== 'function'
    || typeof prisma?.candidate?.update !== 'function'
  ) {
    throw new Error('automatic_outbound_prisma_contract_invalid');
  }
  return prisma;
}

function requireSendText(sendText) {
  if (typeof sendText !== 'function') throw new Error('automatic_outbound_send_text_required');
  return sendText;
}

function normalizeRawPayload(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeNow(now) {
  if (typeof now !== 'function') throw new Error('automatic_outbound_clock_required');
  return () => {
    const value = now();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error('automatic_outbound_clock_invalid');
    return date;
  };
}

function normalizeOptionalHook(hook, label) {
  if (hook == null) return null;
  if (typeof hook !== 'function') throw new Error(`${label}_invalid`);
  return hook;
}

function isRetryableTransactionConflict(error) {
  return error?.code === 'P2034';
}

function providerMessageId(response) {
  const value = response?.messages?.[0]?.id;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function providerFailureState(error) {
  const status = Number(error?.response?.status);
  return Number.isInteger(status) && status >= 400 && status < 500 ? 'FAILED' : 'UNKNOWN';
}

function providerErrorSummary(error) {
  return String(error?.message || error || 'automatic_outbound_provider_error').slice(0, 400);
}

function normalizeScopePart(value) {
  return String(value ?? '').trim().toLowerCase();
}

function readActionTypes(payload = {}) {
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  return actions.map((action) => normalizeScopePart(action?.type)).filter(Boolean).sort();
}

function buildDeliveryScope(payload = {}) {
  const raw = normalizeRawPayload(payload);
  const source = normalizeScopePart(raw.source || 'bot_flow');
  const situation = normalizeScopePart(raw.situation);
  const responsePurpose = normalizeScopePart(raw.responsePurpose || raw.detectedIntent);
  const decision = typeof raw.decision === 'string'
    ? normalizeScopePart(raw.decision)
    : normalizeScopePart(raw.decision?.action || raw.decision?.type);
  const actions = readActionTypes(raw).join(',');
  const strong = Boolean(situation || responsePurpose || decision || actions);
  return {
    key: [source, situation, responsePurpose, decision, actions].join('|'),
    strong
  };
}

function deliveryState(message = {}) {
  return normalizeScopePart(message?.rawPayload?.delivery?.state).toUpperCase();
}

function canBlockDuplicate(message = {}) {
  const state = deliveryState(message);
  if (!state) return true; // outbound histórico previo al contrato de delivery
  return state === 'SENDING' || state === 'SENT';
}

function sameLogicalScope(nextPayload = {}, previousPayload = {}) {
  return buildDeliveryScope(nextPayload).key === buildDeliveryScope(previousPayload).key;
}

function isDuplicateReply(body, rawPayload, message) {
  if (!message?.body || !canBlockDuplicate(message)) return false;
  if (!sameLogicalScope(rawPayload, message.rawPayload || {})) return false;
  return isSubstantiallySimilarReply(body, message.body, {
    threshold: ReplySimilarityThreshold.CONTEXTUAL_REPLY
  });
}

async function claimInsideTransaction(tx, input) {
  const scope = buildDeliveryScope(input.rawPayload);
  const dedupeWindowMs = scope.strong ? STRONG_SCOPE_WINDOW_MS : WEAK_SCOPE_WINDOW_MS;
  const createdSince = new Date(input.startedAt.getTime() - dedupeWindowMs);
  const recent = await tx.message.findMany({
    where: {
      candidateId: input.candidateId,
      direction: MessageDirection.OUTBOUND,
      messageType: MessageType.TEXT,
      createdAt: { gte: createdSince }
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true,
      body: true,
      rawPayload: true,
      createdAt: true
    }
  });

  const duplicate = recent.find((message) => isDuplicateReply(input.body, input.rawPayload, message));
  if (duplicate) {
    return {
      claimed: false,
      suppressed: true,
      duplicateMessageId: duplicate.id,
      scope: scope.key
    };
  }

  const deliveryKey = normalizeReplySignature([
    input.candidateId,
    scope.key,
    input.body
  ].join(' '));
  const rawPayload = {
    ...input.rawPayload,
    delivery: {
      state: 'SENDING',
      provider: 'META_WHATSAPP',
      startedAt: input.startedAt.toISOString(),
      updatedAt: input.startedAt.toISOString(),
      dedupeKey: deliveryKey,
      scope: scope.key,
      retryPolicy: 'MANUAL_REVIEW_ONLY'
    }
  };
  const persisted = await persistOutboundConversationMessage(tx, {
    candidateId: input.candidateId,
    messageType: MessageType.TEXT,
    body: input.body,
    rawPayload
  });

  return {
    claimed: true,
    suppressed: false,
    messageId: persisted.message.id,
    scope: scope.key
  };
}

async function claimAutomaticOutbound(prisma, input) {
  for (let attempt = 1; attempt <= MAX_SERIALIZABLE_RETRIES; attempt += 1) {
    try {
      return await prisma.$transaction(
        (tx) => claimInsideTransaction(tx, input),
        { isolationLevel: SERIALIZABLE_ISOLATION_LEVEL }
      );
    } catch (error) {
      if (!isRetryableTransactionConflict(error) || attempt === MAX_SERIALIZABLE_RETRIES) throw error;
    }
  }
  throw new Error('automatic_outbound_claim_exhausted');
}

async function markDeliveryFailure(prisma, messageId, error, occurredAt) {
  const state = providerFailureState(error);
  try {
    await updateOutboundConversationDelivery(prisma, {
      messageId,
      state,
      occurredAt,
      lastError: providerErrorSummary(error)
    });
  } catch (persistenceError) {
    console.error('[AUTOMATIC_OUTBOUND_FAILURE_PERSISTENCE]', JSON.stringify({
      messageId,
      state,
      error: String(persistenceError?.message || persistenceError).slice(0, 200)
    }));
  }
  return state;
}

export async function deliverAutomaticOutboundText(prismaInput, input = {}, dependencies = {}) {
  const prisma = requirePrisma(prismaInput);
  const sendText = requireSendText(dependencies.sendText);
  const now = normalizeNow(dependencies.now || (() => new Date()));
  const beforeSend = normalizeOptionalHook(dependencies.beforeSend, 'automatic_outbound_before_send');
  const candidateId = requireNonEmptyString(input.candidateId, 'automatic_outbound_candidate_id');
  const to = requireNonEmptyString(input.to, 'automatic_outbound_to');
  const body = requireNonEmptyString(input.body, 'automatic_outbound_body');
  const rawPayload = normalizeRawPayload(input.rawPayload);
  const startedAt = now();

  const claim = await claimAutomaticOutbound(prisma, {
    candidateId,
    body,
    rawPayload,
    startedAt
  });
  if (!claim.claimed) {
    return {
      sent: false,
      suppressed: true,
      reason: 'duplicate_recent_automatic_reply',
      duplicateMessageId: claim.duplicateMessageId || null,
      scope: claim.scope
    };
  }

  try {
    if (beforeSend) await beforeSend();
  } catch (error) {
    await markDeliveryFailure(prisma, claim.messageId, error, now());
    throw error;
  }

  let response;
  try {
    response = await sendText(to, body);
  } catch (error) {
    const state = await markDeliveryFailure(prisma, claim.messageId, error, now());
    error.automaticOutboundDeliveryState = state;
    throw error;
  }

  const sentAt = now();
  const waMessageId = providerMessageId(response);
  try {
    await prisma.$transaction(async (tx) => {
      await updateOutboundConversationDelivery(tx, {
        messageId: claim.messageId,
        state: 'SENT',
        occurredAt: sentAt,
        providerMessageId: waMessageId
      });
      await tx.candidate.update({
        where: { id: candidateId },
        data: { lastOutboundAt: sentAt }
      });
    });
  } catch (error) {
    error.automaticOutboundSentPendingReconciliation = true;
    error.automaticOutboundMessageId = claim.messageId;
    throw error;
  }

  return {
    sent: true,
    suppressed: false,
    messageId: claim.messageId,
    providerMessageId: waMessageId,
    scope: claim.scope
  };
}

export const __automaticOutboundDeliveryInternals = {
  buildDeliveryScope,
  isDuplicateReply,
  isRetryableTransactionConflict,
  STRONG_SCOPE_WINDOW_MS,
  WEAK_SCOPE_WINDOW_MS
};
