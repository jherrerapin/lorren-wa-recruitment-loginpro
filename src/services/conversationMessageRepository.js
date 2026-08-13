import { MessageDirection } from '@prisma/client';

const OUTBOUND_DELIVERY_STATES = new Set(['SENDING', 'SENT', 'FAILED', 'UNKNOWN']);

function requireNonEmptyString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label}_required`);
  return normalized;
}

function normalizeNullableString(value) {
  if (value === null || value === undefined) return null;
  return String(value);
}

function normalizeTimestamp(value, label) {
  if (value === null || typeof value === 'boolean') {
    throw new Error(`${label}_invalid`);
  }
  const timestamp = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error(`${label}_invalid`);
  return timestamp;
}

function requireJsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}_required`);
  }
  return value;
}

function normalizeExistingJsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function requireMessageIds(value) {
  if (!Array.isArray(value)) throw new Error('message_ids_required');
  const ids = [...new Set(value.map((id) => requireNonEmptyString(id, 'message_id')))];
  if (!ids.length) throw new Error('message_ids_required');
  return ids;
}

function requireOutboundDeliveryState(value) {
  const state = requireNonEmptyString(value, 'outbound_delivery_state').toUpperCase();
  if (!OUTBOUND_DELIVERY_STATES.has(state)) {
    throw new Error('outbound_delivery_state_invalid');
  }
  return state;
}

function validateInboundContract(prisma) {
  return Boolean(
    prisma
    && prisma.message
    && typeof prisma.message.createMany === 'function'
  );
}

function validateInboundReadContract(prisma) {
  return Boolean(
    prisma
    && prisma.message
    && typeof prisma.message.findFirst === 'function'
  );
}

function validateConversationContextReadContract(prisma) {
  return Boolean(
    prisma
    && prisma.message
    && typeof prisma.message.findMany === 'function'
  );
}

function validateOutboundContract(prisma) {
  return Boolean(
    prisma
    && prisma.message
    && typeof prisma.message.create === 'function'
  );
}

function validatePayloadUpdateContract(prisma) {
  return Boolean(
    prisma
    && prisma.message
    && typeof prisma.message.update === 'function'
  );
}

function validatePayloadMergeContract(prisma) {
  return Boolean(
    validatePayloadUpdateContract(prisma)
    && typeof prisma.message.findUnique === 'function'
  );
}

function validatePayloadCompareAndSwapContract(prisma) {
  return Boolean(
    prisma
    && prisma.message
    && typeof prisma.message.updateMany === 'function'
  );
}

function validateOutboundDeliveryReadContract(prisma) {
  return Boolean(
    prisma
    && prisma.message
    && typeof prisma.message.findMany === 'function'
  );
}

function validateRespondedContract(prisma) {
  return Boolean(
    prisma
    && prisma.message
    && typeof prisma.message.updateMany === 'function'
  );
}

function validateCandidateDeleteContract(prisma) {
  return Boolean(
    prisma
    && prisma.message
    && typeof prisma.message.deleteMany === 'function'
  );
}

function buildMessageData({
  candidateId,
  direction,
  messageType,
  waMessageId = null,
  body = null,
  rawPayload = null,
  respondedAt = null
}) {
  const data = {
    candidateId: requireNonEmptyString(candidateId, 'candidate_id'),
    direction,
    messageType: requireNonEmptyString(messageType, 'message_type'),
    body: normalizeNullableString(body),
    rawPayload
  };

  if (waMessageId !== null && waMessageId !== undefined) {
    data.waMessageId = requireNonEmptyString(waMessageId, 'wa_message_id');
  }
  if (respondedAt !== null && respondedAt !== undefined) {
    data.respondedAt = normalizeTimestamp(respondedAt, 'responded_at');
  }

  return data;
}

export async function persistInboundConversationMessage(prisma, input = {}) {
  if (!validateInboundContract(prisma)) {
    throw new Error('inbound_message_prisma_contract_invalid');
  }

  const data = buildMessageData({
    ...input,
    direction: MessageDirection.INBOUND
  });
  const result = await prisma.message.createMany({
    data: [data],
    skipDuplicates: true
  });

  return {
    created: result.count > 0,
    count: result.count,
    data
  };
}

