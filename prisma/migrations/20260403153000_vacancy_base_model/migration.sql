-- Vacancy base model + Candidate optional vacancy relation.
CREATE TABLE IF NOT EXISTS "Vacancy" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "city" TEXT NOT NULL,
  "description" TEXT,
  "profile" TEXT,
  "botIntroText" TEXT,
  "requirementsSummary" TEXT,
  "aliases" JSONB,
  "screeningConfig" JSONB,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "displayOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Vacancy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Vacancy_key_key" ON "Vacancy"("key");

ALTER TABLE "Candidate"
  ADD COLUMN IF NOT EXISTS "vacancyId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Candidate_vacancyId_fkey'
  ) THEN
    ALTER TABLE "Candidate"
      ADD CONSTRAINT "Candidate_vacancyId_fkey"
      FOREIGN KEY ("vacancyId") REFERENCES "Vacancy"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
