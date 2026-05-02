-- CreateTable
CREATE TABLE "OpenAIUsageLog" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT,
    "messageId" TEXT,
    "phoneHash" TEXT,
    "modelRequested" TEXT NOT NULL,
    "modelReturned" TEXT,
    "usageType" TEXT NOT NULL DEFAULT 'unknown',
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "dataSharingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "privacyMaskingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "sensitiveDataDetected" BOOLEAN NOT NULL DEFAULT false,
    "redactionSummary" JSONB,
    "openAIResponseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpenAIUsageLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpenAIUsageLog_candidateId_createdAt_idx" ON "OpenAIUsageLog"("candidateId", "createdAt");

-- CreateIndex
CREATE INDEX "OpenAIUsageLog_modelRequested_createdAt_idx" ON "OpenAIUsageLog"("modelRequested", "createdAt");

-- CreateIndex
CREATE INDEX "OpenAIUsageLog_usageType_createdAt_idx" ON "OpenAIUsageLog"("usageType", "createdAt");

-- AddForeignKey
ALTER TABLE "OpenAIUsageLog" ADD CONSTRAINT "OpenAIUsageLog_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
