import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const encoded = [1, 2, 3, 4, 5]
  .map((index) => readFileSync(`.tmp681/chunk${String(index).padStart(2, '0')}.txt`, 'utf8').trim())
  .join('');
let runner = Buffer.from(encoded, 'base64').toString('utf8');
const stagingMarker = "run('git', ['add', '-A']);";
if (!runner.includes(stagingMarker)) throw new Error('No se encontró el punto de limpieza del runner #681.');
runner = runner.replace(
  stagingMarker,
  "rmSync('.tmp681', { recursive: true, force: true });\nrun('git', ['add', '-A']);"
);
const runnerPath = `/tmp/run-681-${process.pid}.mjs`;
writeFileSync(runnerPath, runner, 'utf8');
execFileSync(process.execPath, [runnerPath], {
  env: { ...process.env, HEAD_REF: process.env.HEAD_REF || 'fix/631-structured-age-evidence' },
  stdio: 'inherit'
});
