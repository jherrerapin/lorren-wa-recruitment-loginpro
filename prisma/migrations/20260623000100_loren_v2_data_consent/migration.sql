CREATE TYPE "DataConsentStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED');

ALTER TABLE "Candidate"
  ADD COLUMN "dataConsentStatus" "DataConsentStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "dataConsentVersion" TEXT,
  ADD COLUMN "dataConsentText" TEXT,
  ADD COLUMN "dataConsentSource" TEXT,
  ADD COLUMN "dataConsentAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "dataConsentRevokedAt" TIMESTAMP(3),
  ADD COLUMN "dataConsentRecordedBy" TEXT;

CREATE TABLE "CandidateDataConsentEvent" (
  "id" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "status" "DataConsentStatus" NOT NULL,
  "version" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "actorUsername" TEXT,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CandidateDataConsentEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Candidate_dataConsentStatus_idx" ON "Candidate"("dataConsentStatus");
CREATE INDEX "CandidateDataConsentEvent_candidateId_createdAt_idx" ON "CandidateDataConsentEvent"("candidateId", "createdAt");
CREATE INDEX "CandidateDataConsentEvent_status_createdAt_idx" ON "CandidateDataConsentEvent"("status", "createdAt");

ALTER TABLE "CandidateDataConsentEvent"
  ADD CONSTRAINT "CandidateDataConsentEvent_candidateId_fkey"
  FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
