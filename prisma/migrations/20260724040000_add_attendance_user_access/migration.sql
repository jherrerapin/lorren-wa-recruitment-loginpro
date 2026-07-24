ALTER TABLE "AppUser"
ADD COLUMN "canAccessAttendance" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "AppUser_canAccessAttendance_idx"
ON "AppUser"("canAccessAttendance");
