-- Sucursales replaces the old functional distinction between recruitment/dispatch cities.
-- Keep legacy City usage columns for compatibility in this migration, but neutralize
-- them so they no longer decide whether a location belongs to one module or another.
UPDATE "City"
SET
  "usedForRecruitment" = TRUE,
  "usedForDispatch" = TRUE,
  "sourceModule" = 'RECRUITMENT';

-- Expand/migrate before contract: DispatchWorkerVacancy is no longer the authority for
-- territorial availability, but it may contain historical information not yet present
-- in DispatchWorkerCity. Project every operation-backed legacy assignment to its branch
-- before the UI stops asking for a vacancy/profile.
INSERT INTO "DispatchWorkerCity" ("id", "workerId", "cityId", "createdAt")
SELECT
  'branch_' || md5(dwv."workerId" || ':' || operation."cityId"),
  dwv."workerId",
  operation."cityId",
  NOW()
FROM "DispatchWorkerVacancy" AS dwv
JOIN "Vacancy" AS vacancy ON vacancy."id" = dwv."vacancyId"
JOIN "Operation" AS operation ON operation."id" = vacancy."operationId"
WHERE operation."cityId" IS NOT NULL
ON CONFLICT ("workerId", "cityId") DO NOTHING;

-- Compatibility for historical vacancies that predate Operation.cityId linkage.
INSERT INTO "DispatchWorkerCity" ("id", "workerId", "cityId", "createdAt")
SELECT
  'branch_' || md5(dwv."workerId" || ':' || city."id"),
  dwv."workerId",
  city."id",
  NOW()
FROM "DispatchWorkerVacancy" AS dwv
JOIN "Vacancy" AS vacancy ON vacancy."id" = dwv."vacancyId"
JOIN "City" AS city
  ON translate(lower(trim(city."name")), 'áéíóúüñ', 'aeiouun')
   = translate(lower(trim(vacancy."city")), 'áéíóúüñ', 'aeiouun')
WHERE vacancy."operationId" IS NULL
ON CONFLICT ("workerId", "cityId") DO NOTHING;

-- Siberia is no longer an independent branch. It belongs to the Bogotá branch.
-- The migration preserves operations, vacancy links and worker assignments.
DO $$
DECLARE
  bogota_id TEXT;
  siberia_id TEXT;
  source_operation RECORD;
  target_operation_id TEXT;
BEGIN
  SELECT id
  INTO bogota_id
  FROM "City"
  WHERE translate(lower(trim(name)), 'áéíóúüñ', 'aeiouun') IN ('bogota', 'bogota d.c.', 'bogota dc')
  ORDER BY "createdAt" ASC
  LIMIT 1;

  SELECT id
  INTO siberia_id
  FROM "City"
  WHERE translate(lower(trim(name)), 'áéíóúüñ', 'aeiouun') = 'siberia'
  ORDER BY "createdAt" ASC
  LIMIT 1;

  IF siberia_id IS NULL THEN
    RETURN;
  END IF;

  -- If a legacy installation only has Siberia, promote it to the Bogotá branch.
  IF bogota_id IS NULL THEN
    UPDATE "City"
    SET name = 'Bogotá',
        "usedForRecruitment" = TRUE,
        "usedForDispatch" = TRUE,
        "sourceModule" = 'RECRUITMENT'
    WHERE id = siberia_id;

    UPDATE "Vacancy"
    SET city = 'Bogotá'
    WHERE translate(lower(trim(city)), 'áéíóúüñ', 'aeiouun') = 'siberia';

    UPDATE "Campaign"
    SET city = 'Bogotá'
    WHERE city IS NOT NULL
      AND translate(lower(trim(city)), 'áéíóúüñ', 'aeiouun') = 'siberia';

    RETURN;
  END IF;

  -- Avoid unique(workerId, cityId) conflicts, then move the remaining worker links.
  DELETE FROM "DispatchWorkerCity" AS siberia_link
  WHERE siberia_link."cityId" = siberia_id
    AND EXISTS (
      SELECT 1
      FROM "DispatchWorkerCity" AS bogota_link
      WHERE bogota_link."workerId" = siberia_link."workerId"
        AND bogota_link."cityId" = bogota_id
    );

  UPDATE "DispatchWorkerCity"
  SET "cityId" = bogota_id
  WHERE "cityId" = siberia_id;

  -- Merge operations with the same name before moving the remaining operations,
  -- preserving existing Vacancy.operationId references.
  FOR source_operation IN
    SELECT id, name
    FROM "Operation"
    WHERE "cityId" = siberia_id
    ORDER BY "createdAt" ASC
  LOOP
    SELECT id
    INTO target_operation_id
    FROM "Operation"
    WHERE "cityId" = bogota_id
      AND lower(trim(name)) = lower(trim(source_operation.name))
    ORDER BY "createdAt" ASC
    LIMIT 1;

    IF target_operation_id IS NOT NULL THEN
      UPDATE "Vacancy"
      SET "operationId" = target_operation_id,
          city = 'Bogotá'
      WHERE "operationId" = source_operation.id;

      DELETE FROM "Operation"
      WHERE id = source_operation.id;
    ELSE
      UPDATE "Operation"
      SET "cityId" = bogota_id
      WHERE id = source_operation.id;

      UPDATE "Vacancy"
      SET city = 'Bogotá'
      WHERE "operationId" = source_operation.id;
    END IF;
  END LOOP;

  UPDATE "Vacancy"
  SET city = 'Bogotá'
  WHERE translate(lower(trim(city)), 'áéíóúüñ', 'aeiouun') = 'siberia';

  UPDATE "Campaign"
  SET city = 'Bogotá'
  WHERE city IS NOT NULL
    AND translate(lower(trim(city)), 'áéíóúüñ', 'aeiouun') = 'siberia';

  DELETE FROM "City"
  WHERE id = siberia_id;
END $$;