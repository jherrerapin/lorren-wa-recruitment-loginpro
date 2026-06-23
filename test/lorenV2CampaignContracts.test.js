import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/routes/lorenV2.js', import.meta.url), 'utf8');

test('campañas Loren V2 son siempre pauta Meta y no exponen selector de fuente', () => {
  assert.match(source, /const CAMPAIGN_SOURCE_TYPE = 'META_ADS'/);
  assert.doesNotMatch(source, /<select name="sourceType">/);
  assert.doesNotMatch(source, /CAMPAIGN_SOURCE_OPTIONS/);
  assert.match(source, /sourceType: CAMPAIGN_SOURCE_TYPE/);
});

test('dashboard de campañas incluye filtros, embudo y metadata Meta sin asociar', () => {
  assert.match(source, /function renderCampaignFilters/);
  assert.match(source, /function renderCampaignFunnel/);
  assert.match(source, /function renderUnmatchedMetaCandidates/);
  assert.match(source, /Metadata Meta sin campaña asociada/);
  assert.match(source, /unmatchedMetaCandidates/);
});
