import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/services/chatEngine.js', 'utf8');

function between(start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `No se encontró el marcador inicial: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `No se encontró el marcador final: ${end}`);
  return source.slice(startIndex, endIndex);
}

const guard = between(
  'async function guardPausedVacancy',
  'function latestOutboundWasManualHumanWithoutLaterInbound'
);

test('guardPausedVacancy delega las tres decisiones canónicas', () => {
  assert.match(source, /applyCandidatePausedVacancyDecision/);
  assert.match(guard, /CANDIDATE_PAUSED_VACANCY_ACTIONS\.REGISTRATION_OFFERED/);
  assert.match(guard, /CANDIDATE_PAUSED_VACANCY_ACTIONS\.FUTURE_PROFILE_ACCEPTED/);
  assert.match(guard, /CANDIDATE_PAUSED_VACANCY_ACTIONS\.FUTURE_PROFILE_DECLINED/);
  assert.doesNotMatch(guard, /prisma\.candidate\.(?:update|updateMany)\s*\(/);
});

test('el snapshot incluye paso, vacante, modo y recordatorio', () => {
  assert.match(guard, /currentStep,/);
  assert.match(guard, /vacancyId:\s*candidate\?\.vacancyId\s*\?\?\s*null/);
  assert.match(guard, /botResumeMode:\s*candidate\?\.botResumeMode\s*\?\?\s*null/);
  assert.match(guard, /reminderScheduledFor:\s*candidate\?\.reminderScheduledFor\s*\?\?\s*null/);
  assert.match(guard, /reminderState:\s*candidate\?\.reminderState\s*\?\?\s*['"]NONE['"]/);
});

test('una carrera se registra y devuelve silencio controlado', () => {
  assert.match(guard, /STALE_CANDIDATE_PAUSED_VACANCY_DECISION/);
  assert.match(guard, /transition\.count\s*===\s*1/);
  assert.match(guard, /suppressed:\s*true/);
  assert.match(guard, /suppressedReason:\s*['"]stale_candidate_paused_vacancy_decision['"]/);
  assert.match(guard, /pausedVacancyDecisionConflict:\s*true/);
  assert.match(guard, /if\s*\(!applied\.applied\)\s*return\s+applied\.result/);
});

test('clasificación, umbral y textos visibles permanecen iguales', () => {
  assert.match(guard, /consent\.confidence\s*>=\s*0\.68/);
  assert.match(guard, /consent\.decision\s*===\s*['"]accept['"]/);
  assert.match(guard, /consent\.decision\s*===\s*['"]decline['"]/);
  assert.match(guard, /pausedRegistrationMessage\(applied\.candidate,\s*vacancy\)/);
  assert.match(guard, /Entendido, gracias por escribirnos\. Puedes volver a escribirnos más adelante para revisar nuevas aperturas\./);
  assert.match(guard, /reason:\s*['"]ambiguous['"]/);
  assert.match(guard, /reason:\s*['"]requested['"]/);
});

test('cada respuesta se construye después del CAS correspondiente', () => {
  const acceptStart = guard.indexOf('CANDIDATE_PAUSED_VACANCY_ACTIONS.FUTURE_PROFILE_ACCEPTED');
  const acceptReply = guard.indexOf('pausedRegistrationMessage(applied.candidate, vacancy)', acceptStart);
  const declineStart = guard.indexOf('CANDIDATE_PAUSED_VACANCY_ACTIONS.FUTURE_PROFILE_DECLINED');
  const declineReply = guard.indexOf('Entendido, gracias por escribirnos.', declineStart);
  const offerStart = guard.indexOf('CANDIDATE_PAUSED_VACANCY_ACTIONS.REGISTRATION_OFFERED');
  const offerReply = guard.indexOf('reply: pausedVacancyMessage(vacancy)', offerStart);

  assert.ok(acceptStart >= 0 && acceptReply > acceptStart);
  assert.ok(declineStart >= 0 && declineReply > declineStart);
  assert.ok(offerStart >= 0 && offerReply > offerStart);
});
