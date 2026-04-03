-- Manual bot pause controls + duplicate potential flags.
ALTER TABLE "Candidate"
  ADD COLUMN IF NOT EXISTS "botPaused" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "botPausedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "botPausedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "botPauseReason" TEXT,
  ADD COLUMN IF NOT EXISTS "botResumeMode" TEXT,
  ADD COLUMN IF NOT EXISTS "potentialDuplicate" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "potentialDuplicateNote" TEXT,
  ADD COLUMN IF NOT EXISTS "potentialDuplicateAt" TIMESTAMP(3);
