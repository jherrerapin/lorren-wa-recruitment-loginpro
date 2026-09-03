-- La coordinación humana puede acordar una fecha/hora real sin fingir que proviene
-- de un InterviewSlot configurado para la agenda automática de la vacante.
ALTER TABLE "InterviewBooking"
ALTER COLUMN "slotId" DROP NOT NULL;
