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

const helper = between(source, 'async function applyActiveInterviewResponse', 'async function loadVacancyContext');
const scheduling = between(
  source,
  "if ((candidate.currentStep === ConversationStep.SCHEDULING || candidate.currentStep === ConversationStep.SCHEDULED) && currentVacancy && isSchedulingEligibleCandidate(candidate, currentVacancy))",
  'if (candidate.currentStep === ConversationStep.ASK_CV'
);
const cancelBranch = between(scheduling, "if (interviewIntent === 'cancel_interview')", "if (interviewIntent === 'reschedule_interview'");
const rescheduleBranch = between(scheduling, "if (interviewIntent === 'reschedule_interview'", "if (interviewIntent === 'confirm_attendance')");
const confirmBranch = between(scheduling, "if (interviewIntent === 'confirm_attendance')", 'if (candidate.currentStep === ConversationStep.SCHEDULING && isSchedulingConfirmationIntent(cleanText))');
const initialBookingBranch = between(
  scheduling,
  'if (candidate.currentStep === ConversationStep.SCHEDULING && isSchedulingConfirmationIntent(cleanText))',
  'if (candidate.currentStep === ConversationStep.SCHEDULED && isSchedulingConfirmationIntent(cleanText))'
);

test('webhook delega respuestas de reserva exacta en la autoridad compartida', () => {
  assert.match(source, /import \{ applyInterviewReminderResponse \} from '\.\.\/services\/interviewBookingStateService\.js';/);
  assert.match(helper, /applyInterviewReminderResponse\(prisma,\s*\{/);
  assert.match(helper, /bookingId:\s*activeBooking\.id/);
  assert.match(helper, /currentStatus:\s*activeBooking\.status/);
  assert.match(helper, /responseText/);
  assert.match(helper, /intent/);
  assert.match(cancelBranch, /applyActiveInterviewResponse\([^;]+['"]cancel_interview['"]\)/s);
  assert.match(rescheduleBranch, /applyActiveInterviewResponse\([^;]+['"]reschedule_interview['"]\)/s);
  assert.match(confirmBranch, /applyActiveInterviewResponse\([^;]+['"]confirm_attendance['"]\)/s);
});

test('webhook no escribe InterviewBooking directamente', () => {
  assert.doesNotMatch(source, /prisma\.interviewBooking\.(?:create|createMany|upsert|update|updateMany|delete|deleteMany)\s*\(/);
  assert.doesNotMatch(scheduling, /status:\s*['"](?:RESCHEDULED|CANCELLED|CONFIRMED)['"]/);
});

test('reserva ausente o carrera producen silencio trazado antes de efectos posteriores', () => {
  const transitionIndex = helper.indexOf('applyInterviewReminderResponse');
  const countIndex = helper.indexOf('transition.count !== 1');
  const silenceIndex = helper.lastIndexOf('recordIntentionalSilence');
  const returnIndex = helper.lastIndexOf('return null');
  assert.ok(transitionIndex >= 0 && countIndex > transitionIndex);
  assert.ok(silenceIndex > countIndex, 'La carrera debe registrar silencio intencional.');
  assert.ok(returnIndex > silenceIndex, 'La carrera debe terminar sin éxito.');
});

test('cancelación persiste antes de limpiar candidato y responder', () => {
  const authorityIndex = cancelBranch.indexOf('applyActiveInterviewResponse');
  const candidateIndex = cancelBranch.indexOf('prisma.candidate.update');
  const replyIndex = cancelBranch.indexOf('return reply');
  assert.ok(authorityIndex >= 0 && candidateIndex > authorityIndex);
  assert.ok(replyIndex > candidateIndex);
  assert.match(cancelBranch, /Listo, ya registré la cancelación de tu entrevista\. Si más adelante deseas retomarla, me escribes por aquí\./);
  assert.match(cancelBranch, /source:\s*['"]interview_booking_cancel['"]/);
});

test('reprogramación distingue reserva activa de una oferta pendiente', () => {
  const activeGuardIndex = rescheduleBranch.indexOf('if (activeBooking?.id && activeBooking?.status)');
  const authorityIndex = rescheduleBranch.indexOf('applyActiveInterviewResponse');
  const missingBookingIndex = rescheduleBranch.indexOf("else if (interviewIntent === 'reschedule_interview')");
  const silenceIndex = rescheduleBranch.indexOf('recordIntentionalSilence', missingBookingIndex);
  const noSlotIndex = rescheduleBranch.indexOf('if (!nextSlot?.slot)');
  const pauseIndex = rescheduleBranch.indexOf('pauseInterviewFlow');
  const candidateIndex = rescheduleBranch.indexOf('prisma.candidate.update');

  assert.ok(activeGuardIndex >= 0 && authorityIndex > activeGuardIndex);
  assert.ok(missingBookingIndex > authorityIndex && silenceIndex > missingBookingIndex);
  assert.ok(noSlotIndex > silenceIndex, 'La oferta pendiente debe continuar hacia la resolución del siguiente slot.');
  assert.ok(pauseIndex > authorityIndex);
  assert.ok(candidateIndex > authorityIndex);
  assert.doesNotMatch(rescheduleBranch, /RESCHEDULED/);
  assert.match(rescheduleBranch, /En este momento no tengo un siguiente horario válido para ofrecerte\. El equipo te contactará para ayudarte con la reprogramación\./);
  assert.match(rescheduleBranch, /buildInterviewReplyPayload\(body, ['"]interview_reschedule['"]/);
});

test('confirmación de asistencia persiste antes de responder y conserva texto', () => {
  const authorityIndex = confirmBranch.indexOf('applyActiveInterviewResponse');
  const replyIndex = confirmBranch.indexOf('return reply');
  assert.ok(authorityIndex >= 0 && replyIndex > authorityIndex);
  assert.match(confirmBranch, /Perfecto, gracias por confirmar asistencia\. Te esperamos/);
  assert.match(confirmBranch, /source:\s*['"]interview_attendance_confirmed['"]/);
});

test('aceptación inicial usa una sola creación atómica después del guard', () => {
  const guardIndex = initialBookingBranch.indexOf('evaluateSchedulingGuard');
  const createIndex = initialBookingBranch.indexOf('createBooking(');
  const candidateIndex = initialBookingBranch.indexOf('prisma.candidate.update');
  const replyIndex = initialBookingBranch.lastIndexOf('return reply');
  assert.ok(guardIndex >= 0 && createIndex > guardIndex);
  assert.equal((initialBookingBranch.match(/createBooking\(/g) || []).length, 1);
  assert.doesNotMatch(initialBookingBranch, /cancelCandidateBookings/);
  assert.ok(candidateIndex > createIndex);
  assert.ok(replyIndex > candidateIndex);
  assert.match(initialBookingBranch, /source|interview_booking_confirmation/);
});