export async function findInboundConversationMessage(prisma, input = {}) {
  if (!validateInboundReadContract(prisma)) {
    throw new Error('inbound_message_read_prisma_contract_invalid');
  }

  const candidateId = requireNonEmptyString(input.candidateId, 'candidate_id');
  const waMessageId = requireNonEmptyString(input.waMessageId, 'wa_message_id');
  const message = await prisma.message.findFirst({
    where: {
      candidateId,
      direction: MessageDirection.INBOUND,
      waMessageId
    },
    select: {
      id: true,
      waMessageId: true,
      messageType: true,
      body: true,
      rawPayload: true,
      respondedAt: true,
      createdAt: true
    }
  });

  return { found: Boolean(message), message };
}

export async function loadConversationInterpretationContext(prisma, input = {}) {
  if (!validateConversationContextReadContract(prisma)) {
    throw new Error('conversation_context_read_prisma_contract_invalid');
  }

  const candidateId = requireNonEmptyString(input.candidateId, 'candidate_id');
  const requestedLimit = input.limit === undefined ? 12 : Number(input.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 24) {
    throw new Error('conversation_context_limit_invalid');
  }

  const rows = await prisma.message.findMany({
    where: {
      candidateId,
      OR: [
        { direction: MessageDirection.OUTBOUND },
        {
          direction: MessageDirection.INBOUND,
          respondedAt: { not: null }
        }
      ]
    },
    orderBy: { createdAt: 'desc' },
    take: requestedLimit,
    select: {
      direction: true,
      body: true,
      createdAt: true
    }
  });

  const latestOutbound = rows.find((row) => (
    row?.direction === MessageDirection.OUTBOUND
    && String(row?.body ?? '').trim()
  )) || null;

  const recentConversation = [...rows]
    .reverse()
    .map((row) => ({
      direction: row.direction,
      body: String(row.body ?? '')
    }));

  return {
    lastBotQuestion: latestOutbound ? String(latestOutbound.body).trim() : null,
    recentConversation
  };
}

export async function persistOutboundConversationMessage(prisma, input = {}) {
  if (!validateOutboundContract(prisma)) {
    throw new Error('outbound_message_prisma_contract_invalid');
  }

  const data = buildMessageData({
    ...input,
    direction: MessageDirection.OUTBOUND
  });
  const message = await prisma.message.create({ data });

  return {
    created: true,
    message,
    data
  };
}

export async function findRecentOutboundConversationDelivery(prisma, input = {}) {
  if (!validateOutboundDeliveryReadContract(prisma)) {
    throw new Error('outbound_delivery_read_prisma_contract_invalid');
  }

  const candidateId = requireNonEmptyString(input.candidateId, 'candidate_id');
  const body = String(input.body ?? '');
  if (!body.trim()) throw new Error('outbound_delivery_body_required');
  const dedupeKey = requireNonEmptyString(input.dedupeKey, 'outbound_delivery_dedupe_key');
  const createdSince = normalizeTimestamp(input.createdSince, 'outbound_delivery_created_since');
  const rows = await prisma.message.findMany({
    where: {
      candidateId,
      direction: MessageDirection.OUTBOUND,
      body,
      createdAt: { gte: createdSince }
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true,
      waMessageId: true,
      rawPayload: true,
      createdAt: true
    }
  });

  const message = rows.find((row) => {
    const delivery = normalizeExistingJsonObject(row?.rawPayload?.delivery);
    return delivery.dedupeKey === dedupeKey
      && ['SENDING', 'SENT'].includes(String(delivery.state || '').toUpperCase());
  }) || null;

  return { found: Boolean(message), message };
}

