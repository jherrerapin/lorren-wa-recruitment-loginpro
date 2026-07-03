CREATE TABLE "DispatchWhatsappConfirmation" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "serviceRequestId" TEXT,
    "phone" TEXT,
    "chatId" TEXT,
    "providerMessageId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DispatchWhatsappConfirmation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DispatchWhatsappConfirmation_assignmentId_idx" ON "DispatchWhatsappConfirmation"("assignmentId");
CREATE INDEX "DispatchWhatsappConfirmation_phone_status_expiresAt_idx" ON "DispatchWhatsappConfirmation"("phone", "status", "expiresAt");
CREATE INDEX "DispatchWhatsappConfirmation_chatId_status_expiresAt_idx" ON "DispatchWhatsappConfirmation"("chatId", "status", "expiresAt");
CREATE INDEX "DispatchWhatsappConfirmation_providerMessageId_idx" ON "DispatchWhatsappConfirmation"("providerMessageId");

ALTER TABLE "DispatchWhatsappConfirmation" ADD CONSTRAINT "DispatchWhatsappConfirmation_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "DispatchAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
