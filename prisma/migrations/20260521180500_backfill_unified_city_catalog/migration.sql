-- Populate City from text city fields used by bot/recruitment and dispatch.
-- The dispatch dropdown already reads City; this migration makes sure bot cities
-- stored only as Vacancy.city or Candidate.zone also exist as real City rows.

CREATE OR REPLACE FUNCTION normalize_city_key(input_value TEXT)
RETURNS TEXT AS $$
BEGIN
  RETURN NULLIF(
    trim(lower(translate(coalesce(input_value, ''), 'ÁÉÍÓÚÜáéíóúüÑñ', 'AEIOUUaeiouuNn'))),
    ''
  );
END;
$$ LANGUAGE plpgsql;

WITH source_cities AS (
  SELECT trim(city) AS name, TRUE AS recruit, FALSE AS dispatch FROM "Vacancy" WHERE city IS NOT NULL AND trim(city) <> ''
  UNION ALL
  SELECT trim(zone) AS name, TRUE AS recruit, FALSE AS dispatch FROM "Candidate" WHERE zone IS NOT NULL AND trim(zone) <> ''
  UNION ALL
  SELECT trim("residenceCity") AS name, FALSE AS recruit, TRUE AS dispatch FROM "DispatchWorker" WHERE "residenceCity" IS NOT NULL AND trim("residenceCity") <> ''
  UNION ALL
  SELECT trim("cityName") AS name, FALSE AS recruit, TRUE AS dispatch FROM "DispatchClient" WHERE "cityName" IS NOT NULL AND trim("cityName") <> ''
  UNION ALL
  SELECT trim("cityName") AS name, FALSE AS recruit, TRUE AS dispatch FROM "DispatchOperationPoint" WHERE "cityName" IS NOT NULL AND trim("cityName") <> ''
  UNION ALL
  SELECT trim("cityName") AS name, FALSE AS recruit, TRUE AS dispatch FROM "DispatchServiceRequest" WHERE "cityName" IS NOT NULL AND trim("cityName") <> ''
), grouped AS (
  SELECT normalize_city_key(name) AS city_key, min(name) AS display_name, bool_or(recruit) AS recruit, bool_or(dispatch) AS dispatch
  FROM source_cities
  WHERE normalize_city_key(name) IS NOT NULL
  GROUP BY normalize_city_key(name)
)
INSERT INTO "City" (id, name, "sourceModule", "usedForRecruitment", "usedForDispatch", "createdAt", "updatedAt")
SELECT
  'city_' || md5(grouped.city_key),
  grouped.display_name,
  CASE WHEN grouped.dispatch AND NOT grouped.recruit THEN 'DISPATCH'::"CitySourceModule" ELSE 'RECRUITMENT'::"CitySourceModule" END,
  grouped.recruit,
  grouped.dispatch,
  now(),
  now()
FROM grouped
WHERE NOT EXISTS (
  SELECT 1 FROM "City" existing WHERE normalize_city_key(existing.name) = grouped.city_key
)
ON CONFLICT (name) DO NOTHING;

WITH source_flags AS (
  SELECT trim(city) AS name, TRUE AS recruit, FALSE AS dispatch FROM "Vacancy" WHERE city IS NOT NULL AND trim(city) <> ''
  UNION ALL
  SELECT trim(zone) AS name, TRUE AS recruit, FALSE AS dispatch FROM "Candidate" WHERE zone IS NOT NULL AND trim(zone) <> ''
  UNION ALL
  SELECT trim("residenceCity") AS name, FALSE AS recruit, TRUE AS dispatch FROM "DispatchWorker" WHERE "residenceCity" IS NOT NULL AND trim("residenceCity") <> ''
  UNION ALL
  SELECT trim("cityName") AS name, FALSE AS recruit, TRUE AS dispatch FROM "DispatchClient" WHERE "cityName" IS NOT NULL AND trim("cityName") <> ''
  UNION ALL
  SELECT trim("cityName") AS name, FALSE AS recruit, TRUE AS dispatch FROM "DispatchOperationPoint" WHERE "cityName" IS NOT NULL AND trim("cityName") <> ''
  UNION ALL
  SELECT trim("cityName") AS name, FALSE AS recruit, TRUE AS dispatch FROM "DispatchServiceRequest" WHERE "cityName" IS NOT NULL AND trim("cityName") <> ''
), grouped_flags AS (
  SELECT normalize_city_key(name) AS city_key, bool_or(recruit) AS recruit, bool_or(dispatch) AS dispatch
  FROM source_flags
  WHERE normalize_city_key(name) IS NOT NULL
  GROUP BY normalize_city_key(name)
)
UPDATE "City" city
SET
  "usedForRecruitment" = city."usedForRecruitment" OR grouped_flags.recruit,
  "usedForDispatch" = city."usedForDispatch" OR grouped_flags.dispatch,
  "updatedAt" = now()
FROM grouped_flags
WHERE normalize_city_key(city.name) = grouped_flags.city_key;
