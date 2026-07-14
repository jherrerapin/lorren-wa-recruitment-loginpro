import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const webhookSource = fs.readFileSync(new URL('../src/routes/webhook.js', import.meta.url), 'utf8');

function extractFunction(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `No se encontró ${signature}`);
  const end = source.indexOf(nextSignature, start);
  assert.notEqual(end, -1, `No se encontró el límite ${nextSignature}`);
  return source.slice(start, end);
}

test('salida común del webhook delega persistencia y conserva lastOutboundAt', () => {
  assert.match(webhookSource, /persistOutboundConversationMessage/);
  const block = extractFunction(
    webhookSource,
    'async function saveOutboundMessage',
    'async function reply'
  );

  assert.match(block, /persistOutboundConversationMessage\(prisma,/);
  assert.doesNotMatch(block, /prisma\.message\.create\(/);
  assert.match(block, /source:\s*'bot_flow'/);
  assert.match(block, /prisma\.candidate\.update\(/);
  assert.match(block, /lastOutboundAt:\s*new Date\(\)/);
});

test('silencio intencional delega salida interna y conserva manejo tolerante de errores', () => {
  const block = extractFunction(
    webhookSource,
    'async function recordIntentionalSilence',
    'async function pauseSilentlyForManualReview'
  );

  assert.match(block, /persistOutboundConversationMessage\(prisma,/);
  assert.doesNotMatch(block, /prisma\.message\.create\(/);
  assert.match(block, /visibility:\s*'internal'/);
  assert.match(block, /neverSendToCandidate:\s*true/);
  assert.match(block, /source:\s*'bot_silence_trace'/);
  assert.match(block, /catch\s*\(error\)/);
});
