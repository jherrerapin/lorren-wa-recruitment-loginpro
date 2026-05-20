-- Migration: remove ADMIN as an active city source.
-- Any existing ADMIN city is moved to RECRUITMENT before the enum is narrowed.

UPDATE "City"
SET "sourceModule" = 'RECRUITMENT'
WHERE "sourceModule" = 'ADMIN';

ALTER TYPE "CitySourceModule" RENAME TO "CitySourceModule_old";

CREATE TYPE "CitySourceModule" AS ENUM ('RECRUITMENT', 'DISPATCH');

ALTER TABLE "City"
ALTER COLUMN "sourceModule" DROP DEFAULT;

ALTER TABLE "City"
ALTER COLUMN "sourceModule" TYPE "CitySourceModule"
USING "sourceModule"::text::"CitySourceModule";

ALTER TABLE "City"
ALTER COLUMN "sourceModule" SET DEFAULT 'RECRUITMENT';

DROP TYPE "CitySourceModule_old";
