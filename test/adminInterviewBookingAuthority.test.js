import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('src/routes/admin.js', 'utf8');

function between(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `No se encontró el marcador inicial: ${start}`);
  assert.notEqual(endIndex, -1, `No se encontró el marcador final: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('la ruta de estado administrativo delega en la autoridad sin escritura directa', () => {
  const route = between(
    "router.post('/interviews/:id/status'",
    "router.post('/interviews/:id/manual-reminder'"
  );
  assert.match(route, /applyAdministrativeInterviewBookingAction\(prisma/);
  assert.match(route, /transition\.requiresReplacement/);
  assert.match(route, /!transition\.persisted/);
  assert.match(route, /logCandidateAdminEvent\(prisma/);
  assert.doesNotMatch(route, /prisma\.interviewBooking\.update\s*\(/);
  assert.doesNotMatch(route, /status:\s*['"]RESCHEDULED['"]/);
});

test('el recordatorio manual usa solo los estados activos canónicos', () => {
  const route = between(
    "router.post('/interviews/:id/manual-reminder'",
    "router.post('/interviews/:id/delete'"
  );
  assert.match(route, /ACTIVE_INTERVIEW_BOOKING_STATUSES\.includes\(booking\.status\)/);
  assert.doesNotMatch(route, /ACTIVE_BOOKING_STATUSES\.includes\(booking\.status\)/);
});

test('la eliminación individual refleja SCHEDULING sin escritura directa de Candidate', () => {
  const route = between(
    "router.post('/interviews/:id/delete'",
    "router.post('/candidates/:id/interview-assign'"
  );
  assert.match(route, /deleteAdministrativeInterviewBooking\(tx,\s*\{/);
  assert.match(route, /bookingId:\s*booking\.id/);
  assert.match(route, /candidateId:\s*booking\.candidateId/);
  assert.match(route, /deletion\.count\s*===\s*0/);
  assert.match(route, /shouldReflectProgress:\s*!remainingActiveBooking/);
  assert.match(route, /reflectCandidateAdminInterviewProgress\(prisma,\s*\{/);
  assert.match(route, /CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS\.LAST_BOOKING_DELETED/);
  assert.match(route, /expected:\s*\{\s*currentStep:\s*booking\.candidate\.currentStep\s*\}/);
  assert.doesNotMatch(route, /(?:prisma|tx)\.candidate\.(?:update|updateMany)\s*\(/);
  assert.doesNotMatch(route, /nextStep\s*:/);

  const deletionIndex = route.indexOf('deleteAdministrativeInterviewBooking(tx');
  const remainingIndex = route.indexOf('remainingActiveBooking');
  const reflectionIndex = route.indexOf('reflectCandidateAdminInterviewProgress(prisma');
  assert.ok(deletionIndex >= 0 && deletionIndex < remainingIndex);
  assert.ok(remainingIndex < reflectionIndex);
});

test('la eliminación del candidato conserva el orden mensajes, reservas y candidato', () => {
  const route = between(
    "router.post('/candidates/:id/delete'",
    "router.post('/candidates/:id/edit'"
  );
  assert.match(route, /deleteCandidateInterviewBookings\(tx,\s*\{/);
  assert.match(route, /candidateId:\s*candidate\.id/);
  assert.doesNotMatch(route, /tx\.interviewBooking\.deleteMany\s*\(/);

  const messagesIndex = route.indexOf('deleteConversationMessagesForCandidate(tx');
  const bookingsIndex = route.indexOf('deleteCandidateInterviewBookings(tx');
  const candidateIndex = route.indexOf('tx.candidate.delete');
  assert.ok(messagesIndex >= 0 && messagesIndex < bookingsIndex);
  assert.ok(bookingsIndex < candidateIndex);
});

test('la asignación manual crea una reserva y refleja SCHEDULED mediante CAS', () => {
  const route = between(
    "router.post('/candidates/:id/interview-assign'",
    "router.post('/candidates/:id/status'"
  );

  assert.doesNotMatch(source, /\bcancelCandidateBookings\b/);
  assert.doesNotMatch(route, /prisma\.\$transaction\s*\(/);
  assert.doesNotMatch(route, /interviewBooking\.findFirst\s*\(/);
  assert.doesNotMatch(route, /\btx\b/);
  assert.doesNotMatch(route, /prisma\.candidate\.(?:update|updateMany)\s*\(/);
  assert.doesNotMatch(route, /manual_interview_assign_step_update_fallback/);
  assert.doesNotMatch(route, /nextStep\s*:/);

  const createCalls = route.match(/\bcreateBooking\s*\(/g) || [];
  assert.equal(createCalls.length, 1, 'La ruta debe llamar createBooking exactamente una vez');
  assert.match(route, /await createBooking\(\s*prisma,\s*candidate\.id,\s*candidate\.vacancyId,\s*chosenOffer\.slot\.id,\s*chosenOffer\.date,\s*!chosenOffer\.windowOk\s*\)/s);
  assert.match(route, /currentStep:\s*true/);
  assert.match(route, /reflectCandidateAdminInterviewProgress\(prisma,\s*\{/);
  assert.match(route, /CANDIDATE_ADMIN_INTERVIEW_PROGRESS_ACTIONS\.MANUAL_BOOKING_CREATED/);
  assert.match(route, /expected:\s*\{\s*currentStep:\s*candidate\.currentStep\s*\}/);
  assert.match(route, /eventType:\s*['"]INTERVIEW_ASSIGNED['"]/);

  const availabilityIndex = route.indexOf('if (!chosenOffer?.slot)');
  const createIndex = route.indexOf('await createBooking(');
  const reflectionIndex = route.indexOf('reflectCandidateAdminInterviewProgress(prisma');
  const auditIndex = route.indexOf("eventType: 'INTERVIEW_ASSIGNED'");
  assert.ok(availabilityIndex >= 0 && availabilityIndex < createIndex);
  assert.ok(createIndex < reflectionIndex);
  assert.ok(reflectionIndex < auditIndex);
});
