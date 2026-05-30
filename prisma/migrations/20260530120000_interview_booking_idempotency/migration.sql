-- Migration: 20260530120000_interview_booking_idempotency
-- Objetivo: impedir que un candidato tenga mas de una entrevista activa
-- y cerrar datos historicos duplicados antes de crear el indice unico parcial.

-- 1. Cerrar duplicados activos historicos por candidato.
-- Conserva como activa la cita mas reciente por scheduledAt/createdAt/id.
WITH ranked_active_bookings AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "candidateId"
      ORDER BY "scheduledAt" DESC, "createdAt" DESC, id DESC
    ) AS row_number_per_candidate
  FROM "InterviewBooking"
  WHERE status IN ('SCHEDULED', 'CONFIRMED')
)
UPDATE "InterviewBooking" AS booking
SET
  status = 'RESCHEDULED',
  "reminderWindowClosed" = true,
  "updatedAt" = CURRENT_TIMESTAMP,
  notes = CONCAT(
    COALESCE(booking.notes || E'\n', ''),
    '[auto] Cerrada por migracion de idempotencia: existia mas de una entrevista activa para este candidato.'
  )
FROM ranked_active_bookings AS ranked
WHERE booking.id = ranked.id
  AND ranked.row_number_per_candidate > 1;

-- 2. Invariante fuerte: solo una cita activa por candidato.
CREATE UNIQUE INDEX IF NOT EXISTS "InterviewBooking_one_active_per_candidate_idx"
ON "InterviewBooking" ("candidateId")
WHERE status IN ('SCHEDULED', 'CONFIRMED');

-- 3. Invariante adicional: no duplicar la misma cita activa exacta.
CREATE UNIQUE INDEX IF NOT EXISTS "InterviewBooking_active_exact_booking_idx"
ON "InterviewBooking" ("candidateId", "vacancyId", "slotId", "scheduledAt")
WHERE status IN ('SCHEDULED', 'CONFIRMED');

-- 4. Indice de apoyo para el dispatcher de recordatorios.
CREATE INDEX IF NOT EXISTS "InterviewBooking_reminder_dispatch_idx"
ON "InterviewBooking" (status, "reminderSentAt", "reminderWindowClosed", "scheduledAt");
