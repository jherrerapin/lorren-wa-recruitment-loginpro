import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { currentMetaAdsCampaignWhere } from '../src/routes/metaAdsStats.js';

const dashboard = readFileSync(new URL('../src/routes/metaAdsStats.js', import.meta.url), 'utf8');
const metrics = readFileSync(new URL('../src/services/metaRecruitmentStats.js', import.meta.url), 'utf8');
const sync = readFileSync(new URL('../src/services/metaAdsInsightsSync.js', import.meta.url), 'utf8');
const client = readFileSync(new URL('../src/services/metaAdsClient.js', import.meta.url), 'utf8');

test('panel explica resultados, costos y recomendaciones con lenguaje sencillo', () => {
  assert.match(dashboard, /Actualizar desde Meta/);
  assert.match(dashboard, /Costo aproximado por persona/);
  assert.match(dashboard, /MetaAdSnapshot|metaAdSnapshot/);
  assert.doesNotMatch(dashboard, /Mostrar históricos\/no disponibles/);
  assert.doesNotMatch(dashboard, /name="historical"/);
  assert.match(dashboard, /Actualmente no existen anuncios en Meta Ads/);
  assert.match(dashboard, /¿Qué produjo la inversión\?/);
  assert.match(dashboard, /Cumplen los requisitos/);
  assert.match(dashboard, /Asistieron a entrevista/);
  assert.match(dashboard, /¿Qué necesita atención\?/);
  assert.match(dashboard, /Qué conviene hacer/);
  assert.match(dashboard, /Muy pocos datos/);
  assert.match(dashboard, /no cambian campañas ni presupuestos automáticamente/i);
  assert.match(dashboard, /<details class="technical">/);
  assert.doesNotMatch(dashboard, /Hojas de vida válidas/);
});

test('consulta de anuncios exige inventario actual sincronizado', () => {
  assert.deepEqual(currentMetaAdsCampaignWhere(), {
    sourceType: 'META_ADS',
    createdByUsername: 'meta-ads-sync',
    endsAt: null
  });
  assert.deepEqual(currentMetaAdsCampaignWhere({ city: 'Neiva', vacancyId: 'vacancy-1' }), {
    sourceType: 'META_ADS',
    createdByUsername: 'meta-ads-sync',
    endsAt: null,
    city: { contains: 'Neiva', mode: 'insensitive' },
    vacancyId: 'vacancy-1'
  });
});

test('panel usa un router explícito y no modifica Express globalmente', () => {
  assert.match(dashboard, /export function metaAdsStatsRouter/);
  assert.doesNotMatch(dashboard, /express\.Router\s*=/);
});

test('Marketing API exige una credencial dedicada distinta a WhatsApp', () => {
  assert.match(client, /META', 'ADS', 'ACCESS', 'TOKEN/);
  assert.doesNotMatch(client, /META', 'ACCESS', 'TOKEN'\]\)/);
  assert.match(dashboard, /getMetaAdsConfig/);
  assert.match(dashboard, /META_ADS_ACCESS_TOKEN/);
});

test('panel no depende del presupuesto manual inexistente', () => {
  assert.doesNotMatch(dashboard, /budgetCOP/);
  assert.match(dashboard, /Dinero invertido/);
});

test('costos de entrevistas e inasistencias usan resultados reales del proceso', () => {
  assert.match(metrics, /booking\.status === 'NO_SHOW'/);
  assert.doesNotMatch(metrics, /confirmed - metric\.attended/);
  assert.match(metrics, /costPerScheduled/);
  assert.match(metrics, /costPerAttended/);
  assert.match(metrics, /costPerHired/);
});

test('atribución estadística no compara nombres ni tokens', () => {
  assert.match(metrics, /candidate\.metaAdId/);
  assert.match(metrics, /candidate\.campaignId/);
  assert.doesNotMatch(metrics, /includes\(.*campaign/i);
  assert.doesNotMatch(metrics, /campaignCodeRaw/);
});

test('inventario usa una sola fuente de anuncios y retira ausentes', () => {
  assert.match(sync, /campaign\{id,name,status,effective_status\}/);
  assert.match(sync, /adset\{id,name,status,effective_status,campaign_id\}/);
  assert.doesNotMatch(sync, /\/campaigns`/);
  assert.doesNotMatch(sync, /\/adsets`/);
  assert.match(sync, /markAdsMissingFromMeta/);
  assert.match(sync, /endsAt: syncedAt/);
  assert.match(sync, /endsAt: null/);
});
