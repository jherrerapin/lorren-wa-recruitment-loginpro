ALTER TABLE "Candidate"
ADD COLUMN IF NOT EXISTS "inactivityReminderSent" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "InterviewBooking"
ADD COLUMN IF NOT EXISTS "interviewReminderSent" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "Candidate_botPaused_inactivityReminderSent_updatedAt_idx"
ON "Candidate"("botPaused", "inactivityReminderSent", "updatedAt");

CREATE INDEX IF NOT EXISTS "InterviewBooking_status_interviewReminderSent_scheduledAt_idx"
ON "InterviewBooking"("status", "interviewReminderSent", "scheduledAt");
