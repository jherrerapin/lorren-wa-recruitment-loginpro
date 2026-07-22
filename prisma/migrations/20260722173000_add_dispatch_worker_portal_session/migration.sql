-- Persist worker portal sessions without storing the raw session token.
-- This migration is additive and has no runtime consumers until public portal routes are introduced.
CREATE TABLE "DispatchWorkerPortalSession" (
  "id" TEXT NOT NULL,
  "workerId" TEXT NOT NULL,
  "workerDeviceId" TEXT NOT NULL,
  "activationId" TEXT NOT NULL,
  "sessionTokenHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "revokedByUsername" TEXT,
  "revocationReason" TEXT,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "platform" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DispatchWorkerPortalSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DispatchWorkerPortalSession_activationId_key"
  ON "DispatchWorkerPortalSession"("activationId");

CREATE UNIQUE INDEX "DispatchWorkerPortalSession_sessionTokenHash_key"
  ON "DispatchWorkerPortalSession"("sessionTokenHash");

CREATE INDEX "DispatchWorkerPortalSession_workerId_status_expiresAt_idx"
  ON "DispatchWorkerPortalSession"("workerId", "status", "expiresAt");

CREATE INDEX "DispatchWorkerPortalSession_workerDeviceId_status_expiresAt_idx"
  ON "DispatchWorkerPortalSession"("workerDeviceId", "status", "expiresAt");

CREATE INDEX "DispatchWorkerPortalSession_status_expiresAt_idx"
  ON "DispatchWorkerPortalSession"("status", "expiresAt");

CREATE INDEX "DispatchWorkerPortalSession_lastSeenAt_idx"
  ON "DispatchWorkerPortalSession"("lastSeenAt");

ALTER TABLE "DispatchWorkerPortalSession"
  ADD CONSTRAINT "DispatchWorkerPortalSession_workerId_fkey"
  FOREIGN KEY ("workerId") REFERENCES "DispatchWorker"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DispatchWorkerPortalSession"
  ADD CONSTRAINT "DispatchWorkerPortalSession_workerDeviceId_fkey"
  FOREIGN KEY ("workerDeviceId") REFERENCES "DispatchWorkerDevice"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DispatchWorkerPortalSession"
  ADD CONSTRAINT "DispatchWorkerPortalSession_activationId_fkey"
  FOREIGN KEY ("activationId") REFERENCES "DispatchWorkerActivation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
