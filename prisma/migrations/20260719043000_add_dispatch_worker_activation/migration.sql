-- Persist one-time activation tokens without storing the raw token.
-- The table is additive and has no runtime consumers until the activation routes are introduced.
CREATE TABLE "DispatchWorkerActivation" (
  "id" TEXT NOT NULL,
  "workerId" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "consumedByDeviceId" TEXT,
  "revokedAt" TIMESTAMP(3),
  "revokedByUsername" TEXT,
  "revocationReason" TEXT,
  "createdByUsername" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DispatchWorkerActivation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DispatchWorkerActivation_tokenHash_key"
  ON "DispatchWorkerActivation"("tokenHash");

CREATE INDEX "DispatchWorkerActivation_workerId_purpose_status_idx"
  ON "DispatchWorkerActivation"("workerId", "purpose", "status");

CREATE INDEX "DispatchWorkerActivation_status_expiresAt_idx"
  ON "DispatchWorkerActivation"("status", "expiresAt");

CREATE INDEX "DispatchWorkerActivation_consumedByDeviceId_idx"
  ON "DispatchWorkerActivation"("consumedByDeviceId");

CREATE INDEX "DispatchWorkerActivation_workerId_createdAt_idx"
  ON "DispatchWorkerActivation"("workerId", "createdAt");

ALTER TABLE "DispatchWorkerActivation"
  ADD CONSTRAINT "DispatchWorkerActivation_workerId_fkey"
  FOREIGN KEY ("workerId") REFERENCES "DispatchWorker"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DispatchWorkerActivation"
  ADD CONSTRAINT "DispatchWorkerActivation_consumedByDeviceId_fkey"
  FOREIGN KEY ("consumedByDeviceId") REFERENCES "DispatchWorkerDevice"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
