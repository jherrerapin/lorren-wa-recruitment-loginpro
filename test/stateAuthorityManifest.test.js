import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = path.join(repositoryRoot, 'state-authority-observed.json');

function runGit(args) {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim();
}

function extractNodeScript(workflowPath, marker) {
  const workflow = readFileSync(workflowPath, 'utf8');
  const sectionStart = workflow.indexOf(marker);
  if (sectionStart === -1) throw new Error(`No se encontró ${marker}`);
  const token = "          node <<'NODE'\n";
  const startMarker = workflow.indexOf(token, sectionStart);
  if (startMarker === -1) throw new Error(`No se encontró script Node después de ${marker}`);
  const start = startMarker + token.length;
  const end = workflow.indexOf('\n          NODE', start);
  if (end === -1) throw new Error(`No se encontró cierre Node después de ${marker}`);
  return workflow.slice(start, end)
    .split('\n')
    .map((line) => line.startsWith('          ') ? line.slice(10) : line)
    .join('\n');
}

function writeReport(payload) {
  writeFileSync(reportPath, `${JSON.stringify(payload, null, 2)}\n`);
}

test('diagnóstico temporal genera los archivos revisables de #681', () => {
  try {
    const applyWorkflow = path.join(repositoryRoot, '.github', 'workflows', 'apply-681-reuse-turn-plan.yml');
    const bootstrapWorkflow = path.join(repositoryRoot, '.github', 'workflows', 'bootstrap-681-reuse-turn-plan.yml');
    const applyScriptPath = path.join('/tmp', `apply-681-${process.pid}.js`);
    const extendScriptPath = path.join('/tmp', `extend-681-${process.pid}.js`);

    writeFileSync(applyScriptPath, `${extractNodeScript(applyWorkflow, 'Apply exact plan reuse patch')}\n`);
    writeFileSync(extendScriptPath, `${extractNodeScript(bootstrapWorkflow, 'Extend compatibility signature to full engine context')}\n`);
    execFileSync(process.execPath, [applyScriptPath], { cwd: repositoryRoot, encoding: 'utf8', stdio: 'pipe' });
    execFileSync(process.execPath, [extendScriptPath], { cwd: repositoryRoot, encoding: 'utf8', stdio: 'pipe' });

    const targetPaths = [
      'src/routes/webhook.js',
      'src/services/chatEngine.js',
      'src/services/conversationEngine.js',
      'test/conversationEngineStepAuthority.test.js'
    ];
    const files = Object.fromEntries(targetPaths.map((relativePath) => [
      relativePath,
      { contentBase64: Buffer.from(readFileSync(path.join(repositoryRoot, relativePath), 'utf8')).toString('base64') }
    ]));
    writeReport({
      kind: 'patch-681',
      mergeCommitSha: runGit(['rev-parse', 'HEAD']),
      mergeTreeSha: runGit(['rev-parse', 'HEAD^{tree}']),
      mainParentSha: runGit(['rev-parse', 'HEAD^1']),
      branchParentSha: runGit(['rev-parse', 'HEAD^2']),
      files
    });
    assert.fail('PATCH_681_ARTIFACT_READY');
  } catch (error) {
    if (error?.message === 'PATCH_681_ARTIFACT_READY') throw error;
    writeReport({
      kind: 'patch-681-error',
      message: error?.message || String(error),
      stack: error?.stack || null,
      stdout: error?.stdout || null,
      stderr: error?.stderr || null
    });
    assert.fail(`PATCH_681_ERROR: ${error?.message || error}`);
  }
});
