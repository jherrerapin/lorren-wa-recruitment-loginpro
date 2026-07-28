import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';


test('Nixpacks instala dependencias desde package.json cuando el lockfile está desactualizado', () => {
  const config = fs.readFileSync('nixpacks.toml', 'utf8');

  assert.match(config, /\[phases\.install\]/);
  assert.match(config, /npm install --ignore-scripts --no-audit --no-fund/);
  assert.doesNotMatch(config, /npm ci/);
});
