ALTER TABLE "AppUser"
ADD COLUMN "canAccessDispatch" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "AppUser_canAccessDispatch_idx"
ON "AppUser"("canAccessDispatch");
