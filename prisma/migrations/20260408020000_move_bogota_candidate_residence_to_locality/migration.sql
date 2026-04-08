UPDATE "Candidate" AS c
SET
  "locality" = COALESCE(NULLIF(TRIM(c."locality"), ''), NULLIF(TRIM(c."neighborhood"), '')),
  "neighborhood" = NULL
FROM "Vacancy" AS v
WHERE c."vacancyId" = v."id"
  AND LOWER(TRANSLATE(v."city", 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')) = 'bogota'
  AND (
    NULLIF(TRIM(c."neighborhood"), '') IS NOT NULL
    OR NULLIF(TRIM(c."locality"), '') IS NOT NULL
  );
