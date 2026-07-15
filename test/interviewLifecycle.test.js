import test from 'node:test';
import assert from 'node:assert/strict';
import { createBooking } from '../src/services/interviewScheduler.js';
import {
  detectInterviewIntent,
  isWithinInterviewConfirmationWindow,
  shouldMarkNoResponse,
} from '../src/services/interviewLifecycle.js';

const baseBooking = {
  id: 'book-1',
  status: 'SCHEDULED',
  scheduledAt: new Date('2026-04-24T18:00:00.000Z'),
  reminderSentAt: null,
  reminderWindowClosed: false
};

test('aceptar horario crea booking SCHEDULED y no ejecuta cierre de reemplazo', async () => {
  const calls = [];
  let updateManyCalls = 0;
  const prisma = {
    interviewBooking: {
      findMany: async () => [],
      findFirst: async () => null,
      create: async ({ data }) => {
        calls.push(data);
        return { id: 'book-created', status: data.status || 'SCHEDULED', ...data };
      },
      updateMany: async () => {
        updateManyCalls += 1;
        return { count: 0 };
      }
    }
  };

  const booking = await createBooking(prisma, 'cand-1', 'vac-1', 'slot-1', new Date('2026-04-24T18:00:00.000Z'));
  assert.equal(calls.length, 1);
  assert.equal(updateManyCalls, 0);
  assert.equal(booking.status, 'SCHEDULED');
});

test('"confirmo" el día anterior no cambia a confirm_attendance aunque exista booking', () => {
  const now = new Date('2026-04-23T18:00:00.000Z');
  const intent = detectInterviewIntent({ text: 'confirmo, si voy', booking: baseBooking, now });
  assert.equal(isWithinInterviewConfirmationWindow(baseBooking, now), false);
  assert.equal(intent, 'none');
});

test('"confirmo" el mismo día de la entrevista sí detecta confirm_attendance', () => {
  const now = new Date('2026-04-24T13:00:00.000Z');
  const intent = detectInterviewIntent({ text: 'sí voy, confirmo asistencia', booking: baseBooking, now });
  assert.equal(isWithinInterviewConfirmationWindow(baseBooking, now), true);
  assert.equal(intent, 'confirm_attendance');
});

test('detecta cancelación y reagendamiento con intención explícita aunque sea antes del día de la entrevista', () => {
  const sameDay = new Date('2026-04-24T13:00:00.000Z');
  const previousDay = new Date('2026-04-23T18:00:00.000Z');

  assert.equal(detectInterviewIntent({ text: 'quiero cancelar la entrevista', booking: baseBooking, now: sameDay }), 'cancel_interview');
  assert.equal(detectInterviewIntent({ text: 'necesito reagendar, dame otro horario', booking: baseBooking, now: sameDay }), 'reschedule_interview');

  assert.equal(detectInterviewIntent({ text: 'quiero cancelar la entrevista', booking: baseBooking, now: previousDay }), 'cancel_interview');
  assert.equal(detectInterviewIntent({ text: 'necesito reagendar, dame otro horario', booking: baseBooking, now: previousDay }), 'reschedule_interview');
});

test('marca NO_RESPONSE faltando 5 minutos si no hubo respuesta al reminder', () => {
  const booking = {
    ...baseBooking,
    reminderSentAt: new Date('2026-04-24T16:55:00.000Z')
  };

  assert.equal(
    shouldMarkNoResponse(booking, {
      now: new Date('2026-04-24T17:55:00.000Z'),
      hasReminderReply: false
    }),
    true
  );
});
