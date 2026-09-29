export const JOB_TYPES = {
  CANDIDATE_PROCESS_REMINDER: 'candidate_process_reminder',
  INTERVIEW_REMINDER: 'interview_reminder',
  ADMIN_FORWARD_ATTACHMENT: 'admin_forward_attachment',
  CV_STORAGE_MIGRATION: 'cv_storage_migration',
  WHATSAPP_INBOUND_MESSAGE: 'WHATSAPP_INBOUND_MESSAGE'
};

export async function enqueueJob(prisma, { type, payload = {}, runAt = new Date(), dedupeKey = null, maxAttempts = 5 }) {
  return prisma.jobQueueItem.create({
    data: {
      type,
      payload,
      scheduledAt: runAt,
      dedupeKey,
      maxAttempts
    }
  });
}

function requireInboundPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('payload must be an object');
  }
  if (typeof payload.messageId !== 'string' || !payload.messageId.trim()) {
    throw new TypeError('payload.messageId must be a non-empty string');
  }
  return { ...payload, messageId: payload.messageId.trim() };
}

/** Persist an inbound Meta message before acknowledging its webhook. */
export async function enqueueInboundMessage(payload, dependencies = {}) {
  const prisma = dependencies.prisma;
  if (typeof prisma?.jobQueueItem?.create !== 'function') {
    throw new TypeError('dependencies.prisma.jobQueueItem.create must be a function');
  }

  const normalizedPayload = requireInboundPayload(payload);
  try {
    return await prisma.jobQueueItem.create({
      data: {
        type: JOB_TYPES.WHATSAPP_INBOUND_MESSAGE,
        payload: normalizedPayload,
        dedupeKey: `whatsapp:${normalizedPayload.messageId}`
      }
    });
  } catch (error) {
    // A Meta retry is already durable when this unique key exists.
    if (error?.code === 'P2002') return { duplicate: true };
    throw error;
  }
}

export async function claimDueJobs(prisma, { limit = 20, now = new Date() } = {}) {
  const rows = await prisma.$queryRaw`
    WITH picked AS (
      SELECT id FROM "JobQueue"
      WHERE status = 'PENDING'
        AND run_at <= ${now}
      ORDER BY run_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "JobQueue" j
    SET status = 'RUNNING', started_at = NOW(), updated_at = NOW()
    FROM picked
    WHERE j.id = picked.id
    RETURNING j.*
  `;
  return rows;
}

export async function completeJob(prisma, id) {
  return prisma.jobQueueItem.update({
    where: { id },
    data: { status: 'DONE', finishedAt: new Date(), updatedAt: new Date() }
  });
}

export async function failJob(prisma, id, errorMessage = 'unknown_error') {
  const job = await prisma.jobQueueItem.findUnique({ where: { id } });
  if (!job) return null;
  const attempts = (job.attempts || 0) + 1;
  const terminal = attempts >= job.maxAttempts;
  return prisma.jobQueueItem.update({
    where: { id },
    data: {
      attempts,
      status: terminal ? 'FAILED' : 'PENDING',
      lastError: String(errorMessage || 'unknown_error').slice(0, 400),
      startedAt: terminal ? job.startedAt : null,
      finishedAt: terminal ? new Date() : null
    }
  });
}
