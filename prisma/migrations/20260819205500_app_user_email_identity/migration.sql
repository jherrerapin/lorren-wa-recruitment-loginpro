-- Expand-only migration for the transition from legacy usernames to human identity + email.
-- Existing users intentionally remain with NULL identityMigratedAt so every non-DEV
-- account must explicitly confirm its name and email after the deployment.
ALTER TABLE "AppUser"
  ADD COLUMN "displayName" TEXT,
  ADD COLUMN "email" TEXT,
  ADD COLUMN "identityMigratedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "AppUser_email_key" ON "AppUser"("email");
