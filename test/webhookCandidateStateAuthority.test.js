import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/routes/webhook.js', 'utf8');

function functionBlock(content, start) {
  const startIndex = content.indexOf(start);
  assert.notEqual(startIndex, -1, `No se encontró la función: ${start}`);
  const searchFrom = startIndex + start.length;
  const nextAsyncFunction = content.indexOf('\nasync function ', searchFrom);
  const nextFunction = content.indexOf('\nfunction ', searchFrom);
  const candidates = [nextAsyncFunction, nextFunction].filter((index) => index !== -1);
  const endIndex = candidates.length ? Math.min(...candidates) : content.length;
  return content.slice(startIndex, endIndex);
}

const resumeFunction = functionBlock(
  source,
  'async function prepareCandidateForInboundAutomation'
);

test('webhook importa y delega la reanudación en CandidateStateService', () => {
  assert.match(
    source,
    /import\s*\{[\s\S]*?resumeCandidateAutomationOnInbound[\s\S]*?\}\s*from\s*'\.\.\/services\/candidateStateService\.js';/
  );
  assert.match(resumeFunction, /resumeCandidateAutomationOnInbound\(prisma,\s*\{/);
  assert.match(resumeFunction, /candidateId:\s*candidate\.id/);
  assert.match(resumeFunction, /botPaused:\s*candidate\.botPaused/);
  assert.match(resumeFunction, /botPausedAt:\s*candidate\.botPausedAt/);
  assert.match(resumeFunction, /botPausedBy:\s*candidate\.botPausedBy/);
  assert.match(resumeFunction, /botPauseReason:\s*candidate\.botPauseReason/);
  assert.match(resumeFunction, /botResumeMode:\s*candidate\.botResumeMode/);
});

test('prepareCandidateForInboundAutomation no escribe Candidate directamente', () => {
  assert.doesNotMatch(resumeFunction, /prisma\.candidate\.(?:create|createMany|upsert|update|updateMany|delete|deleteMany)\s*\(/);
  assert.doesNotMatch(source, /buildInboundResumeUpdate/);
});

test('webhook devuelve el estado resuelto por la autoridad de reanudación', () => {
  const transitionIndex = resumeFunction.indexOf('resumeCandidateAutomationOnInbound');
  const returnIndex = resumeFunction.lastIndexOf('return transition.candidate || candidate');

  assert.ok(transitionIndex >= 0);
  assert.ok(returnIndex > transitionIndex);
  assert.doesNotMatch(resumeFunction, /transition\.count\s*[=!]==?\s*1/);
});

test('preserva las decisiones puras de bloqueo y reanudación', () => {
  const blockIndex = resumeFunction.indexOf("shouldBlockAutomation(candidate, { direction: 'INBOUND' })");
  const resumePolicyIndex = resumeFunction.indexOf('shouldResumeAutomationOnInbound(candidate)');
  const authorityIndex = resumeFunction.indexOf('resumeCandidateAutomationOnInbound');

  assert.ok(blockIndex >= 0);
  assert.ok(resumePolicyIndex >= 0);
  assert.ok(authorityIndex >= 0);
  assert.ok(resumePolicyIndex > blockIndex);
  assert.ok(authorityIndex > resumePolicyIndex);
});
