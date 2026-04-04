-- Sprint 1 — v2 Architecture Migration
-- Campos nuevos en Candidate, Vacancy, nuevos modelos InterviewSlot e Interview

-- ============================================================
-- 1. CANDIDATE — nuevos campos
-- ============================================================

-- Localidad o municipio del candidato (aplica cuando la vacante tiene requiresLocality=true)
ALTER TABLE "Candidate" ADD COLUMN IF NOT EXISTS "locality" TEXT;

-- Resultado de validación geográfica por IA: true=viable, false=no viable, null=no evaluado
ALTER TABLE "Candidate" ADD COLUMN IF NOT EXISTS "proximityOk" BOOLEAN;

-- ============================================================
-- 2. VACANCY — nuevos campos
-- ============================================================

-- Nombre del cargo específico
ALTER TABLE "Vacancy" ADD COLUMN IF NOT EXISTS "cargo" TEXT;

-- Dirección exacta del lugar de trabajo u operación
ALTER TABLE "Vacancy" ADD COLUMN IF NOT EXISTS "operationAddress" TEXT;

-- Zonas o localidades viables para candidatos (JSON array de strings)
ALTER TABLE "Vacancy" ADD COLUMN IF NOT EXISTS "operationZones" JSONB;

-- Salario o rango salarial
ALTER TABLE "Vacancy" ADD COLUMN IF NOT EXISTS "salary" TEXT;

-- Horario de trabajo
ALTER TABLE "Vacancy" ADD COLUMN IF NOT EXISTS "schedule" TEXT;

-- Tipo de contrato
ALTER TABLE "Vacancy" ADD COLUMN IF NOT EXISTS "contractType" TEXT;

-- Switch: si true, el bot pedirá localidad al candidato y evaluará proximidad
ALTER TABLE "Vacancy" ADD COLUMN IF NOT EXISTS "requiresLocality" BOOLEAN NOT NULL DEFAULT false;

-- Switch: si true, el bot agendará entrevistas después de recolectar datos y HV
ALTER TABLE "Vacancy" ADD COLUMN IF NOT EXISTS "requiresInterview" BOOLEAN NOT NULL DEFAULT false;

-- ============================================================
-- 3. ENUM ConversationStep — nuevo valor SCHEDULING_INTERVIEW
-- ============================================================
-- Postgres requiere ALTER TYPE para añadir valores a un ENUM existente

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumtypid = 'ConversationStep'::regtype
    AND enumlabel = 'SCHEDULING_INTERVIEW'
  ) THEN
    ALTER TYPE "ConversationStep" ADD VALUE 'SCHEDULING_INTERVIEW' BEFORE 'DONE';
  END IF;
END $$;

-- ============================================================
-- 4. ENUM InterviewStatus — nuevo enum
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InterviewStatus') THEN
    CREATE TYPE "InterviewStatus" AS ENUM (
      'SCHEDULED',
      'CONFIRMED',
      'CANCELLED',
      'RESCHEDULED',
      'NO_SHOW',
      'ATTENDED'
    );
  END IF;
END $$;

-- ============================================================
-- 5. ENUM ReminderResponse — nuevo enum
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReminderResponse') THEN
    CREATE TYPE "ReminderResponse" AS ENUM (
      'CONFIRMED',
      'CANCELLED',
      'RESCHEDULED',
      'NO_RESPONSE'
    );
  END IF;
END $$;

-- ============================================================
-- 6. TABLA InterviewSlot — nuevo modelo
-- ============================================================

CREATE TABLE IF NOT EXISTS "InterviewSlot" (
  "id"           TEXT         NOT NULL,
  "vacancyId"    TEXT         NOT NULL,
  "scheduledAt"  TIMESTAMP(3) NOT NULL,
  "maxCapacity"  INTEGER      NOT NULL DEFAULT 1,
  "isActive"     BOOLEAN      NOT NULL DEFAULT true,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "InterviewSlot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InterviewSlot_vacancyId_fkey"
    FOREIGN KEY ("vacancyId") REFERENCES "Vacancy"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "InterviewSlot_vacancyId_scheduledAt_idx"
  ON "InterviewSlot"("vacancyId", "scheduledAt");

-- ============================================================
-- 7. TABLA Interview — nuevo modelo
-- ============================================================

CREATE TABLE IF NOT EXISTS "Interview" (
  "id"               TEXT             NOT NULL,
  "candidateId"      TEXT             NOT NULL,
  "slotId"           TEXT             NOT NULL,
  "status"           "InterviewStatus" NOT NULL DEFAULT 'SCHEDULED',
  "statusUpdatedAt"  TIMESTAMP(3),
  "statusUpdatedBy"  TEXT,
  "reminderSentAt"   TIMESTAMP(3),
  "reminderResponse" "ReminderResponse",
  "notes"            TEXT,
  "createdAt"        TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3)     NOT NULL,

  CONSTRAINT "Interview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Interview_candidateId_fkey"
    FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE CASCADE,
  CONSTRAINT "Interview_slotId_fkey"
    FOREIGN KEY ("slotId") REFERENCES "InterviewSlot"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "Interview_candidateId_idx" ON "Interview"("candidateId");
CREATE INDEX IF NOT EXISTS "Interview_slotId_idx" ON "Interview"("slotId");
