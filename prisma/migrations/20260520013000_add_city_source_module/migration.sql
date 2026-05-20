-- Migration: classify cities by source module for clearer board segmentation.
-- RECRUITMENT: cities used by bot/recruitment flows.
-- DISPATCH: cities created for dispatch/operations flows.
-- ADMIN: cities created manually for general board configuration.

DO $$
BEGIN
  CREATE TYPE "CitySourceModule" AS ENUM ('RECRUITMENT', 'DISPATCH', 'ADMIN');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "City"
ADD COLUMN IF NOT EXISTS "sourceModule" "CitySourceModule" NOT NULL DEFAULT 'RECRUITMENT';

CREATE INDEX IF NOT EXISTS "City_sourceModule_idx" ON "City"("sourceModule");
