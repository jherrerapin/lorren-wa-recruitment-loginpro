-- CreateTable
CREATE TABLE "DispatchWorker" (
  "id" TEXT NOT NULL,
  "candidateId" TEXT,
  "fullName" TEXT NOT NULL,
  "phone" TEXT,
  "documentType" TEXT,
  "documentNumber" TEXT,
  "residenceCity" TEXT,
  "residenceLocality" TEXT,
  "transportMode" TEXT,
  "source" TEXT NOT NULL DEFAULT 'CANDIDATE',
  "operationalStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DispatchWorker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DispatchWorkerCity" (
  "id" TEXT NOT NULL,
  "workerId" TEXT NOT NULL,
  "cityId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DispatchWorkerCity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DispatchWorkerVacancy" (
  "id" TEXT NOT NULL,
  "workerId" TEXT NOT NULL,
  "vacancyId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DispatchWorkerVacancy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DispatchWorker_candidateId_key" ON "DispatchWorker"("candidateId");
CREATE INDEX "DispatchWorker_candidateId_idx" ON "DispatchWorker"("candidateId");
CREATE INDEX "DispatchWorker_documentNumber_idx" ON "DispatchWorker"("documentNumber");
CREATE INDEX "DispatchWorker_phone_idx" ON "DispatchWorker"("phone");
CREATE INDEX "DispatchWorker_operationalStatus_idx" ON "DispatchWorker"("operationalStatus");
CREATE UNIQUE INDEX "DispatchWorkerCity_workerId_cityId_key" ON "DispatchWorkerCity"("workerId", "cityId");
CREATE INDEX "DispatchWorkerCity_cityId_idx" ON "DispatchWorkerCity"("cityId");
CREATE UNIQUE INDEX "DispatchWorkerVacancy_workerId_vacancyId_key" ON "DispatchWorkerVacancy"("workerId", "vacancyId");
CREATE INDEX "DispatchWorkerVacancy_vacancyId_idx" ON "DispatchWorkerVacancy"("vacancyId");

ALTER TABLE "DispatchWorker" ADD CONSTRAINT "DispatchWorker_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DispatchWorkerCity" ADD CONSTRAINT "DispatchWorkerCity_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "DispatchWorker"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DispatchWorkerCity" ADD CONSTRAINT "DispatchWorkerCity_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DispatchWorkerVacancy" ADD CONSTRAINT "DispatchWorkerVacancy_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "DispatchWorker"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DispatchWorkerVacancy" ADD CONSTRAINT "DispatchWorkerVacancy_vacancyId_fkey" FOREIGN KEY ("vacancyId") REFERENCES "Vacancy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
