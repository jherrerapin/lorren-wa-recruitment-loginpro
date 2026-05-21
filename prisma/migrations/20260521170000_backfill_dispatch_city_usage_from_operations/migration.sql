-- Backfill dispatch usage for cities that are already referenced by operational data.
-- This prevents the assignment board from hiding cities such as Bogotá when they were
-- created originally for recruitment but are already used by dispatch requests, clients,
-- operation points, or dispatch workers.

UPDATE "City" AS city
SET "usedForDispatch" = TRUE
WHERE city.id IN (
  SELECT DISTINCT "cityId"
  FROM "DispatchWorkerCity"
)
OR lower(city.name) IN (
  SELECT DISTINCT lower(trim("cityName"))
  FROM "DispatchClient"
  WHERE "cityName" IS NOT NULL AND trim("cityName") <> ''
)
OR lower(city.name) IN (
  SELECT DISTINCT lower(trim("cityName"))
  FROM "DispatchOperationPoint"
  WHERE "cityName" IS NOT NULL AND trim("cityName") <> ''
)
OR lower(city.name) IN (
  SELECT DISTINCT lower(trim("cityName"))
  FROM "DispatchServiceRequest"
  WHERE "cityName" IS NOT NULL AND trim("cityName") <> ''
);
