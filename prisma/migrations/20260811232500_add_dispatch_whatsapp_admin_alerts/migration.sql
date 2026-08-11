ALTER TABLE "AppUser"
  ADD COLUMN "dispatchAlertPhone" TEXT,
  ADD COLUMN "dispatchWindowExpiryReminderEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "DispatchWhatsappConfirmation"
  ADD COLUMN "alertOwnerUsername" TEXT;

CREATE INDEX "DispatchWhatsappConfirmation_alertOwnerUsername_idx"
  ON "DispatchWhatsappConfirmation"("alertOwnerUsername");

CREATE TABLE "DispatchWhatsappContactWindow" (
  "id" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "lastInboundAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DispatchWhatsappContactWindow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DispatchWhatsappContactWindow_scope_phone_key"
  ON "DispatchWhatsappContactWindow"("scope", "phone");
CREATE INDEX "DispatchWhatsappContactWindow_lastInboundAt_idx"
  ON "DispatchWhatsappContactWindow"("lastInboundAt");

CREATE TABLE "DispatchWhatsappWindowReminder" (
  "id" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "appUserId" TEXT NOT NULL,
  "windowStartedAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "sentAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DispatchWhatsappWindowReminder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DispatchWhatsappWindowReminder_scope_phone_appUserId_windowStartedAt_key"
  ON "DispatchWhatsappWindowReminder"("scope", "phone", "appUserId", "windowStartedAt");
CREATE INDEX "DispatchWhatsappWindowReminder_status_windowStartedAt_idx"
  ON "DispatchWhatsappWindowReminder"("status", "windowStartedAt");
CREATE INDEX "DispatchWhatsappWindowReminder_appUserId_createdAt_idx"
  ON "DispatchWhatsappWindowReminder"("appUserId", "createdAt");
