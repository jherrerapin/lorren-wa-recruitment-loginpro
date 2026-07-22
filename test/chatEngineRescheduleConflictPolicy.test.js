import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/services/chatEngine.js', 'utf8');

function extractFunction(functionName) {
  const signature = new RegExp(`(?:async\\s+)?function\\s+${functionName}\\s*\\(`);
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
  throw new Error(`Cuerpo incompleto de ${functionName}`);
}

const handler = extractFunction('handleAppointmentIntentDirectly');
const rescheduleStart = handler.indexOf("if (intent === 'reschedule_interview')");
assert.ok(rescheduleStart >= 0, 'No se encontró la rama reschedule_interview');
const rescheduleBranch = handler.slice(rescheduleStart);

test('la reserva se transiciona antes del reflejo CAS de Candidate', () => {
  const bookingIndex = handler.indexOf('applyInterviewReminderResponse');
  const candidateIndex = handler.indexOf('reflectCandidateInterviewRescheduleProgress');
  assert.ok(bookingIndex >= 0);
  assert.ok(candidateIndex > bookingIndex);
});

test('un conflicto se resuelve antes de construir la respuesta final', () => {
  const candidateIndex = rescheduleBranch.indexOf('reflectCandidateInterviewRescheduleProgress');
  const conflictIndex = rescheduleBranch.indexOf('progressTransition.count !== 1');
  const replyIndex = rescheduleBranch.indexOf('const reply =');
  assert.ok(candidateIndex >= 0);
  assert.ok(conflictIndex > candidateIndex);
  assert.ok(replyIndex > conflictIndex);
});

test('el conflicto deja trazabilidad estable y silencio controlado', () => {
  assert.match(rescheduleBranch, /STALE_CANDIDATE_RESCHEDULE_PROGRESS/);
  assert.match(rescheduleBranch, /suppressed:\s*true/);
  assert.match(rescheduleBranch, /suppressedReason:\s*['"]stale_candidate_reschedule_progress['"]/);
  assert.match(rescheduleBranch, /candidateProgressConflict:\s*true/);
});

test('la rama no vuelve a escribir Candidate directamente', () => {
  assert.doesNotMatch(rescheduleBranch, /prisma\.candidate\.(?:create|upsert|update|updateMany)\s*\(/);
});
