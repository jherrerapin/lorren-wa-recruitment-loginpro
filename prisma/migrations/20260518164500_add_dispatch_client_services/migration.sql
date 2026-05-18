-- CreateTable
CREATE TABLE "DispatchClientService" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUsername" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DispatchClientService_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "DispatchServiceRequest" ADD COLUMN "serviceId" TEXT,
ADD COLUMN "serviceName" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "DispatchClientService_clientId_name_key" ON "DispatchClientService"("clientId", "name");

-- CreateIndex
CREATE INDEX "DispatchClientService_clientId_idx" ON "DispatchClientService"("clientId");

-- CreateIndex
CREATE INDEX "DispatchClientService_isActive_idx" ON "DispatchClientService"("isActive");

-- CreateIndex
CREATE INDEX "DispatchServiceRequest_serviceId_idx" ON "DispatchServiceRequest"("serviceId");

-- AddForeignKey
ALTER TABLE "DispatchClientService" ADD CONSTRAINT "DispatchClientService_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "DispatchClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchServiceRequest" ADD CONSTRAINT "DispatchServiceRequest_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "DispatchClientService"("id") ON DELETE SET NULL ON UPDATE CASCADE;
