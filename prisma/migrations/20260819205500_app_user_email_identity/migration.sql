-- Expand-only migration for the transition from legacy usernames to human identity + email.
-- Existing users intentionally remain with NULL identityMigratedAt so every non-DEV
-- account must explicitly confirm its name and email after the deployment.
--
-- This migration can be retried after a failed production attempt: Prisma Migrate does
-- not wrap migrations in a transaction by default, so a previous attempt may have
-- created some of these objects before failing.
BEGIN;

ALTER TABLE "AppUser"
  ADD COLUMN IF NOT EXISTS "displayName" TEXT,
  ADD COLUMN IF NOT EXISTS "email" TEXT,
  ADD COLUMN IF NOT EXISTS "identityMigratedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "AppUser_email_key" ON "AppUser"("email");

COMMIT;
