ALTER TABLE "DispatchClient"
ADD COLUMN "isTestClient" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "DispatchClient_isTestClient_idx"
ON "DispatchClient"("isTestClient");
