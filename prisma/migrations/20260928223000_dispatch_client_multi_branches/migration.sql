ALTER TABLE "DispatchClient"
ADD COLUMN "branchCityIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Backfill the new canonical branch set from the legacy administrative city
-- and every existing operation city. This preserves current multi-city clients
-- before the create/edit UI starts writing branchCityIds directly.
UPDATE "DispatchClient" AS client
SET "branchCityIds" = COALESCE((
  SELECT ARRAY(
    SELECT DISTINCT city."id"
    FROM "City" AS city
    WHERE (
      client."cityName" IS NOT NULL
      AND LOWER(BTRIM(city."name")) = LOWER(BTRIM(client."cityName"))
    ) OR EXISTS (
      SELECT 1
      FROM "DispatchOperationPoint" AS point
      WHERE point."clientId" = client."id"
        AND point."cityName" IS NOT NULL
        AND LOWER(BTRIM(city."name")) = LOWER(BTRIM(point."cityName"))
    )
    ORDER BY city."id"
  )
), ARRAY[]::TEXT[]);
