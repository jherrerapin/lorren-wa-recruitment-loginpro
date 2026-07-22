import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/routes/webhook.js', 'utf8');

function extractFunctionSource(functionName) {
  const signature = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${functionName}\\s*\\(`);
  const match = signature.exec(source);
  assert.ok(match, `No se encontró ${functionName}`);
  const openingBrace = source.indexOf('{', source.indexOf(')', match.index) + 1);
  assert.notEqual(openingBrace, -1);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(match.index, index + 1);
  }
  throw new Error(`Cuerpo incompleto para ${functionName}`);
}

test('pauseSilentlyForManualReview delega en CandidateStateService con snapshot completo', () => {
  assert.match(source, /pauseCandidateAutomationForManualReview/);
  const functionSource = extractFunctionSource('pauseSilentlyForManualReview');
  assert.match(functionSource, /await\s+pauseCandidateAutomationForManualReview\(prisma,\s*\{/);
  for (const field of [
    'botPaused',
    'botPausedAt',
    'botPausedBy',
    'botPauseReason',
    'botResumeMode',
    'reminderScheduledFor',
    'reminderState'
  ]) {
    assert.match(functionSource, new RegExp(`${field}:\\s*candidate\\.${field}`));
  }
  assert.doesNotMatch(functionSource, /pauseInterviewFlow\s*\(/);
  assert.doesNotMatch(functionSource, /prisma\.candidate\.(?:update|updateMany)\s*\(/);
});

test('una carrera se registra antes de notificar y no reintenta', () => {
  const functionSource = extractFunctionSource('pauseSilentlyForManualReview');
  assert.match(functionSource, /transition\.count\s*!==\s*1/);
  assert.match(functionSource, /STALE_CANDIDATE_MANUAL_REVIEW_PAUSE/);
  assert.match(functionSource, /recordIntentionalSilence\s*\(/);
  assert.match(functionSource, /paused:\s*false/);
  assert.match(functionSource, /conflict:\s*true/);

  const conflictIndex = functionSource.indexOf('transition.count !== 1');
  const silenceIndex = functionSource.indexOf('recordIntentionalSilence');
  const returnIndex = functionSource.indexOf('paused: false');
  const notifyIndex = functionSource.indexOf('notifySupervisorManualReview');
  assert.ok(conflictIndex >= 0 && conflictIndex < silenceIndex);
  assert.ok(silenceIndex < returnIndex);
  assert.ok(returnIndex < notifyIndex);
  assert.equal((functionSource.match(/pauseCandidateAutomationForManualReview\s*\(/g) || []).length, 1);
});

test('la notificación al supervisor solo ocurre después de una pausa aplicada', () => {
  const functionSource = extractFunctionSource('pauseSilentlyForManualReview');
  const notifyIndex = functionSource.indexOf('notifySupervisorManualReview');
  const successIndex = functionSource.indexOf('paused: true');
  assert.ok(notifyIndex >= 0);
  assert.ok(successIndex > notifyIndex);
  assert.match(functionSource, /transition\.candidate\s*\|\|\s*candidate/);
});
