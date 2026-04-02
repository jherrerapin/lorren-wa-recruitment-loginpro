-- CreateEnum
CREATE TYPE "ReminderState" AS ENUM ('NONE', 'SCHEDULED', 'SENT', 'CANCELLED', 'SKIPPED');

-- AlterTable
ALTER TABLE "Candidate"
ADD COLUMN "lastInboundAt" TIMESTAMP(3),
ADD COLUMN "lastOutboundAt" TIMESTAMP(3),
ADD COLUMN "lastReminderAt" TIMESTAMP(3),
ADD COLUMN "rejectionDetails" TEXT,
ADD COLUMN "rejectionReason" TEXT,
ADD COLUMN "reminderScheduledFor" TIMESTAMP(3),
ADD COLUMN "reminderState" "ReminderState" NOT NULL DEFAULT 'NONE';
