-- CreateTable
CREATE TABLE "DispatchServiceRequest" (
    "id" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "operationPointName" TEXT,
    "cityName" TEXT,
    "address" TEXT,
    "serviceDate" TIMESTAMP(3) NOT NULL,
    "startTime" TEXT,
    "endTime" TEXT,
    "requiredWorkers" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'PENDING_ASSIGNMENT',
    "notes" TEXT,
    "createdByUsername" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DispatchServiceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DispatchAssignment" (
    "id" TEXT NOT NULL,
    "serviceRequestId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ASSIGNED',
    "notes" TEXT,
    "createdByUsername" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DispatchAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DispatchServiceRequest_serviceDate_idx" ON "DispatchServiceRequest"("serviceDate");
CREATE INDEX "DispatchServiceRequest_status_idx" ON "DispatchServiceRequest"("status");
CREATE INDEX "DispatchServiceRequest_cityName_idx" ON "DispatchServiceRequest"("cityName");
CREATE UNIQUE INDEX "DispatchAssignment_serviceRequestId_workerId_key" ON "DispatchAssignment"("serviceRequestId", "workerId");
CREATE INDEX "DispatchAssignment_serviceRequestId_idx" ON "DispatchAssignment"("serviceRequestId");
CREATE INDEX "DispatchAssignment_workerId_idx" ON "DispatchAssignment"("workerId");
CREATE INDEX "DispatchAssignment_status_idx" ON "DispatchAssignment"("status");

-- AddForeignKey
ALTER TABLE "DispatchAssignment" ADD CONSTRAINT "DispatchAssignment_serviceRequestId_fkey" FOREIGN KEY ("serviceRequestId") REFERENCES "DispatchServiceRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DispatchAssignment" ADD CONSTRAINT "DispatchAssignment_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "DispatchWorker"("id") ON DELETE CASCADE ON UPDATE CASCADE;
