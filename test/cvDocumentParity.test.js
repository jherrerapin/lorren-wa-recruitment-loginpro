import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runnerPath = fileURLToPath(new URL('./helpers/runCvDocumentParityCase.js', import.meta.url));
const FORBIDDEN_KEYS = new Set(['phone', 'fullName', 'documentNumber', 'body', 'prompt', 'buffer', 'cvData']);

function runMode(mode) {
  const output = execFileSync(process.execPath, [runnerPath, mode], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, USE_CONVERSATION_ENGINE: mode }
  });
  const line = output.split(/\r?\n/).findLast((item) => item.startsWith('__LORREN_CV_PARITY__'));
  assert.ok(line, `No se encontró snapshot documental para modo ${mode}`);
  return JSON.parse(line.slice('__LORREN_CV_PARITY__'.length));
}

function findForbiddenKeys(value, path = '') {
  if (Array.isArray(value)) return value.flatMap((item, index) => findForbiddenKeys(item, `${path}[${index}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const current = path ? `${path}.${key}` : key;
    return [...(FORBIDDEN_KEYS.has(key) ? [current] : []), ...findForbiddenKeys(child, current)];
  });
}

function withoutMode(snapshot) {
  const { mode, ...rest } = snapshot;
  return rest;
}

test('CV válido recorre el router documental real con paridad entre modos', () => {
  const withoutEngine = runMode('false');
  const withEngine = runMode('true');

  assert.equal(withoutEngine.mode, 'false');
  assert.equal(withEngine.mode, 'true');
  assert.deepEqual(findForbiddenKeys(withoutEngine), []);
  assert.deepEqual(findForbiddenKeys(withEngine), []);
  assert.deepEqual(withoutMode(withEngine), withoutMode(withoutEngine));

  for (const snapshot of [withoutEngine, withEngine]) {
    assert.equal(snapshot.httpStatus, 200);
    assert.equal(snapshot.candidate.status, 'REGISTRADO');
    assert.equal(snapshot.candidate.currentStep, 'DONE');
    assert.equal(snapshot.candidate.vacancyId, 'vac-post');
    assert.equal(snapshot.candidate.reminderState, 'SKIPPED');
    assert.equal(snapshot.candidate.hasCv, true);
    assert.equal(snapshot.candidate.cvMimeType, 'application/pdf');
    assert.equal(snapshot.candidate.cvOriginalNamePresent, true);
    assert.equal(snapshot.inbound.documentStored, true);
    assert.equal(snapshot.inbound.uniqueMessageCount, 1);
    assert.equal(snapshot.outbound.candidateSendCount, 1);
    assert.deepEqual(snapshot.outbound.persistedSources, ['bot_flow']);
    assert.equal(snapshot.media.metadataRequests, 1);
    assert.equal(snapshot.media.downloadRequests, 1);
    assert.equal(snapshot.media.downloaded, true);
    assert.equal(snapshot.openAi.count, 0);
    assert.deepEqual(snapshot.openAi.byType, {});
  }
});
