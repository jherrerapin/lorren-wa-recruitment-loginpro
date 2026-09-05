-- CreateEnum
CREATE TYPE "InterviewContinuationStatus" AS ENUM ('CONTINUES', 'WITHDREW');

-- AlterTable
ALTER TABLE "InterviewCandidateReview"
ADD COLUMN "continuationStatus" "InterviewContinuationStatus" NOT NULL DEFAULT 'CONTINUES',
ADD COLUMN "continuationUpdatedByUserId" TEXT,
ADD COLUMN "continuationUpdatedByLabel" TEXT,
ADD COLUMN "continuationUpdatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "InterviewCandidateReview_vacancyId_continuationStatus_idx"
ON "InterviewCandidateReview"("vacancyId", "continuationStatus");
