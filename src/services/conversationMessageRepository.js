import { MessageDirection } from '@prisma/client';

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
  return value || {};
}

function requireMessageIds(value) {
  if (!Array.isArray(value)) throw new Error('message_ids_required');
  const ids = [...new Set(value.map((id) => requireNonEmptyString(id, 'message_id')))];
  if (!ids.length) throw new Error('message_ids_required');
  return ids;
}

function validateInboundContract(prisma) {
  return Boolean(
    prisma
    && prisma.message
    && typeof prisma.message.createMany === 'function'
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

function validateRespondedContract(prisma) {
  return Boolean(
    prisma
    && prisma.message
    && typeof prisma.message.updateMany === 'function'
  );
}

function validateDeleteByCandidateContract(prisma) {
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

export async function deleteConversationMessagesByCandidate(prisma, input = {}) {
  if (!validateDeleteByCandidateContract(prisma)) {
    throw new Error('message_delete_by_candidate_prisma_contract_invalid');
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
