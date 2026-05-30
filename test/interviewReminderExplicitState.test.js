import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldMarkNoResponse } from '../src/services/interviewLifecycle.js';

test('marca NO_RESPONSE faltando 5 minutos si no respondió al recordatorio de entrevista de 10:00 a.m. Colombia', () => {
  const booking = {
    id: 'booking-pending-reply',
    status: 'SCHEDULED',
    scheduledAt: new Date('2026-04-08T15:00:00.000Z'), // 10:00 a.m. Colombia
    reminderSentAt: new Date('2026-04-08T14:20:00.000Z'), // 9:20 a.m. Colombia
    reminderWindowClosed: true
  };

  const result = shouldMarkNoResponse(booking, {
    now: new Date('2026-04-08T14:55:00.000Z'), // 9:55 a.m. Colombia
    hasReminderReply: false
  });

  assert.equal(result, true);
});
