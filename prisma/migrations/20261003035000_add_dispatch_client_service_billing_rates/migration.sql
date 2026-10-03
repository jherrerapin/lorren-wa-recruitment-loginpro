-- Align the deployed database with DispatchClientService.billingRates introduced in #1880.
-- Nullable and additive: existing service rows remain valid without backfill.
ALTER TABLE "DispatchClientService"
ADD COLUMN IF NOT EXISTS "billingRates" JSONB;
