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
  assert.ok(
    route.indexOf('deletion.count === 0') < route.indexOf('remainingActiveBooking'),
    'La carrera debe resolverse antes de buscar reservas activas restantes.'
  );
  assert.ok(
    route.indexOf('remainingActiveBooking') < route.indexOf('tx.candidate.update'),
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

test('la asignación manual permanece fuera del alcance de esta fase', () => {
  const route = between(
    "router.post('/candidates/:id/interview-assign'",
    "router.post('/candidates/:id/status'"
  );
  assert.match(route, /await cancelCandidateBookings\(tx, candidate\.id, ['"]RESCHEDULED['"]\)/);
  assert.match(route, /await createBooking\(/);
});
