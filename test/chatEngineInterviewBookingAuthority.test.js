import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  buildInterviewAttendanceConfirmedReply,
  buildInterviewCancellationReply
} from '../src/services/naturalReply.js';

const source = fs.readFileSync('src/services/chatEngine.js', 'utf8');

function between(start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `No se encontró el marcador inicial: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `No se encontró el marcador final: ${end}`);
  return source.slice(startIndex, endIndex);
}

const handler = between(
  'async function handleAppointmentIntentDirectly',
  'async function analyzePausedVacancyConsent'
);

const confirmStart = handler.indexOf("if (intent === 'confirm_attendance')");
const cancelStart = handler.indexOf("if (intent === 'cancel_interview')");
const rescheduleStart = handler.indexOf("if (intent === 'reschedule_interview')");
assert.ok(confirmStart >= 0 && cancelStart > confirmStart && rescheduleStart > cancelStart);
const confirmBranch = handler.slice(confirmStart, cancelStart);
const cancelBranch = handler.slice(cancelStart, rescheduleStart);

test('chatEngine delega las respuestas de entrevista en la autoridad compartida', () => {
  assert.match(source, /applyInterviewReminderResponse/);
  assert.match(handler, /applyInterviewReminderResponse\(prisma,\s*\{/);
  assert.match(handler, /bookingId:\s*booking\.id/);
  assert.match(handler, /currentStatus:\s*booking\.status/);
  assert.match(handler, /responseText:\s*inboundText/);
  assert.match(handler, /intent/);
});

test('naturalReply conserva los textos determinísticos canónicos de entrevista', () => {
  assert.equal(
    buildInterviewAttendanceConfirmedReply('viernes a las 10:00'),
    'Perfecto, gracias por confirmar asistencia. Te esperamos viernes a las 10:00.'
  );
  assert.equal(
    buildInterviewAttendanceConfirmedReply(),
    'Perfecto, gracias por confirmar asistencia. Te esperamos en el horario acordado.'
  );
  assert.equal(
    buildInterviewCancellationReply(),
    'Listo, ya registré la cancelación de tu entrevista. Si más adelante deseas retomarla, me escribes por aquí.'
  );
});

test('chatEngine usa los builders compartidos para confirmación y cancelación', () => {
  assert.match(
    confirmBranch,
    /buildInterviewAttendanceConfirmedReply\(\s*formatInterviewDate\(new Date\(booking\.scheduledAt\)\)\s*\)/
  );
  assert.doesNotMatch(confirmBranch, /Perfecto, gracias por confirmar asistencia\. Te esperamos/);
  assert.match(cancelBranch, /reply:\s*buildInterviewCancellationReply\(\)/);
  assert.doesNotMatch(cancelBranch, /Listo, ya registré la cancelación de tu entrevista/);
});

test('chatEngine no escribe InterviewBooking directamente', () => {
  assert.doesNotMatch(source, /prisma\.interviewBooking\.(?:create|createMany|upsert|update|updateMany|delete|deleteMany)\s*\(/);
});

test('una carrera no informa una transición de entrevista como aplicada', () => {
  assert.match(handler, /transition\.count\s*!==\s*1/);
  assert.match(handler, /return\s+null/);
});

test('la reprogramación conserva la reserva, busca alternativa y delega el reflejo del candidato', () => {
  assert.doesNotMatch(handler, /status:\s*['"]RESCHEDULED['"]/);

  const rescheduleBranch = handler.slice(rescheduleStart);
  const alternativeIndex = rescheduleBranch.indexOf('getNextAvailableSlotAfter');
  const progressIndex = rescheduleBranch.indexOf('reflectCandidateInterviewRescheduleProgress');
  const replyIndex = rescheduleBranch.indexOf('const reply =');

  assert.ok(alternativeIndex >= 0, 'No se encontró la búsqueda del horario alternativo.');
  assert.ok(progressIndex >= 0, 'No se encontró la autoridad de progreso del candidato.');
  assert.ok(replyIndex >= 0, 'No se encontró la construcción de la respuesta final.');
  assert.ok(alternativeIndex < progressIndex, 'La búsqueda de alternativa debe conservar su orden previo.');
  assert.ok(progressIndex < replyIndex, 'El CAS debe resolverse antes de construir la respuesta final.');
  assert.match(rescheduleBranch, /interviewOffer:\s*alternative\?\.slot\s*\?\s*alternative\s*:\s*null/);
  assert.doesNotMatch(rescheduleBranch, /prisma\.candidate\.update\s*\(/);
});

test('la reserva se transiciona antes del CAS y un conflicto suprime la respuesta', () => {
  const bookingTransitionIndex = handler.indexOf('applyInterviewReminderResponse');
  const progressIndex = handler.indexOf('reflectCandidateInterviewRescheduleProgress');

  assert.ok(bookingTransitionIndex >= 0 && progressIndex > bookingTransitionIndex);
  assert.match(handler, /STALE_CANDIDATE_RESCHEDULE_PROGRESS/);
  assert.match(handler, /suppressed:\s*true/);
  assert.match(handler, /suppressedReason:\s*['"]stale_candidate_reschedule_progress['"]/);
  assert.match(handler, /candidateProgressConflict:\s*true/);
});

test('cancelación delega la limpieza del recordatorio y conserva la respuesta canónica', () => {

  assert.match(cancelBranch, /reflectCandidateInterviewCancellationReminder/);
  assert.match(cancelBranch, /STALE_CANDIDATE_CANCELLATION_REMINDER/);
  assert.match(cancelBranch, /candidateReminderConflict/);
  assert.match(cancelBranch, /buildInterviewCancellationReply\(\)/);
  assert.doesNotMatch(cancelBranch, /prisma\.candidate\.update\s*\(/);
  assert.doesNotMatch(cancelBranch, /suppressed:\s*true/);
});
