CREATE TABLE "DispatchWorkerImportBatch" (
  "id" TEXT NOT NULL,
  "createdByUsername" TEXT NOT NULL,
  "originalFileName" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "items" JSONB NOT NULL,
  "summary" JSONB NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DispatchWorkerImportBatch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DispatchWorkerImportBatch_createdByUsername_status_expiresAt_idx"
  ON "DispatchWorkerImportBatch"("createdByUsername", "status", "expiresAt");

CREATE INDEX "DispatchWorkerImportBatch_expiresAt_idx"
  ON "DispatchWorkerImportBatch"("expiresAt");
