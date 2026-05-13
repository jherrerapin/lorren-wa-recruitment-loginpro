export const JOB_TYPES = {
  CANDIDATE_PROCESS_REMINDER: 'candidate_process_reminder',
  INTERVIEW_REMINDER: 'interview_reminder',
  ADMIN_FORWARD_ATTACHMENT: 'admin_forward_attachment',
  CV_STORAGE_MIGRATION: 'cv_storage_migration'
};

export async function enqueueJob(prisma, { type, payload = {}, runAt = new Date(), dedupeKey = null, maxAttempts = 5 }) {
  return prisma.jobQueue.create({
    data: {
      type,
      payload,
      runAt,
      dedupeKey,
      maxAttempts
    }
  });
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
    SET status = 'RUNNING', updated_at = NOW()
    FROM picked
    WHERE j.id = picked.id
    RETURNING j.*
  `;
  return rows;
}

export async function completeJob(prisma, id) {
  return prisma.jobQueue.update({
    where: { id },
    data: { status: 'DONE', completedAt: new Date(), updatedAt: new Date() }
  });
}

export async function failJob(prisma, id, errorMessage = 'unknown_error') {
  const job = await prisma.jobQueue.findUnique({ where: { id } });
  if (!job) return null;
  const attempts = (job.attempts || 0) + 1;
  const terminal = attempts >= job.maxAttempts;
  return prisma.jobQueue.update({
    where: { id },
    data: {
      attempts,
      status: terminal ? 'FAILED' : 'PENDING',
      lastError: String(errorMessage || 'unknown_error').slice(0, 400),
      completedAt: terminal ? new Date() : null
    }
  });
}
