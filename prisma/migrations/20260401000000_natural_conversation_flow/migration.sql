-- Migración: flujo conversacional natural
-- Simplifica ConversationStep, actualiza CandidateStatus y agrega documentType

-- 1. Actualizar ConversationStep: reemplazar los pasos granulares por el flujo simplificado.
--    Primero mover candidatos existentes a pasos equivalentes del nuevo enum.
UPDATE "Candidate" SET "currentStep" = 'MENU' WHERE "currentStep" IN ('ASK_FULL_NAME', 'ASK_DOCUMENT', 'ASK_AGE', 'ASK_CITY', 'ASK_ZONE', 'ASK_EXPERIENCE', 'ASK_AVAILABILITY', 'ASK_CV');

-- Crear el nuevo enum temporal
CREATE TYPE "ConversationStep_new" AS ENUM ('MENU', 'GREETING_SENT', 'COLLECTING_DATA', 'CONFIRMING_DATA', 'DONE');

-- Migrar la columna al nuevo enum
ALTER TABLE "Candidate" ALTER COLUMN "currentStep" DROP DEFAULT;
ALTER TABLE "Candidate" ALTER COLUMN "currentStep" TYPE "ConversationStep_new" USING ("currentStep"::text::"ConversationStep_new");
ALTER TABLE "Candidate" ALTER COLUMN "currentStep" SET DEFAULT 'MENU';

-- Eliminar el enum viejo y renombrar el nuevo
DROP TYPE "ConversationStep";
ALTER TYPE "ConversationStep_new" RENAME TO "ConversationStep";

-- 2. Actualizar CandidateStatus: reemplazar PENDIENTE_CV y POSTULACION_COMPLETA por REGISTRADO.
UPDATE "Candidate" SET "status" = 'NUEVO' WHERE "status" IN ('PENDIENTE_CV', 'POSTULACION_COMPLETA');

-- Crear el nuevo enum temporal
CREATE TYPE "CandidateStatus_new" AS ENUM ('NUEVO', 'REGISTRADO', 'VALIDANDO', 'APROBADO', 'RECHAZADO', 'CONTACTADO');

-- Migrar la columna al nuevo enum
ALTER TABLE "Candidate" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Candidate" ALTER COLUMN "status" TYPE "CandidateStatus_new" USING ("status"::text::"CandidateStatus_new");
ALTER TABLE "Candidate" ALTER COLUMN "status" SET DEFAULT 'NUEVO';

-- Eliminar el enum viejo y renombrar el nuevo
DROP TYPE "CandidateStatus";
ALTER TYPE "CandidateStatus_new" RENAME TO "CandidateStatus";

-- 3. Agregar campo documentType al modelo Candidate.
ALTER TABLE "Candidate" ADD COLUMN "documentType" TEXT;
