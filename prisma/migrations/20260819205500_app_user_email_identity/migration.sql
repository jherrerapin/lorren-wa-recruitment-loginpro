-- Expand-only migration for the transition from legacy usernames to human identity + email.
-- Existing users intentionally remain with NULL identityMigratedAt so every non-DEV
-- account must explicitly confirm its name and email after the deployment.
ALTER TABLE "AppUser"
  ADD COLUMN "displayName" TEXT,
  ADD COLUMN "email" TEXT,
  ADD COLUMN "identityMigratedAt" TIMESTAMP(3),
  ADD COLUMN "canManageUsers" BOOLEAN NOT NULL DEFAULT false;

-- Transition the one historical authority once; runtime no longer needs the legacy username.
UPDATE "AppUser"
SET "canManageUsers" = true
WHERE "username" = 'reclutador-general';

CREATE UNIQUE INDEX "AppUser_email_key" ON "AppUser"("email");
CREATE INDEX "AppUser_canManageUsers_idx" ON "AppUser"("canManageUsers");
