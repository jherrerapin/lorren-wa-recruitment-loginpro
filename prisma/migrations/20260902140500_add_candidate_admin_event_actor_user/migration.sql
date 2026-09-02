ALTER TABLE "CandidateAdminEvent"
ADD COLUMN "actorUserId" TEXT;

CREATE INDEX "CandidateAdminEvent_actorUserId_idx"
ON "CandidateAdminEvent"("actorUserId");

ALTER TABLE "CandidateAdminEvent"
ADD CONSTRAINT "CandidateAdminEvent_actorUserId_fkey"
FOREIGN KEY ("actorUserId") REFERENCES "AppUser"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
