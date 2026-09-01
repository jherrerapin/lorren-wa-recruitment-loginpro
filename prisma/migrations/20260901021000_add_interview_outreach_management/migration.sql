-- CreateEnum
CREATE TYPE "InterviewInvitationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DECLINED');

-- CreateEnum
CREATE TYPE "InterviewAttendanceStatus" AS ENUM ('PENDING', 'ATTENDED', 'NO_SHOW');

-- CreateTable
CREATE TABLE "InterviewCandidateReview" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "vacancyId" TEXT NOT NULL,
    "invitationStatusOverride" "InterviewInvitationStatus",
    "invitationUpdatedByUserId" TEXT,
    "invitationUpdatedByLabel" TEXT,
    "invitationUpdatedAt" TIMESTAMP(3),
    "attendanceStatus" "InterviewAttendanceStatus" NOT NULL DEFAULT 'PENDING',
    "attendanceUpdatedByUserId" TEXT,
    "attendanceUpdatedByLabel" TEXT,
    "attendanceUpdatedAt" TIMESTAMP(3),
    "rating" DECIMAL(3,2),
    "observationEnabled" BOOLEAN NOT NULL DEFAULT false,
    "observation" TEXT,
    "reviewUpdatedByUserId" TEXT,
    "reviewUpdatedByLabel" TEXT,
    "reviewUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterviewCandidateReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterviewComplementaryField" (
    "id" TEXT NOT NULL,
    "vacancyId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "normalizedLabel" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT,
    "createdByLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterviewComplementaryField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterviewComplementaryValue" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "value" TEXT,
    "updatedByUserId" TEXT,
    "updatedByLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterviewComplementaryValue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InterviewCandidateReview_candidateId_vacancyId_key" ON "InterviewCandidateReview"("candidateId", "vacancyId");

-- CreateIndex
CREATE INDEX "InterviewCandidateReview_vacancyId_attendanceStatus_idx" ON "InterviewCandidateReview"("vacancyId", "attendanceStatus");

-- CreateIndex
CREATE INDEX "InterviewCandidateReview_vacancyId_rating_idx" ON "InterviewCandidateReview"("vacancyId", "rating");

-- CreateIndex
CREATE UNIQUE INDEX "InterviewComplementaryField_vacancyId_normalizedLabel_key" ON "InterviewComplementaryField"("vacancyId", "normalizedLabel");

-- CreateIndex
CREATE INDEX "InterviewComplementaryField_vacancyId_sortOrder_idx" ON "InterviewComplementaryField"("vacancyId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "InterviewComplementaryValue_candidateId_fieldId_key" ON "InterviewComplementaryValue"("candidateId", "fieldId");

-- CreateIndex
CREATE INDEX "InterviewComplementaryValue_candidateId_idx" ON "InterviewComplementaryValue"("candidateId");

-- AddForeignKey
ALTER TABLE "InterviewCandidateReview" ADD CONSTRAINT "InterviewCandidateReview_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewCandidateReview" ADD CONSTRAINT "InterviewCandidateReview_vacancyId_fkey" FOREIGN KEY ("vacancyId") REFERENCES "Vacancy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewComplementaryField" ADD CONSTRAINT "InterviewComplementaryField_vacancyId_fkey" FOREIGN KEY ("vacancyId") REFERENCES "Vacancy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewComplementaryValue" ADD CONSTRAINT "InterviewComplementaryValue_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterviewComplementaryValue" ADD CONSTRAINT "InterviewComplementaryValue_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "InterviewComplementaryField"("id") ON DELETE CASCADE ON UPDATE CASCADE;
