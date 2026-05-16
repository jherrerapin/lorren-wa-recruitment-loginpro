CREATE TABLE IF NOT EXISTS "BotKnowledge" (
  "id" TEXT NOT NULL,
  "scope" TEXT NOT NULL DEFAULT 'GLOBAL',
  "content" TEXT NOT NULL,
  "tags" TEXT,
  "vacancyId" TEXT,
  "candidateId" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BotKnowledge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BotKnowledge_scope_isActive_updatedAt_idx" ON "BotKnowledge"("scope", "isActive", "updatedAt");
CREATE INDEX IF NOT EXISTS "BotKnowledge_vacancyId_isActive_idx" ON "BotKnowledge"("vacancyId", "isActive");
CREATE INDEX IF NOT EXISTS "BotKnowledge_candidateId_isActive_idx" ON "BotKnowledge"("candidateId", "isActive");
