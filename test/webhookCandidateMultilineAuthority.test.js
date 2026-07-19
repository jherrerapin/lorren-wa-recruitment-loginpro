import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/routes/webhook.js', 'utf8');

function between(content, start, end) {
  const startIndex = content.indexOf(start);
  assert.notEqual(startIndex, -1, `No se encontró el marcador inicial: ${start}`);
  const endIndex = content.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `No se encontró el marcador final: ${end}`);
  return content.slice(startIndex, endIndex);
}

const scheduleFunction = between(
  source,
  'async function scheduleMultilineWindow',
  'async function fetchPendingTextBatch'
);
const acquireFunction = between(
  source,
  'async function tryAcquireMultilineProcessing',
  'async function markPotentialDuplicateByDocument'
);

test('webhook importa y delega ambos contratos multilinea', () => {
  assert.match(
    source,
    /import\s*\{[\s\S]*acquireCandidateMultilineBatch[\s\S]*scheduleCandidateMultilineWindow[\s\S]*\}\s*from '\.\.\/services\/candidateStateService\.js';/
  );
  assert.match(scheduleFunction, /getMultilineWindowMs\s*\(\s*context\s*\)/);
  assert.match(scheduleFunction, /scheduleCandidateMultilineWindow\s*\(\s*prisma\s*,\s*\{/);
  assert.match(scheduleFunction, /candidateId\s*,/);
  assert.match(scheduleFunction, /windowUntil/);
  assert.match(acquireFunction, /acquireCandidateMultilineBatch\s*\(\s*prisma\s*,\s*\{/);
  assert.match(acquireFunction, /expectedBatchVersion\s*:\s*batchVersion/);
  assert.match(acquireFunction, /now\s*:\s*new\s+Date\s*\(\s*\)/);
  assert.match(acquireFunction, /return\s+acquired\.count\s*===\s*1/);
});

test('los wrappers multilinea no escriben Candidate directamente', () => {
  const directWrite = /prisma\.candidate\.(?:create|createMany|upsert|update|updateMany|delete|deleteMany)\s*\(/;
  assert.doesNotMatch(scheduleFunction, directWrite);
  assert.doesNotMatch(acquireFunction, directWrite);
});

test('el webhook conserva tiempos, espera y consolidación fuera de la autoridad', () => {
  const schedulingCall = source.indexOf('const scheduling = await scheduleMultilineWindow');
  const sleepCall = source.indexOf('await sleep(scheduling.windowMs)', schedulingCall);
  const acquireCall = source.indexOf('const stillOwner = await tryAcquireMultilineProcessing', sleepCall);
  const pendingBatchCall = source.indexOf('const pendingBatch = await fetchPendingTextBatch', acquireCall);
  const consolidateCall = source.indexOf('const consolidatedText = consolidateTextMessages', pendingBatchCall);

  assert.ok(schedulingCall >= 0);
  assert.ok(sleepCall > schedulingCall);
  assert.ok(acquireCall > sleepCall);
  assert.ok(pendingBatchCall > acquireCall);
  assert.ok(consolidateCall > pendingBatchCall);
});
