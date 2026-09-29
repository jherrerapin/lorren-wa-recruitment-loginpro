function requireMessageId(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('messageId must be a non-empty string');
  }
  return value.trim();
}

function requireCreate(dependencies) {
  const create = dependencies?.prisma?.webhookEvent?.create;
  if (typeof create !== 'function') {
    throw new TypeError('dependencies.prisma.webhookEvent.create must be a function');
  }
  return create;
}

/**
 * Atomically claims a Meta message ID. The database unique constraint is the
 * concurrency authority; no read-before-write check is performed.
 */
export async function acquireMessageLock(messageId, dependencies = {}) {
  const normalizedMessageId = requireMessageId(messageId);
  const create = requireCreate(dependencies);

  try {
    await create.call(dependencies.prisma.webhookEvent, {
      data: { messageId: normalizedMessageId }
    });
    return true;
  } catch (error) {
    if (error?.code === 'P2002') return false;
    throw error;
  }
}

/** Release a failed queue attempt so the same durable job can be retried. */
export async function releaseMessageLock(messageId, dependencies = {}) {
  const normalizedMessageId = requireMessageId(messageId);
  const deleteMany = dependencies?.prisma?.webhookEvent?.deleteMany;
  if (typeof deleteMany !== 'function') {
    throw new TypeError('dependencies.prisma.webhookEvent.deleteMany must be a function');
  }
  await deleteMany.call(dependencies.prisma.webhookEvent, {
    where: { messageId: normalizedMessageId }
  });
}

export default acquireMessageLock;
