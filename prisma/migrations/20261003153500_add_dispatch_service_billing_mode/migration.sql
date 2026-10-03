-- Add an explicit, mutually exclusive billing mode for dispatch client services.
-- Nullable preserves compatibility with services created before this feature.
DO $$ BEGIN
  CREATE TYPE "DispatchBillingMode" AS ENUM ('PERSON', 'PRODUCTION');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "DispatchClientService"
ADD COLUMN IF NOT EXISTS "billingMode" "DispatchBillingMode";
