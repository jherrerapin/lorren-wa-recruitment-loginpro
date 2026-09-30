-- Preserve the existing JobQueue table and its rows while aligning it with
-- Prisma's JobQueueItem model. All other mapped columns already exist.
ALTER TABLE "JobQueue"
ADD COLUMN IF NOT EXISTS "started_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "JobQueue_type_idx" ON "JobQueue"("type");