export async function updateOutboundConversationDelivery(prisma, input = {}) {
  if (!validatePayloadMergeContract(prisma)) {
    throw new Error('outbound_delivery_update_prisma_contract_invalid');
  }

  const messageId = requireNonEmptyString(input.messageId, 'message_id');
  const state = requireOutboundDeliveryState(input.state);
  const occurredAtInput = input.occurredAt === undefined ? new Date() : input.occurredAt;
  const occurredAt = normalizeTimestamp(occurredAtInput, 'outbound_delivery_occurred_at');
  const providerMessageId = input.providerMessageId == null
    ? null
    : requireNonEmptyString(input.providerMessageId, 'outbound_delivery_provider_message_id');
  const lastError = input.lastError == null
    ? null
    : String(input.lastError).slice(0, 400);
  const candidateStateCount = input.candidateStateCount == null
    ? null
    : Number(input.candidateStateCount);

  if (candidateStateCount !== null && !Number.isInteger(candidateStateCount)) {
    throw new Error('outbound_delivery_candidate_state_count_invalid');
  }

  const persisted = await prisma.message.findUnique({
    where: { id: messageId },
    select: { rawPayload: true }
  });
  if (!persisted) throw new Error('message_not_found');

  const existingPayload = normalizeExistingJsonObject(persisted.rawPayload);
  const existingDelivery = normalizeExistingJsonObject(existingPayload.delivery);
  const delivery = {
    ...existingDelivery,
    state,
    updatedAt: occurredAt.toISOString(),
    retryPolicy: 'MANUAL_REVIEW_ONLY'
  };

  if (state === 'SENT') delivery.sentAt = occurredAt.toISOString();
  if (state === 'FAILED') delivery.failedAt = occurredAt.toISOString();
  if (state === 'UNKNOWN') delivery.unknownAt = occurredAt.toISOString();
  if (providerMessageId) delivery.providerMessageId = providerMessageId;
  if (lastError !== null) delivery.lastError = lastError;
  if (candidateStateCount !== null) delivery.candidateStateCount = candidateStateCount;

  const rawPayload = {
    ...existingPayload,
    delivery
  };
  const data = { rawPayload };
  if (providerMessageId) data.waMessageId = providerMessageId;

  const message = await prisma.message.update({
    where: { id: messageId },
    data
  });

  return {
    updated: true,
    message,
    messageId,
    rawPayload,
    delivery
  };
}

export async function updateConversationMessagePayload(prisma, input = {}) {
  if (!validatePayloadUpdateContract(prisma)) {
    throw new Error('message_payload_update_prisma_contract_invalid');
  }

  const messageId = requireNonEmptyString(input.messageId, 'message_id');
  if (input.rawPayload === undefined) {
    throw new Error('raw_payload_required');
  }

  const message = await prisma.message.update({
    where: { id: messageId },
    data: { rawPayload: input.rawPayload }
  });

  return {
    updated: true,
    message,
    messageId,
    rawPayload: input.rawPayload
  };
}

export async function mergeConversationMessagePayload(prisma, input = {}) {
  if (!validatePayloadMergeContract(prisma)) {
    throw new Error('message_payload_merge_prisma_contract_invalid');
  }

  const messageId = requireNonEmptyString(input.messageId, 'message_id');
  const patch = requireJsonObject(input.patch, 'payload_patch');
  const persisted = await prisma.message.findUnique({
    where: { id: messageId },
    select: { rawPayload: true }
  });
  if (!persisted) {
    throw new Error('message_not_found');
  }
  const rawPayload = {
    ...normalizeExistingJsonObject(persisted.rawPayload),
    ...patch
  };
  const message = await prisma.message.update({
    where: { id: messageId },
    data: { rawPayload }
  });

  return {
    updated: true,
    message,
    messageId,
    rawPayload
  };
}

export async function compareAndSwapConversationMessagePayload(prisma, input = {}) {
  if (!validatePayloadCompareAndSwapContract(prisma)) {
    throw new Error('message_payload_compare_and_swap_prisma_contract_invalid');
  }

  const messageId = requireNonEmptyString(input.messageId, 'message_id');
  const expectedRawPayload = requireJsonObject(input.expectedRawPayload, 'expected_raw_payload');
  const rawPayload = requireJsonObject(input.rawPayload, 'raw_payload');
  const result = await prisma.message.updateMany({
    where: {
      id: messageId,
      rawPayload: { equals: expectedRawPayload }
    },
    data: { rawPayload }
  });

  return {
    updated: result.count === 1,
    count: result.count,
    messageId,
    rawPayload
  };
}

export async function markConversationMessagesResponded(prisma, input = {}) {
  if (!validateRespondedContract(prisma)) {
    throw new Error('message_responded_prisma_contract_invalid');
  }

  const messageIds = requireMessageIds(input.messageIds);
  const respondedAtInput = Object.hasOwn(input, 'respondedAt') ? input.respondedAt : new Date();
  const respondedAt = normalizeTimestamp(respondedAtInput, 'responded_at');
  const result = await prisma.message.updateMany({
    where: { id: { in: messageIds } },
    data: { respondedAt }
  });

  return {
    updated: result.count,
    messageIds,
    respondedAt
  };
}

export async function deleteConversationMessagesForCandidate(prisma, input = {}) {
  if (!validateCandidateDeleteContract(prisma)) {
    throw new Error('candidate_message_delete_prisma_contract_invalid');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('candidate_message_delete_input_invalid');
  }

  const candidateId = requireNonEmptyString(input.candidateId, 'candidate_id');
  const result = await prisma.message.deleteMany({
    where: { candidateId }
  });

  return {
    deleted: result.count,
    candidateId
  };
}
