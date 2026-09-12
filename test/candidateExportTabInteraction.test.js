import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const rangeRuntime = fs.readFileSync('src/public/candidate-export-date-range.js', 'utf8');
const tabsRuntime = fs.readFileSync('src/public/candidate-vacancy-section-tabs.js', 'utf8');

test('el cambio de pestaña retira cualquier enlace heredado recreado antes de recalcular la descarga única', () => {
  const tabUpdate = tabsRuntime.match(/function updateContextualActions\(panel, activeKey\)[\s\S]*?\n  }/)?.[0] || '';

  assert.match(tabUpdate, /ensureContextualExportLink\(panel, activeKey, expectedScope\)/);
  assert.match(tabUpdate, /candidate-vacancy-tab-change/);
  assert.ok(
    tabUpdate.indexOf('ensureContextualExportLink') < tabUpdate.indexOf('candidate-vacancy-tab-change'),
    'la pestaña emite el evento después de actualizar sus acciones heredadas'
  );

  const rangeTabHandler = rangeRuntime.match(/panel\?\.addEventListener\('candidate-vacancy-tab-change'[\s\S]*?\n    }\);/)?.[0] || '';
  assert.match(rangeTabHandler, /bar\.querySelectorAll\(EXPORT_LINK_SELECTOR\)\.forEach\(\(link\) => link\.remove\(\)\)/);
  assert.match(rangeTabHandler, /syncScopeOptionState\(scopeOptions, bar, panel\)/);
  assert.match(rangeTabHandler, /refreshDownloadContext\(\)/);
  assert.ok(
    rangeTabHandler.indexOf('link.remove()') < rangeTabHandler.indexOf('refreshDownloadContext()'),
    'los enlaces heredados se retiran antes de recalcular el único botón contextual'
  );
});
