import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';


test('Railpack sincroniza el lockfile antes de la instalación reproducible', () => {
  const config = JSON.parse(fs.readFileSync('railpack.json', 'utf8'));
  const commands = config?.steps?.install?.commands;

  assert.deepEqual(commands, [
    'npm install --package-lock-only --ignore-scripts --no-audit --no-fund',
    'npm ci --ignore-scripts --no-audit --no-fund'
  ]);
});
