ALTER TABLE "AppUser"
ADD COLUMN "canAccessMetaAds" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "canAccessCvAnalysis" BOOLEAN NOT NULL DEFAULT false;

-- Conserva el acceso de cualquier usuario al que ya se le hubiera habilitado
-- Estadísticas antes de separar los permisos por submódulo.
UPDATE "AppUser"
SET
  "canAccessMetaAds" = true,
  "canAccessCvAnalysis" = true
WHERE "canAccessStatistics" = true;

CREATE INDEX "AppUser_canAccessMetaAds_idx"
ON "AppUser"("canAccessMetaAds");

CREATE INDEX "AppUser_canAccessCvAnalysis_idx"
ON "AppUser"("canAccessCvAnalysis");
