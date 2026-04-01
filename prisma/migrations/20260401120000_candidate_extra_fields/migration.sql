-- Add new candidate fields for recruitment flow and dashboard.
ALTER TABLE "Candidate"
  ADD COLUMN IF NOT EXISTS "neighborhood" TEXT,
  ADD COLUMN IF NOT EXISTS "experienceInfo" TEXT,
  ADD COLUMN IF NOT EXISTS "experienceTime" TEXT,
  ADD COLUMN IF NOT EXISTS "medicalRestrictions" TEXT,
  ADD COLUMN IF NOT EXISTS "transportMode" TEXT;
