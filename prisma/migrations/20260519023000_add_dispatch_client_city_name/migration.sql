ALTER TABLE "DispatchClient" ADD COLUMN "cityName" TEXT;
CREATE INDEX "DispatchClient_cityName_idx" ON "DispatchClient"("cityName");
