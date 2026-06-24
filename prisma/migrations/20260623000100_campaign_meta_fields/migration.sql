-- Loren V2: metadatos Meta Ads en Candidate y limpieza de Campaign.
-- Agrega campos de atribución exacta desde el objeto referral de WhatsApp.
-- Elimina zone de Campaign (redundante con zoneContext de Vacancy).

ALTER TABLE "Candidate"
  ADD COLUMN IF NOT EXISTS "metaCtwaClid"    TEXT,
  ADD COLUMN IF NOT EXISTS "metaAdId"        TEXT,
  ADD COLUMN IF NOT EXISTS "metaCampaignId"  TEXT,
  ADD COLUMN IF NOT EXISTS "metaCampaignName" TEXT;

ALTER TABLE "Campaign"
  DROP COLUMN IF EXISTS "zone";

CREATE INDEX IF NOT EXISTS "Candidate_metaAdId_idx"       ON "Candidate"("metaAdId");
CREATE INDEX IF NOT EXISTS "Candidate_metaCampaignId_idx" ON "Candidate"("metaCampaignId");
