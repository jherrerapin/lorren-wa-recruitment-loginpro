CREATE TYPE "DispatchContractType" AS ENUM ('DIRECTO', 'CONTRATISTA');

ALTER TABLE "DispatchWorker"
ADD COLUMN "contractType" "DispatchContractType" NOT NULL DEFAULT 'DIRECTO';
