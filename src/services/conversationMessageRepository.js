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
    const timestamp = respondedAt instanceof Date ? new Date(respondedAt.getTime()) : new Date(respondedAt);
    if (Number.isNaN(timestamp.getTime())) throw new Error('responded_at_invalid');
    data.respondedAt = timestamp;
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

export async function updateConversationMessagePayload(prisma, {
  messageId,
  rawPayload = null
} = {}) {
  if (!validatePayloadUpdateContract(prisma)) {
    throw new Error('message_payload_update_prisma_contract_invalid');
  }

  const normalizedMessageId = requireNonEmptyString(messageId, 'message_id');
  const message = await prisma.message.update({
    where: { id: normalizedMessageId },
    data: { rawPayload }
  });

  return {
    updated: true,
    message,
    data: { rawPayload }
  };
}
