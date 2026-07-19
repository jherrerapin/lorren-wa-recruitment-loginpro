import fs from 'node:fs';

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index === -1) throw new Error(`${label}_source_not_found`);
  if (source.indexOf(before, index + before.length) !== -1) throw new Error(`${label}_source_not_unique`);
  return `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}

const servicePath = 'src/services/candidateStateService.js';
const testPath = 'test/candidateMultilineStateService.test.js';
const workflowPath = '.github/workflows/apply-candidate-multiline-validation.yml';
const scriptPath = 'scripts/apply-candidate-multiline-validation.mjs';

let service = fs.readFileSync(servicePath, 'utf8');
service = replaceOnce(
  service,
  `function requireMultilineWindowMs(value) {
  if (value === null || typeof value === 'boolean' || String(value).trim() === '') {
    throw new TypeError('candidate_multiline_window_ms_invalid');
  }
  const windowMs = Number(value);
  if (!Number.isFinite(windowMs) || windowMs < 0) {
    throw new TypeError('candidate_multiline_window_ms_invalid');
  }
  return windowMs;
}`,
  `function requireMultilineWindowMs(value) {
  if (
    (typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && value.trim() === '')
  ) {
    throw new TypeError('candidate_multiline_window_ms_invalid');
  }
  const windowMs = Number(value);
  if (!Number.isFinite(windowMs) || windowMs < 0) {
    throw new TypeError('candidate_multiline_window_ms_invalid');
  }
  return windowMs;
}`,
  'window_ms_validation'
);
service = replaceOnce(
  service,
  `function requireMultilineBatchVersion(value) {
  if (value === null || typeof value === 'boolean' || String(value).trim() === '') {
    throw new TypeError('candidate_multiline_batch_version_invalid');
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new TypeError('candidate_multiline_batch_version_invalid');
  }
  return version;
}`,
  `function requireMultilineBatchVersion(value) {
  if (
    (typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && value.trim() === '')
  ) {
    throw new TypeError('candidate_multiline_batch_version_invalid');
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new TypeError('candidate_multiline_batch_version_invalid');
  }
  return version;
}`,
  'batch_version_validation'
);
fs.writeFileSync(servicePath, service);

let tests = fs.readFileSync(testPath, 'utf8');
tests = replaceOnce(
  tests,
  `  await assert.rejects(
    () => scheduleCandidateMultilineWindow(client, { candidateId: initialCandidate.id, windowMs: Number.NaN }),
    /candidate_multiline_window_ms_invalid/
  );`,
  `  await assert.rejects(
    () => scheduleCandidateMultilineWindow(client, { candidateId: initialCandidate.id, windowMs: Number.NaN }),
    /candidate_multiline_window_ms_invalid/
  );
  await assert.rejects(
    () => scheduleCandidateMultilineWindow(client, { candidateId: initialCandidate.id, windowMs: [2500] }),
    /candidate_multiline_window_ms_invalid/
  );
  await assert.rejects(
    () => scheduleCandidateMultilineWindow(client, { candidateId: initialCandidate.id, windowMs: { value: 2500 } }),
    /candidate_multiline_window_ms_invalid/
  );`,
  'window_ms_regressions'
);
tests = replaceOnce(
  tests,
  `  await assert.rejects(
    () => acquireCandidateMultilineBatch(client, {
      candidateId: initialCandidate.id,
      expected: { multilineBatchVersion: 1.5 }
    }),
    /candidate_multiline_batch_version_invalid/
  );`,
  `  await assert.rejects(
    () => acquireCandidateMultilineBatch(client, {
      candidateId: initialCandidate.id,
      expected: { multilineBatchVersion: 1.5 }
    }),
    /candidate_multiline_batch_version_invalid/
  );
  await assert.rejects(
    () => acquireCandidateMultilineBatch(client, {
      candidateId: initialCandidate.id,
      expected: { multilineBatchVersion: [4] }
    }),
    /candidate_multiline_batch_version_invalid/
  );
  await assert.rejects(
    () => acquireCandidateMultilineBatch(client, {
      candidateId: initialCandidate.id,
      expected: { multilineBatchVersion: { value: 4 } }
    }),
    /candidate_multiline_batch_version_invalid/
  );`,
  'batch_version_regressions'
);
fs.writeFileSync(testPath, tests);

fs.rmSync(workflowPath, { force: true });
fs.rmSync(scriptPath, { force: true });
