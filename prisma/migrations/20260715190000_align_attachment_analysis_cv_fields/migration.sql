-- Expand AttachmentAnalysis to match the Prisma model used by CV review.
-- Legacy columns are intentionally kept so this migration is non-destructive.
ALTER TABLE "AttachmentAnalysis"
  ADD COLUMN IF NOT EXISTS "originalName" TEXT,
  ADD COLUMN IF NOT EXISTS "extractedText" TEXT,
  ADD COLUMN IF NOT EXISTS "summary" TEXT,
  ADD COLUMN IF NOT EXISTS "analysedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "modelUsed" TEXT,
  ADD COLUMN IF NOT EXISTS "rawResponse" JSONB;

-- Preserve the legacy filename, date and evidence when their new equivalents
-- have not been populated yet.
UPDATE "AttachmentAnalysis"
SET
  "originalName" = COALESCE("originalName", "fileName"),
  "analysedAt" = COALESCE("analysedAt", "createdAt", CURRENT_TIMESTAMP),
  "rawResponse" = CASE
    WHEN "rawResponse" IS NULL AND "evidence" IS NOT NULL
      THEN jsonb_build_object('legacyEvidence', "evidence")
    ELSE "rawResponse"
  END;

ALTER TABLE "AttachmentAnalysis"
  ALTER COLUMN "analysedAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "analysedAt" SET NOT NULL,
  ALTER COLUMN "classification" SET DEFAULT 'OTHER',
  ALTER COLUMN "confidence" DROP NOT NULL;

CREATE INDEX IF NOT EXISTS "AttachmentAnalysis_candidateId_idx"
  ON "AttachmentAnalysis"("candidateId");

CREATE INDEX IF NOT EXISTS "AttachmentAnalysis_classification_idx"
  ON "AttachmentAnalysis"("classification");
