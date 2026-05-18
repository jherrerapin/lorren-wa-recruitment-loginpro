-- CreateTable
CREATE TABLE "DispatchClient" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "nit" TEXT,
  "contactName" TEXT,
  "contactPhone" TEXT,
  "contactEmail" TEXT,
  "notes" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdByUsername" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DispatchClient_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DispatchOperationPoint" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "cityName" TEXT,
  "address" TEXT,
  "contactName" TEXT,
  "contactPhone" TEXT,
  "publicToken" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "notes" TEXT,
  "createdByUsername" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DispatchOperationPoint_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "DispatchServiceRequest"
  ADD COLUMN "operationPointId" TEXT,
  ADD COLUMN "requestedByName" TEXT,
  ADD COLUMN "requestedByPhone" TEXT,
  ADD COLUMN "requestedByEmail" TEXT,
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'INTERNAL';

CREATE UNIQUE INDEX "DispatchOperationPoint_publicToken_key" ON "DispatchOperationPoint"("publicToken");
CREATE INDEX "DispatchClient_name_idx" ON "DispatchClient"("name");
CREATE INDEX "DispatchClient_isActive_idx" ON "DispatchClient"("isActive");
CREATE INDEX "DispatchOperationPoint_clientId_idx" ON "DispatchOperationPoint"("clientId");
CREATE INDEX "DispatchOperationPoint_cityName_idx" ON "DispatchOperationPoint"("cityName");
CREATE INDEX "DispatchOperationPoint_isActive_idx" ON "DispatchOperationPoint"("isActive");
CREATE INDEX "DispatchServiceRequest_operationPointId_idx" ON "DispatchServiceRequest"("operationPointId");
CREATE INDEX "DispatchServiceRequest_source_idx" ON "DispatchServiceRequest"("source");

ALTER TABLE "DispatchOperationPoint" ADD CONSTRAINT "DispatchOperationPoint_clientId_fkey"
FOREIGN KEY ("clientId") REFERENCES "DispatchClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DispatchServiceRequest" ADD CONSTRAINT "DispatchServiceRequest_operationPointId_fkey"
FOREIGN KEY ("operationPointId") REFERENCES "DispatchOperationPoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;
