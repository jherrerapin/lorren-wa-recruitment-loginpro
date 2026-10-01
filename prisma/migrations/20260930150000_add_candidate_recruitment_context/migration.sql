ALTER TABLE "Candidate"
  ADD COLUMN "recruitmentCity" TEXT,
  ADD COLUMN "recruitmentRole" TEXT;

UPDATE "Candidate" AS c
SET
  "recruitmentCity" = COALESCE(c."recruitmentCity", v."city"),
  "recruitmentRole" = COALESCE(c."recruitmentRole", v."role")
FROM "Vacancy" AS v
WHERE c."vacancyId" = v."id";
