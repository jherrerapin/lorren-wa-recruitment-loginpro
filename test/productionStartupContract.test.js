import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const startScript = fs.readFileSync(new URL('../start.sh', import.meta.url), 'utf8');
const dockerfile = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');

test('npm start usa el mismo arranque productivo del Dockerfile', () => {
  assert.equal(packageJson.scripts.start, 'sh ./start.sh');
  assert.match(dockerfile, /CMD\s+\["\.\/start\.sh"\]/);
});

test('start.sh conserva bootstrap y levanta el worker de jobs', () => {
  assert.match(startScript, /node src\/bootstrap\.js\s*&/);
  assert.match(startScript, /node src\/workers\/jobWorker\.js\s*&/);
  assert.doesNotMatch(startScript, /node src\/server\.js\s*&/);
  assert.match(startScript, /wait \$SERVER_PID \$WORKER_PID/);
});
