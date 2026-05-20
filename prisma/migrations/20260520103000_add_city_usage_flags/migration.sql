-- Migration: allow one city to be used by recruitment, dispatch, or both.
-- sourceModule remains as a legacy compatibility field, but new UI/business logic uses the boolean flags.

ALTER TABLE "City"
ADD COLUMN IF NOT EXISTS "usedForRecruitment" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "City"
ADD COLUMN IF NOT EXISTS "usedForDispatch" BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE "City"
SET
  "usedForRecruitment" = CASE
    WHEN "sourceModule" = 'RECRUITMENT' THEN TRUE
    ELSE "usedForRecruitment"
  END,
  "usedForDispatch" = CASE
    WHEN "sourceModule" = 'DISPATCH' THEN TRUE
    ELSE "usedForDispatch"
  END;

-- Avoid unusable cities after migration: any city without an explicit usage stays available for recruitment.
UPDATE "City"
SET "usedForRecruitment" = TRUE
WHERE "usedForRecruitment" = FALSE
  AND "usedForDispatch" = FALSE;

CREATE INDEX IF NOT EXISTS "City_usedForRecruitment_idx" ON "City"("usedForRecruitment");
CREATE INDEX IF NOT EXISTS "City_usedForDispatch_idx" ON "City"("usedForDispatch");
