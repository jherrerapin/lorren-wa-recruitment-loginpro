import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

function readSource(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('statistics metrics are isolated in a service module', () => {
  const source = readSource('src/services/statsMetrics.js');

  assert.equal(source.includes('export function buildCampaignMetric'), true);
  assert.equal(source.includes('export function buildAggregateCampaignMetric'), true);
  assert.equal(source.includes('export function costPerResult'), true);
  assert.equal(source.includes('export function hasCompleteCoreData'), true);
  assert.equal(source.includes('export function hasCv'), true);
  assert.equal(source.includes('export function hasNoShowBooking'), true);
});

test('statistics metrics use explicit booking states for attendance metrics', () => {
  const source = readSource('src/services/statsMetrics.js');

  assert.equal(source.includes("booking.status === 'ATTENDED'"), true);
  assert.equal(source.includes("booking.status === 'NO_SHOW'"), true);
  assert.equal(source.includes('const noShow = candidates.filter(hasNoShowBooking).length'), true);
});
