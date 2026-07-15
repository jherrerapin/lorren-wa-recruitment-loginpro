import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const schedulerSource = fs.readFileSync(new URL('../src/services/interviewScheduler.js', import.meta.url), 'utf8');

test('interviewScheduler conserva sus funciones públicas y delega las mutaciones', () => {
  assert.match(schedulerSource, /export async function createBooking\s*\(/);
  assert.match(schedulerSource, /return createScheduledInterviewBooking\(prisma,\s*\{/s);
  assert.match(schedulerSource, /export async function cancelCandidateBookings\s*\(/);
  assert.match(schedulerSource, /return cancelActiveInterviewBookings\(prisma,\s*\{/s);
});

test('RESCHEDULED en el adaptador representa solicitud y no cierra la reserva', () => {
  assert.match(schedulerSource, /if \(replacementStatus === 'RESCHEDULED'\) \{/);
  assert.match(schedulerSource, /return requestActiveInterviewBookingReschedule\(prisma, \{ candidateId \}\);/);
});

test('interviewScheduler no escribe InterviewBooking directamente', () => {
  assert.doesNotMatch(schedulerSource, /prisma\.interviewBooking\.(?:create|update|updateMany|delete|deleteMany|upsert)\s*\(/);
});

test('la selección de slots continúa filtrando únicamente reservas activas', () => {
  assert.match(schedulerSource, /ACTIVE_INTERVIEW_BOOKING_STATUSES as ACTIVE_BOOKING_STATUSES/);
  assert.match(schedulerSource, /bookings:\s*\{\s*where:\s*\{\s*status:\s*\{\s*in:\s*ACTIVE_BOOKING_STATUSES\s*\}/s);
});
