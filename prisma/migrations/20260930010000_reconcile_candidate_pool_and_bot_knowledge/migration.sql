-- These fields are already present in Prisma's schema but were not backed by a migration.
ALTER TYPE "ConversationStep" ADD VALUE IF NOT EXISTS 'AWAITING_POOL_CONSENT';

ALTER TABLE "Candidate" ADD COLUMN IF NOT EXISTS "optInGeneralPool" BOOLEAN;

-- The existing BotKnowledge table stores scoped content. Keep the legacy reset
-- marker's key/value columns nullable so existing knowledge rows remain valid.
ALTER TABLE "BotKnowledge"
  ADD COLUMN IF NOT EXISTS "key" TEXT,
  ADD COLUMN IF NOT EXISTS "value" TEXT;
ALTER TABLE "BotKnowledge" ALTER COLUMN "content" SET DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS "BotKnowledge_key_key" ON "BotKnowledge"("key");
