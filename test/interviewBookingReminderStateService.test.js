import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_INTERVIEW_BOOKING_STATUSES,
  applyInterviewReminderResponse,
  claimInterviewBookingReminder,
  closeUnclaimedInterviewReminderWindow,
  markInterviewBookingNoResponse
} from '../src/services/interviewBookingStateService.js';

function createPrismaMock({ count = 1 } = {}) {
  const calls = [];
  return {
    calls,
    prisma: {
      interviewBooking: {
        updateMany: async (args) => {
          calls.push(args);
          return { count };
        }
      }
    }
  };
}

const bookingId = 'booking-reminder-1';
const candidateId = 'candidate-reminder-1';
const now = new Date('2026-07-15T14:00:00.000Z');
const windowStart = new Date('2026-07-15T14:50:00.000Z');
const windowEnd = new Date('2026-07-15T15:05:00.000Z');

test('cierra únicamente una ventana no reclamada y todavía abierta', async () => {
  const { prisma, calls } = createPrismaMock();

  const result = await closeUnclaimedInterviewReminderWindow(prisma, { bookingId });

  assert.deepEqual(result, { count: 1 });
  assert.deepEqual(calls, [{
    where: {
      id: bookingId,
      reminderSentAt: null,
      reminderWindowClosed: false
    },
    data: { reminderWindowClosed: true }
  }]);
});

test('reclama el recordatorio con filtros de estado, ventana e idempotencia', async () => {
  const { prisma, calls } = createPrismaMock();

  const result = await claimInterviewBookingReminder(prisma, {
    bookingId,
    candidateId,
    now,
    windowStart,
    windowEnd
  });

  assert.deepEqual(result, { count: 1 });
  assert.deepEqual(calls, [{
    where: {
      id: bookingId,
      candidateId,
      status: { in: ACTIVE_INTERVIEW_BOOKING_STATUSES },
      reminderSentAt: null,
      reminderWindowClosed: false,
      scheduledAt: { gte: windowStart, lte: windowEnd }
    },
    data: {
      reminderSentAt: now,
      reminderWindowClosed: true
    }
  }]);
});

test('un claim perdido por concurrencia conserva count cero sin lanzar', async () => {
  const { prisma, calls } = createPrismaMock({ count: 0 });

  const result = await claimInterviewBookingReminder(prisma, {
    bookingId,
    candidateId,
    now,
    windowStart,
    windowEnd
  });

  assert.deepEqual(result, { count: 0 });
  assert.equal(calls.length, 1);
});

test('rechaza una ventana de recordatorio invertida antes de escribir', async () => {
  const { prisma, calls } = createPrismaMock();

  await assert.rejects(
    () => claimInterviewBookingReminder(prisma, {
      bookingId,
      candidateId,
      now,
      windowStart: windowEnd,
      windowEnd: windowStart
    }),
    /reminder_window_invalid/
  );

  assert.equal(calls.length, 0);
});

test('marca NO_RESPONSE únicamente desde SCHEDULED sin respuesta y dentro de los cinco minutos', async () => {
  const { prisma, calls } = createPrismaMock();

  const result = await markInterviewBookingNoResponse(prisma, {
    bookingId,
    candidateId,
    now: windowStart,
    windowEnd
  });

  assert.deepEqual(result, { count: 1 });
  assert.deepEqual(calls, [{
    where: {
      id: bookingId,
      candidateId,
      status: 'SCHEDULED',
      reminderSentAt: { not: null },
      reminderResponse: null,
      scheduledAt: { gte: windowStart, lte: windowEnd }
    },
    data: {
      status: 'NO_RESPONSE',
      reminderWindowClosed: true
    }
  }]);
});

test('rechaza una ventana NO_RESPONSE invertida antes de escribir', async () => {
  const { prisma, calls } = createPrismaMock();

  await assert.rejects(
    () => markInterviewBookingNoResponse(prisma, {
      bookingId,
      candidateId,
      now: windowEnd,
      windowEnd: windowStart
    }),
    /no_response_window_invalid/
  );

  assert.equal(calls.length, 0);
});

test('confirma asistencia desde SCHEDULED mediante la política canónica', async () => {
  const { prisma, calls } = createPrismaMock();

  const result = await applyInterviewReminderResponse(prisma, {
    bookingId,
    currentStatus: 'SCHEDULED',
    responseText: 'Sí, confirmo mi asistencia',
    intent: 'confirm_attendance'
  });

  assert.deepEqual(result, {
    count: 1,
    intent: 'confirm_attendance',
    previousStatus: 'SCHEDULED',
    nextStatus: 'CONFIRMED',
    statusChanged: true
  });
  assert.equal(calls[0].data.status, 'CONFIRMED');
});

