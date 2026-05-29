import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('recruitment dashboard renders vacancy tabs inside active city', () => {
  const view = fs.readFileSync('src/views/list.ejs', 'utf8');

  assert.match(view, /activeCityData\.vacancies\.length > 1/);
  assert.match(view, /class="vacancy-tabs"/);
  assert.match(view, /data-vacancy-tab="<%= tabVacancy\.id %>"/);
  assert.match(view, /class="vacancy-card vacancy-panel"/);
  assert.match(view, /data-vacancy-panel="<%= v\.id %>"/);
  assert.match(view, /function activateVacancy/);
  assert.match(view, /window\.location\.hash\.startsWith\('#vacancy-'\)/);
});

test('recruitment dashboard exposes vacancy filters for dev and normalizes duplicated option variants', () => {
  const view = fs.readFileSync('src/views/list.ejs', 'utf8');

  assert.doesNotMatch(view, /if \(role === 'admin'\) \{ %>\s*<form method="get" action="\/admin" class="filter-strip vacancy-filter-bar">/);
  assert.match(view, /function normalizeFilterOptionKey\(value\)/);
  assert.match(view, /\.normalize\('NFD'\)/);
  assert.match(view, /replace\(\/\[\\u0300-\\u036f\]\/g, ''\)/);
  assert.match(view, /function normalizeFilterOptionLabel\(value\)/);
  assert.match(view, /const key = normalizeFilterOptionKey\(label\);/);
  assert.match(view, /normalizeFilterOptionKey\(candidateFilterValue\(candidate, field, vacancyOrCity\)\) === normalizeFilterOptionKey\(filters\[field\]\)/);
});
