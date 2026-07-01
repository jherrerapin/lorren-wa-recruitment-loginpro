import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

function readSource(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('Meta Ads client is not responsible for Express or database side effects', () => {
  const source = readSource('src/services/metaAdsClient.js');

  assert.equal(source.includes("from 'express'"), false);
  assert.equal(source.includes('PrismaClient'), false);
  assert.equal(source.includes('express.response'), false);
  assert.equal(source.includes('express.Router'), false);
  assert.equal(source.includes('__estadisticasCleanerInstalled'), false);
  assert.equal(source.includes('__estadisticasClassificationRouterInstalled'), false);
  assert.equal(source.includes('export function getMetaAdsConfig'), true);
  assert.equal(source.includes('export function createMetaAdsClient'), true);
});

test('Campaign budget migration exists for statistics cost metrics', () => {
  const migration = readSource('prisma/migrations/20260630000100_campaign_budget_cop/migration.sql');

  assert.equal(migration.includes('ALTER TABLE "Campaign"'), true);
  assert.equal(migration.includes('ADD COLUMN IF NOT EXISTS "budgetCOP" DECIMAL(14, 2)'), true);
});
