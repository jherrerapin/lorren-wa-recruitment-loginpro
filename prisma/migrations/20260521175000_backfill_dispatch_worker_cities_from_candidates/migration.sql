-- Backfill DispatchWorkerCity relations from candidate and worker textual city fields.
-- Matching is done ignoring case and accents to avoid duplicates such as Bogota/Bogotá.

CREATE OR REPLACE FUNCTION normalize_city_key(input_value TEXT)
RETURNS TEXT AS $$
BEGIN
  RETURN NULLIF(
    trim(
      lower(
        translate(
          coalesce(input_value, ''),
          'ÁÉÍÓÚÜáéíóúüÑñ',
          'AEIOUUaeiouuNn'
        )
      )
    ),
    ''
  );
END;
$$ LANGUAGE plpgsql;

WITH worker_city_names AS (
  SELECT worker.id AS worker_id, normalize_city_key(worker."residenceCity") AS city_key
  FROM "DispatchWorker" worker
  WHERE worker."residenceCity" IS NOT NULL

  UNION

  SELECT worker.id AS worker_id, normalize_city_key(candidate.zone) AS city_key
  FROM "DispatchWorker" worker
  JOIN "Candidate" candidate ON candidate.id = worker."candidateId"
  WHERE candidate.zone IS NOT NULL

  UNION

  SELECT worker.id AS worker_id, normalize_city_key(vacancy.city) AS city_key
  FROM "DispatchWorker" worker
  JOIN "Candidate" candidate ON candidate.id = worker."candidateId"
  JOIN "Vacancy" vacancy ON vacancy.id = candidate."vacancyId"
  WHERE vacancy.city IS NOT NULL
), matched_worker_cities AS (
  SELECT DISTINCT worker_city_names.worker_id, city.id AS city_id
  FROM worker_city_names
  JOIN "City" city ON normalize_city_key(city.name) = worker_city_names.city_key
  WHERE worker_city_names.city_key IS NOT NULL
)
INSERT INTO "DispatchWorkerCity" (id, "workerId", "cityId", "createdAt")
SELECT
  'dwc_' || row_number() over (),
  matched.worker_id,
  matched.city_id,
  now()
FROM matched_worker_cities matched
ON CONFLICT ("workerId", "cityId") DO NOTHING;
