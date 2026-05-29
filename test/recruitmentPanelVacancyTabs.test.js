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
