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

test('el alcance no altera eliminación física ni asignación manual pendientes', () => {
  assert.match(source, /await tx\.interviewBooking\.delete\s*\(/);
  assert.match(source, /await cancelCandidateBookings\(tx, candidate\.id, ['"]RESCHEDULED['"]\)/);
  assert.match(source, /await createBooking\(/);
});
