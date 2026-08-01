CREATE TABLE "CvReviewProfile" (
  "id" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "vacancyId" TEXT NOT NULL,
  "modelUsed" TEXT NOT NULL,
  "interpretedProfile" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CvReviewProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CvReviewProfile_fingerprint_key"
  ON "CvReviewProfile"("fingerprint");
CREATE INDEX "CvReviewProfile_vacancyId_idx"
  ON "CvReviewProfile"("vacancyId");

CREATE TABLE "CvCandidateComparison" (
  "id" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "candidateId" TEXT NOT NULL,
  "vacancyId" TEXT,
  "modelUsed" TEXT NOT NULL,
  "level" TEXT NOT NULL,
  "score" DOUBLE PRECISION NOT NULL,
  "reasons" JSONB NOT NULL,
  "evidence" JSONB NOT NULL,
  "gaps" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CvCandidateComparison_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CvCandidateComparison_fingerprint_key"
  ON "CvCandidateComparison"("fingerprint");
CREATE INDEX "CvCandidateComparison_candidateId_idx"
  ON "CvCandidateComparison"("candidateId");
CREATE INDEX "CvCandidateComparison_vacancyId_idx"
  ON "CvCandidateComparison"("vacancyId");

CREATE TABLE "CvAnalysisUsage" (
  "id" TEXT NOT NULL,
  "stage" TEXT NOT NULL,
  "vacancyId" TEXT,
  "candidateCount" INTEGER NOT NULL DEFAULT 0,
  "modelUsed" TEXT NOT NULL,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
  "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
  "totalTokens" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CvAnalysisUsage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CvAnalysisUsage_createdAt_idx"
  ON "CvAnalysisUsage"("createdAt");
CREATE INDEX "CvAnalysisUsage_stage_createdAt_idx"
  ON "CvAnalysisUsage"("stage", "createdAt");
CREATE INDEX "CvAnalysisUsage_vacancyId_createdAt_idx"
  ON "CvAnalysisUsage"("vacancyId", "createdAt");

ALTER TABLE "CvReviewProfile"
  ADD CONSTRAINT "CvReviewProfile_vacancyId_fkey"
  FOREIGN KEY ("vacancyId") REFERENCES "Vacancy"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CvCandidateComparison"
  ADD CONSTRAINT "CvCandidateComparison_candidateId_fkey"
  FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CvCandidateComparison"
  ADD CONSTRAINT "CvCandidateComparison_vacancyId_fkey"
  FOREIGN KEY ("vacancyId") REFERENCES "Vacancy"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CvAnalysisUsage"
  ADD CONSTRAINT "CvAnalysisUsage_vacancyId_fkey"
  FOREIGN KEY ("vacancyId") REFERENCES "Vacancy"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
