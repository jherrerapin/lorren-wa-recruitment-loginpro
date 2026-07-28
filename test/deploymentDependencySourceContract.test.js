import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';


test('la biometría queda fijada mientras se regenera el lockfile', () => {
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));

  assert.equal(packageJson.dependencies['@vladmandic/human'], '3.3.6');
  assert.equal(fs.existsSync('package-lock.json'), false);
  assert.equal(fs.existsSync('nixpacks.toml'), false);
});
