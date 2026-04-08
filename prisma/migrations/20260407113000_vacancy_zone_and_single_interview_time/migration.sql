ALTER TABLE "Vacancy"
ADD COLUMN "interviewAddress" TEXT;

UPDATE "Vacancy"
SET "interviewAddress" = "operationAddress"
WHERE "schedulingEnabled" = true
  AND "interviewAddress" IS NULL;

ALTER TABLE "InterviewSlot"
DROP COLUMN "endTime",
DROP COLUMN "slotDurationMinutes";
