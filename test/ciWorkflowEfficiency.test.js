import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './payrollExcelExportPresentation.test.js';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

function section(source, startMarker, endMarker = null) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `No se encontró ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  if (endMarker) assert.notEqual(end, -1, `No se encontró ${endMarker}`);
  return source.slice(start, end);
}

test('CI conserva un único gate rápido para borradores y reserva la suite completa para validación final', () => {
  const quick = section(workflow, '  quick:', '  full-validation:');
  const full = section(workflow, '  full-validation:');

  assert.match(workflow, /types:\s*\[opened, synchronize, reopened, ready_for_review\]/);
  assert.match(workflow, /cancel-in-progress:\s*true/);

  assert.match(quick, /Validate state authority manifest/);
  assert.match(quick, /Validate Prisma schema/);
  assert.match(quick, /Check JavaScript syntax/);
  assert.match(quick, /Run integral conversational release candidate/);
  assert.match(quick, /ciWorkflowEfficiency\.test\.js/);
  assert.doesNotMatch(quick, /\bnpm test\b/);
  assert.doesNotMatch(quick, /\.ci-baseline/);

  assert.match(full, /github\.event\.pull_request\.draft == false/);
  assert.match(full, /inputs\.full_suite/);
  assert.match(full, /actions\/cache\/restore@v4/);
  assert.match(full, /actions\/cache\/save@v4/);
  assert.match(full, /npm test > current-test-output\.log/);
  assert.match(full, /steps\.baseline-cache\.outputs\.cache-hit != 'true'/);

  assert.equal((workflow.match(/runs-on:\s*ubuntu-latest/g) || []).length, 2);
});
