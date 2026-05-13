import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldMarkNoResponse } from '../src/services/interviewLifecycle.js';

test('no cambia estado de entrevista automaticamente por falta de respuesta al recordatorio', () => {
  const booking = {
    id: 'booking-pending-reply',
    status: 'SCHEDULED',
    scheduledAt: new Date('2026-04-08T22:00:00.000Z'),
    reminderSentAt: new Date('2026-04-08T21:00:00.000Z'),
    reminderWindowClosed: true
  };

  const result = shouldMarkNoResponse(booking, {
    now: new Date('2026-04-08T21:55:00.000Z'),
    hasReminderReply: false
  });

  assert.equal(result, false);
});
