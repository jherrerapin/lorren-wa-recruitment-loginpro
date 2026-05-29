CREATE TABLE "DevAuditEvent" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "entityLabel" TEXT,
    "action" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorUsername" TEXT,
    "actorRole" TEXT,
    "actorSource" TEXT,
    "ipAddress" TEXT,
    "forwardedFor" TEXT,
    "userAgent" TEXT,
    "method" TEXT,
    "path" TEXT,
    "fromValue" JSONB,
    "toValue" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DevAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DevAuditEvent_entityType_entityId_createdAt_idx" ON "DevAuditEvent"("entityType", "entityId", "createdAt");
CREATE INDEX "DevAuditEvent_actorUsername_createdAt_idx" ON "DevAuditEvent"("actorUsername", "createdAt");
CREATE INDEX "DevAuditEvent_action_createdAt_idx" ON "DevAuditEvent"("action", "createdAt");
