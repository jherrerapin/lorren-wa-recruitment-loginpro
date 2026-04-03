-- Vacancy ad image + ad text hints fields.
ALTER TABLE "Vacancy"
  ADD COLUMN IF NOT EXISTS "adImageData" BYTEA,
  ADD COLUMN IF NOT EXISTS "adImageMimeType" TEXT,
  ADD COLUMN IF NOT EXISTS "adImageOriginalName" TEXT,
  ADD COLUMN IF NOT EXISTS "adTextHints" TEXT;
