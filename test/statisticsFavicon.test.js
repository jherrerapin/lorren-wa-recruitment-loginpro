import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const CANONICAL_FAVICON = '<link rel="icon" type="image/svg+xml" href="/public/favicon-loginpro.svg">';

for (const routePath of [
  'src/routes/lorenV2.js',
  'src/routes/lorenV2CvAnalysis.js',
  'src/routes/metaAdsStats.js'
]) {
  test(`${routePath} declara el favicon canónico`, () => {
    const source = fs.readFileSync(routePath, 'utf8');
    assert.match(source, new RegExp(CANONICAL_FAVICON.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
}
