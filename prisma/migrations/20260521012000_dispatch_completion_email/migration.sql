ALTER TABLE "DispatchServiceRequest"
ADD COLUMN IF NOT EXISTS "completionEmailSentAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "completionEmailTo" TEXT,
ADD COLUMN IF NOT EXISTS "completionEmailProviderId" TEXT,
ADD COLUMN IF NOT EXISTS "completionEmailLastError" TEXT;

CREATE INDEX IF NOT EXISTS "DispatchServiceRequest_completionEmailSentAt_idx"
ON "DispatchServiceRequest"("completionEmailSentAt");
