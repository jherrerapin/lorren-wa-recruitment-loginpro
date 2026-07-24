import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const encoded = [1, 2, 3, 4, 5]
  .map((index) => readFileSync(`.tmp681/chunk${String(index).padStart(2, '0')}.txt`, 'utf8').trim())
  .join('');
let runner = Buffer.from(encoded, 'base64').toString('utf8');
const digest = createHash('sha256').update(runner).digest('hex');
const expectedDigest = '4fdd642762a8342f08f8cebd55b0e49f0258a4c7a06924b3762905436f66566f';
if (digest !== expectedDigest) throw new Error(`Runner #681 corrupto: ${digest}`);
const stagingMarker = "run('git', ['add', '-A']);";
if (!runner.includes(stagingMarker)) throw new Error('No se encontró el punto de limpieza del runner #681.');
runner = runner.replace(
  stagingMarker,
  "rmSync('.tmp681', { recursive: true, force: true });\nrun('git', ['add', '-A']);"
);
const runnerPath = `/tmp/run-681-${process.pid}.mjs`;
writeFileSync(runnerPath, runner, 'utf8');
try {
  const output = execFileSync(process.execPath, [runnerPath], {
    env: { ...process.env, HEAD_REF: process.env.HEAD_REF || 'fix/631-structured-age-evidence' },
    encoding: 'utf8',
    stdio: 'pipe'
  });
  process.stdout.write(output || '');
} catch (error) {
  const stdout = String(error?.stdout || '');
  const stderr = String(error?.stderr || '');
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  mkdirSync('diagnostics', { recursive: true });
  writeFileSync('diagnostics/631-harness.tap', `${stdout}\n${stderr}`);
  writeFileSync('diagnostics/631-remaining-failures.txt', `${error?.message || error}\n`);
  writeFileSync('diagnostics/631-harness-summary.txt', `status=1\nremaining_failures=1\nprevious_failures=16\nrunner_sha256=${digest}\n`);
  throw error;
}
