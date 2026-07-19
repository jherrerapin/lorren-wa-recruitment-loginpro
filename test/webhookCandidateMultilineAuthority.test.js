import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/routes/webhook.js', 'utf8');

function between(content, start, end) {
  const startIndex = content.indexOf(start);
  assert.notEqual(startIndex, -1, 'No se encontró el marcador inicial: ' + start);
  const endIndex = content.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, 'No se encontró el marcador final: ' + end);
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
  assert.match(source, /acquireCandidateMultilineBatch/);
  assert.match(source, /scheduleCandidateMultilineWindow/);
  assert.match(scheduleFunction, /getMultilineWindowMs(context)/);
  assert.match(scheduleFunction, /scheduleCandidateMultilineWindow(prisma,s*{/);
  assert.match(scheduleFunction, /candidateId/);
  assert.match(scheduleFunction, /windowUntil/);
  assert.match(acquireFunction, /acquireCandidateMultilineBatch(prisma,s*{/);
  assert.match(acquireFunction, /expectedBatchVersion:s*batchVersion/);
  assert.match(acquireFunction, /now:s*new Date()/);
  assert.match(acquireFunction, /acquired.count === 1/);
});

test('los wrappers multilinea no escriben Candidate directamente', () => {
  const directWrite = /prisma.candidate.(?:create|createMany|upsert|update|updateMany|delete|deleteMany)s*(/;
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
