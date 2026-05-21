-- Corrective migration after the unified city catalog backfill.
-- City dropdowns must be populated only by cities explicitly created in the City catalog/CRUD.
-- The previous backfill created synthetic City rows with ids prefixed by 'city_'.
-- This migration removes those synthetic rows and their worker-city links when safe.

DELETE FROM "DispatchWorkerCity"
WHERE "cityId" IN (
  SELECT id
  FROM "City"
  WHERE id LIKE 'city_%'
);

DELETE FROM "City"
WHERE id LIKE 'city_%'
  AND NOT EXISTS (
    SELECT 1
    FROM "Operation"
    WHERE "Operation"."cityId" = "City".id
  );
