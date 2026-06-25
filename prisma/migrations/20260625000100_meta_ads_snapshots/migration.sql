-- Estadísticas: snapshots diarios de Meta Ads para evitar consultar Meta en cada render del dashboard.
CREATE TABLE "MetaAdAccount" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "name" TEXT,
  "currency" TEXT,
  "timezoneName" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MetaAdAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MetaCampaignSnapshot" (
  "id" TEXT NOT NULL,
  "date" TIMESTAMP(3) NOT NULL,
  "metaCampaignId" TEXT NOT NULL,
  "metaCampaignName" TEXT,
  "spend" DECIMAL(14,4) NOT NULL DEFAULT 0,
  "impressions" INTEGER NOT NULL DEFAULT 0,
  "reach" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "inlineLinkClicks" INTEGER NOT NULL DEFAULT 0,
  "ctr" DECIMAL(10,4) NOT NULL DEFAULT 0,
  "cpc" DECIMAL(14,4) NOT NULL DEFAULT 0,
  "cpm" DECIMAL(14,4) NOT NULL DEFAULT 0,
  "rawActions" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MetaCampaignSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MetaAdSnapshot" (
  "id" TEXT NOT NULL,
  "date" TIMESTAMP(3) NOT NULL,
  "metaCampaignId" TEXT,
  "metaCampaignName" TEXT,
  "metaAdsetId" TEXT,
  "metaAdsetName" TEXT,
  "metaAdId" TEXT NOT NULL,
  "metaAdName" TEXT,
  "spend" DECIMAL(14,4) NOT NULL DEFAULT 0,
  "impressions" INTEGER NOT NULL DEFAULT 0,
  "reach" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "inlineLinkClicks" INTEGER NOT NULL DEFAULT 0,
  "ctr" DECIMAL(10,4) NOT NULL DEFAULT 0,
  "cpc" DECIMAL(14,4) NOT NULL DEFAULT 0,
  "cpm" DECIMAL(14,4) NOT NULL DEFAULT 0,
  "rawActions" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MetaAdSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MetaAdAccount_accountId_key" ON "MetaAdAccount"("accountId");
CREATE UNIQUE INDEX "MetaCampaignSnapshot_date_metaCampaignId_key" ON "MetaCampaignSnapshot"("date", "metaCampaignId");
CREATE UNIQUE INDEX "MetaAdSnapshot_date_metaAdId_key" ON "MetaAdSnapshot"("date", "metaAdId");
CREATE INDEX "MetaCampaignSnapshot_date_idx" ON "MetaCampaignSnapshot"("date");
CREATE INDEX "MetaCampaignSnapshot_metaCampaignId_idx" ON "MetaCampaignSnapshot"("metaCampaignId");
CREATE INDEX "MetaCampaignSnapshot_date_metaCampaignId_idx" ON "MetaCampaignSnapshot"("date", "metaCampaignId");
CREATE INDEX "MetaAdSnapshot_date_idx" ON "MetaAdSnapshot"("date");
CREATE INDEX "MetaAdSnapshot_metaCampaignId_idx" ON "MetaAdSnapshot"("metaCampaignId");
CREATE INDEX "MetaAdSnapshot_metaAdId_idx" ON "MetaAdSnapshot"("metaAdId");
CREATE INDEX "MetaAdSnapshot_date_metaCampaignId_idx" ON "MetaAdSnapshot"("date", "metaCampaignId");
CREATE INDEX "MetaAdSnapshot_date_metaAdId_idx" ON "MetaAdSnapshot"("date", "metaAdId");
