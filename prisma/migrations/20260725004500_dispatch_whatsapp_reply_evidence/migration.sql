-- Solo una confirmación entrante real puede autorizar el agradecimiento automático.
ALTER TABLE "DispatchWhatsappConfirmation"
  ADD COLUMN "confirmationMessageId" TEXT,
  ADD COLUMN "confirmationReceivedAt" TIMESTAMP(3);

-- La cola heredada no distingue respuestas reales de confirmaciones manuales.
-- Se cierra antes de iniciar el nuevo runtime para impedir otro envío masivo.
UPDATE "DispatchWhatsappConfirmation"
SET
  "status" = 'CONFIRMED',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'CONFIRMED_REPLY_PENDING'
  AND "confirmationReceivedAt" IS NULL;

CREATE INDEX "DispatchWaConfirmation_reply_evidence_idx"
  ON "DispatchWhatsappConfirmation"("status", "confirmationReceivedAt");
