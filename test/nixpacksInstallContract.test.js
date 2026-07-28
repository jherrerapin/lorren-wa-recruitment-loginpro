import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';


test('Nixpacks usa el instalador de despliegue compatible con el lockfile heredado', () => {
  const config = fs.readFileSync('nixpacks.toml', 'utf8');
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));

  assert.match(config, /\[phases\.install\]/);
  assert.match(config, /npm run install:deployment/);
  assert.equal(
    packageJson.scripts['install:deployment'],
    'npm install --ignore-scripts --no-audit --no-fund'
  );
  assert.doesNotMatch(config, /npm ci/);
});
