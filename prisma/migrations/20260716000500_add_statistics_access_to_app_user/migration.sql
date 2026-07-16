ALTER TABLE "AppUser"
ADD COLUMN "canAccessStatistics" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "AppUser_canAccessStatistics_idx"
ON "AppUser"("canAccessStatistics");
