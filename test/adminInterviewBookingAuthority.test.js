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

test('la eliminación individual delega por id y candidato antes de reajustar el paso', () => {
  const route = between(
    "router.post('/interviews/:id/delete'",
    "router.post('/candidates/:id/interview-assign'"
  );
  assert.match(route, /deleteAdministrativeInterviewBooking\(tx,\s*\{/);
  assert.match(route, /bookingId:\s*booking\.id/);
  assert.match(route, /candidateId:\s*booking\.candidateId/);
  assert.match(route, /deletion\.count\s*===\s*0/);
  assert.doesNotMatch(route, /tx\.interviewBooking\.delete\s*\(/);
  const deletionIndex = route.indexOf('deletion.count === 0');
  const remainingIndex = route.indexOf('remainingActiveBooking');
  const updateIndex = route.indexOf('tx.candidate.update');

  assert.ok(deletionIndex >= 0, 'No se encontró "deletion.count === 0"');
  assert.ok(remainingIndex >= 0, 'No se encontró "remainingActiveBooking"');
  assert.ok(updateIndex >= 0, 'No se encontró "tx.candidate.update"');
  assert.ok(
    deletionIndex < remainingIndex,
    'La carrera debe resolverse antes de buscar reservas activas restantes.'
  );
  assert.ok(
    remainingIndex < updateIndex,
    'El paso solo se reajusta después de comprobar reservas activas restantes.'
  );
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

test('la asignación manual usa una sola sustitución atómica con el cliente Prisma raíz', () => {
  const route = between(
    "router.post('/candidates/:id/interview-assign'",
    "router.post('/candidates/:id/status'"
  );

  assert.doesNotMatch(source, /\bcancelCandidateBookings\b/);
  assert.doesNotMatch(route, /prisma\.\$transaction\s*\(/);
  assert.doesNotMatch(route, /interviewBooking\.findFirst\s*\(/);
  assert.doesNotMatch(route, /\btx\b/);

  const createCalls = route.match(/\bcreateBooking\s*\(/g) || [];
  assert.equal(createCalls.length, 1, 'La ruta debe llamar createBooking exactamente una vez');
  assert.match(route, /await createBooking\(\s*prisma,\s*candidate\.id,\s*candidate\.vacancyId,\s*chosenOffer\.slot\.id,\s*chosenOffer\.date,\s*!chosenOffer\.windowOk\s*\)/s);

  assert.match(route, /if \(!chosenOffer\?\.slot\)/);
  assert.match(route, /currentStep:\s*ConversationStep\.SCHEDULED/);
  assert.match(route, /currentStep:\s*ConversationStep\.SCHEDULING/);
  assert.match(route, /eventType:\s*['"]INTERVIEW_ASSIGNED['"]/);

  const availabilityIndex = route.indexOf('if (!chosenOffer?.slot)');
  const createIndex = route.indexOf('await createBooking(');
  const stepIndex = route.indexOf('currentStep: ConversationStep.SCHEDULED');
  const auditIndex = route.indexOf("eventType: 'INTERVIEW_ASSIGNED'");

  assert.ok(availabilityIndex >= 0, 'No se encontró la validación de disponibilidad');
  assert.ok(createIndex >= 0, 'No se encontró la creación canónica de la reserva');
  assert.ok(stepIndex >= 0, 'No se encontró la actualización del paso');
  assert.ok(auditIndex >= 0, 'No se encontró la auditoría administrativa');
  assert.ok(availabilityIndex < createIndex, 'La oferta debe validarse antes de crear');
  assert.ok(createIndex < stepIndex, 'La reserva debe persistirse antes de actualizar el paso');
  assert.ok(stepIndex < auditIndex, 'La auditoría debe ocurrir después de actualizar el paso');
});
