-- Loren V2: campañas y fuentes de candidatos.
-- Permite medir conversiones por campaña sin afectar candidatos existentes.

CREATE TYPE "CandidateSourceType" AS ENUM ('UNKNOWN', 'META_ADS', 'REFERRED', 'MANUAL', 'OTHER');

CREATE TABLE "Campaign" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sourceType" "CandidateSourceType" NOT NULL DEFAULT 'META_ADS',
  "city" TEXT,
  "zone" TEXT,
  "vacancyId" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "notes" TEXT,
  "createdByUsername" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Candidate"
  ADD COLUMN "campaignId" TEXT,
  ADD COLUMN "sourceType" "CandidateSourceType" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "campaignCodeRaw" TEXT,
  ADD COLUMN "referrerName" TEXT,
  ADD COLUMN "referrerPhone" TEXT;

CREATE UNIQUE INDEX "Campaign_code_key" ON "Campaign"("code");
CREATE INDEX "Campaign_sourceType_idx" ON "Campaign"("sourceType");
CREATE INDEX "Campaign_city_idx" ON "Campaign"("city");
CREATE INDEX "Campaign_vacancyId_idx" ON "Campaign"("vacancyId");
CREATE INDEX "Campaign_isActive_idx" ON "Campaign"("isActive");
CREATE INDEX "Candidate_campaignId_idx" ON "Candidate"("campaignId");
CREATE INDEX "Candidate_sourceType_idx" ON "Candidate"("sourceType");
CREATE INDEX "Candidate_status_createdAt_idx" ON "Candidate"("status", "createdAt");

ALTER TABLE "Campaign"
  ADD CONSTRAINT "Campaign_vacancyId_fkey"
  FOREIGN KEY ("vacancyId") REFERENCES "Vacancy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Candidate"
  ADD CONSTRAINT "Candidate_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
