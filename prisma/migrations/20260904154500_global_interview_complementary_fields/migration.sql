-- Los campos complementarios dejan de pertenecer a una vacante y pasan a ser
-- un catálogo global del módulo de entrevistas. Antes de retirar vacancyId se
-- consolidan etiquetas equivalentes y se preserva un único valor por candidato.

CREATE TEMP TABLE "_InterviewComplementaryFieldMap" ON COMMIT DROP AS
SELECT
  "id" AS "fieldId",
  FIRST_VALUE("id") OVER (
    PARTITION BY "normalizedLabel"
    ORDER BY "createdAt" ASC, "id" ASC
  ) AS "canonicalId"
FROM "InterviewComplementaryField";

-- Si históricamente un candidato terminó con la misma etiqueta en más de una
-- vacante, conservar un único valor determinístico: primero uno no vacío y,
-- entre equivalentes, el actualizado más recientemente.
CREATE TEMP TABLE "_InterviewComplementaryValueKeep" ON COMMIT DROP AS
SELECT DISTINCT ON (v."candidateId", m."canonicalId")
  v."id" AS "valueId",
  m."canonicalId"
FROM "InterviewComplementaryValue" AS v
JOIN "_InterviewComplementaryFieldMap" AS m
  ON m."fieldId" = v."fieldId"
ORDER BY
  v."candidateId",
  m."canonicalId",
  (NULLIF(BTRIM(v."value"), '') IS NOT NULL) DESC,
  v."updatedAt" DESC,
  v."createdAt" DESC,
  v."id" DESC;

DELETE FROM "InterviewComplementaryValue" AS v
USING "_InterviewComplementaryFieldMap" AS m
WHERE v."fieldId" = m."fieldId"
  AND NOT EXISTS (
    SELECT 1
    FROM "_InterviewComplementaryValueKeep" AS k
    WHERE k."valueId" = v."id"
  );

UPDATE "InterviewComplementaryValue" AS v
SET "fieldId" = k."canonicalId"
FROM "_InterviewComplementaryValueKeep" AS k
WHERE v."id" = k."valueId"
  AND v."fieldId" <> k."canonicalId";

DELETE FROM "InterviewComplementaryField" AS f
USING "_InterviewComplementaryFieldMap" AS m
WHERE f."id" = m."fieldId"
  AND m."fieldId" <> m."canonicalId";

-- El orden también pasa a ser global.
WITH ranked AS (
  SELECT
    "id",
    (ROW_NUMBER() OVER (
      ORDER BY "sortOrder" ASC, "createdAt" ASC, "label" ASC, "id" ASC
    ) - 1)::INTEGER AS "globalSortOrder"
  FROM "InterviewComplementaryField"
)
UPDATE "InterviewComplementaryField" AS f
SET "sortOrder" = ranked."globalSortOrder"
FROM ranked
WHERE f."id" = ranked."id";

ALTER TABLE "InterviewComplementaryField"
  DROP CONSTRAINT "InterviewComplementaryField_vacancyId_fkey";

DROP INDEX "InterviewComplementaryField_vacancyId_normalizedLabel_key";
DROP INDEX "InterviewComplementaryField_vacancyId_sortOrder_idx";

ALTER TABLE "InterviewComplementaryField"
  DROP COLUMN "vacancyId";

CREATE UNIQUE INDEX "InterviewComplementaryField_normalizedLabel_key"
  ON "InterviewComplementaryField"("normalizedLabel");

CREATE INDEX "InterviewComplementaryField_sortOrder_idx"
  ON "InterviewComplementaryField"("sortOrder");