test('cancelar una reserva activa produce CANCELLED', async () => {
  const { prisma, calls } = createPrismaMock();

  const result = await applyInterviewReminderResponse(prisma, {
    bookingId,
    currentStatus: 'CONFIRMED',
    responseText: 'No puedo asistir',
    intent: 'cancel_interview'
  });

  assert.equal(result.nextStatus, 'CANCELLED');
  assert.equal(result.statusChanged, true);
  assert.equal(calls[0].data.status, 'CANCELLED');
});

test('solicitar reprogramación conserva SCHEDULED y registra la respuesta', async () => {
  const { prisma, calls } = createPrismaMock();

  const result = await applyInterviewReminderResponse(prisma, {
    bookingId,
    currentStatus: 'SCHEDULED',
    responseText: 'Necesito otro horario',
    intent: 'reschedule_interview'
  });

  assert.deepEqual(result, {
    count: 1,
    intent: 'reschedule_interview',
    previousStatus: 'SCHEDULED',
    nextStatus: 'SCHEDULED',
    statusChanged: false
  });
  assert.deepEqual(calls[0], {
    where: { id: bookingId, status: 'SCHEDULED' },
    data: {
      status: 'SCHEDULED',
      reminderResponse: 'Necesito otro horario',
      reminderWindowClosed: true
    }
  });
});

test('solicitar reprogramación conserva CONFIRMED hasta crear reemplazo', async () => {
  const { prisma, calls } = createPrismaMock();

  const result = await applyInterviewReminderResponse(prisma, {
    bookingId,
    currentStatus: 'CONFIRMED',
    responseText: 'Quisiera cambiar la hora',
    intent: 'reschedule_interview'
  });

  assert.deepEqual(result, {
    count: 1,
    intent: 'reschedule_interview',
    previousStatus: 'CONFIRMED',
    nextStatus: 'CONFIRMED',
    statusChanged: false
  });
  assert.equal(calls[0].data.status, 'CONFIRMED');
});

test('una carrera con count cero no informa una transición que no se persistió', async () => {
  const { prisma } = createPrismaMock({ count: 0 });

  const result = await applyInterviewReminderResponse(prisma, {
    bookingId,
    currentStatus: 'SCHEDULED',
    responseText: 'Confirmo',
    intent: 'confirm_attendance'
  });

  assert.deepEqual(result, {
    count: 0,
    intent: 'confirm_attendance',
    previousStatus: 'SCHEDULED',
    nextStatus: 'SCHEDULED',
    statusChanged: false
  });
});

test('no permite respuestas de recordatorio sobre estados cerrados ni intenciones arbitrarias', async () => {
  const { prisma, calls } = createPrismaMock();

  await assert.rejects(
    () => applyInterviewReminderResponse(prisma, {
      bookingId,
      currentStatus: 'CANCELLED',
      responseText: 'Confirmo',
      intent: 'confirm_attendance'
    }),
    /current_status_not_allowed/
  );
  await assert.rejects(
    () => applyInterviewReminderResponse(prisma, {
      bookingId,
      currentStatus: 'SCHEDULED',
      responseText: 'Confirmo',
      intent: 'UPDATE_ANYTHING'
    }),
    /interview_reminder_intent_not_allowed/
  );

  assert.equal(calls.length, 0);
});

test('valida contratos, objetos, identificadores, texto y fechas antes de escribir', async () => {
  await assert.rejects(
    () => closeUnclaimedInterviewReminderWindow({}, { bookingId }),
    /interview_reminder_window_close_prisma_contract_invalid/
  );

  const { prisma, calls } = createPrismaMock();
  await assert.rejects(
    () => closeUnclaimedInterviewReminderWindow(prisma, null),
    /interview_reminder_window_close_input_invalid/
  );
  await assert.rejects(
    () => claimInterviewBookingReminder(prisma, {
      bookingId,
      candidateId,
      now: false,
      windowStart,
      windowEnd
    }),
    /reminder_claimed_at_invalid/
  );
  await assert.rejects(
    () => applyInterviewReminderResponse(prisma, {
      bookingId,
      currentStatus: 'SCHEDULED',
      responseText: '   ',
      intent: 'confirm_attendance'
    }),
    /reminder_response_required/
  );

  assert.equal(calls.length, 0);
});
