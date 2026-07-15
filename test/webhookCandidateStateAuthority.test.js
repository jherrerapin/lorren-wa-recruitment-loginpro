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

const resumeFunction = between(
  source,
  'async function prepareCandidateForInboundAutomation',
  'function outboundRequestsResolvedVacancy'
);

test('webhook importa y delega la reanudación en CandidateStateService', () => {
  assert.match(
    source,
    /import \{ resumeCandidateAutomationOnInbound \} from '\.\.\/services\/candidateStateService\.js';/
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

test('solo registra reanudación cuando la comparación condicional fue aplicada', () => {
  const transitionIndex = resumeFunction.indexOf('resumeCandidateAutomationOnInbound');
  const countGuardIndex = resumeFunction.indexOf('transition.count === 1');
  const logIndex = resumeFunction.indexOf("console.info('[BOT_RESUMED_BY_INBOUND]'");
  const returnIndex = resumeFunction.lastIndexOf('return transition.candidate || candidate');

  assert.ok(transitionIndex >= 0);
  assert.ok(countGuardIndex >= 0);
  assert.ok(logIndex >= 0);
  assert.ok(returnIndex >= 0);
  assert.ok(countGuardIndex > transitionIndex, 'El log debe depender del resultado persistido.');
  assert.ok(logIndex > countGuardIndex, 'No se debe informar reanudación antes de count === 1.');
  assert.ok(returnIndex > logIndex, 'La función debe devolver el estado actual después de la comparación.');
});

test('preserva las decisiones puras de bloqueo y reanudación', () => {
  const blockIndex = resumeFunction.indexOf("shouldBlockAutomation(candidate, { direction: 'INBOUND' })");
  const resumePolicyIndex = resumeFunction.indexOf('shouldResumeAutomationOnInbound(candidate)');
  const authorityIndex = resumeFunction.indexOf('resumeCandidateAutomationOnInbound');

  assert.ok(blockIndex >= 0);
  assert.ok(resumePolicyIndex > blockIndex);
  assert.ok(authorityIndex > resumePolicyIndex);
});
