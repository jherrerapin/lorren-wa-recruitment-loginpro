ALTER TABLE "DispatchClient" ADD COLUMN "publicToken" TEXT;

UPDATE "DispatchClient"
SET "publicToken" = substr(md5(random()::text || clock_timestamp()::text || "id"), 1, 32)
WHERE "publicToken" IS NULL;

ALTER TABLE "DispatchClient" ALTER COLUMN "publicToken" SET NOT NULL;
CREATE UNIQUE INDEX "DispatchClient_publicToken_key" ON "DispatchClient"("publicToken");
