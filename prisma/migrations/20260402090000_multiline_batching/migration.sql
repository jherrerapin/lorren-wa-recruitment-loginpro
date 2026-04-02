ALTER TABLE "Candidate"
  ADD COLUMN "multilineWindowUntil" TIMESTAMP(3),
  ADD COLUMN "multilineBatchVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Message"
  ADD COLUMN "respondedAt" TIMESTAMP(3);
