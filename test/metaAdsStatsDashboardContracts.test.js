import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dashboard = readFileSync(new URL('../src/services/metaAdsStatsRouterPatch.js', import.meta.url), 'utf8');
const metrics = readFileSync(new URL('../src/services/metaRecruitmentStats.js', import.meta.url), 'utf8');
const sync = readFileSync(new URL('../src/services/metaAdsInsightsSync.js', import.meta.url), 'utf8');

test('panel expone actualización manual, históricos y costos estimados', () => {
  assert.match(dashboard, /Actualizar desde Meta/);
  assert.match(dashboard, /Mostrar históricos\/no disponibles/);
  assert.match(dashboard, /Costo estimado individual/);
  assert.match(dashboard, /MetaAdSnapshot|metaAdSnapshot/);
});

test('panel no depende del presupuesto manual inexistente', () => {
  assert.doesNotMatch(dashboard, /budgetCOP/);
  assert.match(dashboard, /Gasto real Meta/);
});

test('atribución estadística no compara nombres ni tokens', () => {
  assert.match(metrics, /candidate\.metaAdId/);
  assert.match(metrics, /candidate\.campaignId/);
  assert.doesNotMatch(metrics, /includes\(.*campaign/i);
  assert.doesNotMatch(metrics, /campaignCodeRaw/);
});

test('insights históricos no vuelven a crear anuncios activos', () => {
  assert.doesNotMatch(sync, /upsertInternalCampaignsFromMeta/);
  assert.match(sync, /markAdsMissingFromMeta/);
  assert.match(sync, /endsAt: syncedAt/);
  assert.match(sync, /endsAt: null/);
});
