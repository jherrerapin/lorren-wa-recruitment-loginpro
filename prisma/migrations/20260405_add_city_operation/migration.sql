-- Migration: add City and Operation models, add operationId + isActive to Vacancy
-- Run: prisma migrate dev --name add_city_operation

CREATE TABLE "City" (
    "id"        TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "City_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "City_name_key" ON "City"("name");

CREATE TABLE "Operation" (
    "id"        TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "cityId"    TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Operation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Operation_name_cityId_key" ON "Operation"("name", "cityId");
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_cityId_fkey"
    FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add operationId (nullable) and isActive to Vacancy
ALTER TABLE "Vacancy" ADD COLUMN IF NOT EXISTS "operationId" TEXT;
ALTER TABLE "Vacancy" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE "Vacancy" ADD CONSTRAINT "Vacancy_operationId_fkey"
    FOREIGN KEY ("operationId") REFERENCES "Operation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
