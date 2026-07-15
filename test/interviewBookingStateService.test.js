import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_INTERVIEW_BOOKING_STATUSES,
  cancelActiveInterviewBookings,
  createScheduledInterviewBooking
} from '../src/services/interviewBookingStateService.js';

function createPrismaMock({ exactExisting = null, fallbackActive = null, createError = null, updateCount = 1 } = {}) {
  const calls = {
    findFirst: [],
    updateMany: [],
    create: []
  };
  let findCount = 0;
  const prisma = {
    interviewBooking: {
      findFirst: async (args) => {
        calls.findFirst.push(args);
        findCount += 1;
        return findCount === 1 ? exactExisting : fallbackActive;
      },
      updateMany: async (args) => {
        calls.updateMany.push(args);
        return { count: updateCount };
      },
      create: async (args) => {
        calls.create.push(args);
        if (createError) throw createError;
        return { id: 'booking-created-1', status: 'SCHEDULED', ...args.data };
      }
    }
  };
  return { prisma, calls };
}

const bookingInput = {
  candidateId: 'candidate-1',
  vacancyId: 'vacancy-1',
  slotId: 'slot-1',
  scheduledAt: new Date('2026-07-20T15:00:00.000Z'),
  reminderWindowClosed: false,
  replacementStatus: 'RESCHEDULED'
};

test('devuelve la reserva activa idéntica sin cerrar ni crear otra', async () => {
  const existing = { id: 'booking-existing', status: 'SCHEDULED', ...bookingInput };
  const { prisma, calls } = createPrismaMock({ exactExisting: existing });

  const result = await createScheduledInterviewBooking(prisma, bookingInput);

  assert.equal(result, existing);
  assert.equal(calls.findFirst.length, 1);
  assert.equal(calls.updateMany.length, 0);
  assert.equal(calls.create.length, 0);
});

test('cierra reservas activas antes de crear la nueva reserva programada', async () => {
  const { prisma, calls } = createPrismaMock();

  const result = await createScheduledInterviewBooking(prisma, bookingInput);

  assert.equal(result.id, 'booking-created-1');
  assert.deepEqual(calls.updateMany, [{
    where: {
      candidateId: 'candidate-1',
      status: { in: ACTIVE_INTERVIEW_BOOKING_STATUSES }
    },
    data: {
      status: 'RESCHEDULED',
      reminderWindowClosed: true
    }
  }]);
  assert.equal(calls.create.length, 1);
  assert.deepEqual(calls.create[0].data, {
    candidateId: 'candidate-1',
    vacancyId: 'vacancy-1',
    slotId: 'slot-1',
    scheduledAt: bookingInput.scheduledAt,
    reminderWindowClosed: false
  });
});

test('conserva un valor explícito de reminderWindowClosed sin normalizarlo', async () => {
  const { prisma, calls } = createPrismaMock();

  await createScheduledInterviewBooking(prisma, {
    ...bookingInput,
    reminderWindowClosed: null
  });

  assert.equal(calls.create[0].data.reminderWindowClosed, null);
});

test('ante error de creación recupera una reserva activa concurrente', async () => {
  const concurrent = { id: 'booking-concurrent', status: 'SCHEDULED' };
  const createError = new Error('unique constraint');
  const { prisma, calls } = createPrismaMock({ createError, fallbackActive: concurrent });

  const result = await createScheduledInterviewBooking(prisma, bookingInput);

  assert.equal(result, concurrent);
  assert.equal(calls.findFirst.length, 2);
  assert.deepEqual(calls.findFirst[1], {
    where: {
      candidateId: 'candidate-1',
      status: { in: ACTIVE_INTERVIEW_BOOKING_STATUSES }
    },
    orderBy: { scheduledAt: 'asc' }
  });
});

test('propaga el error de creación cuando no aparece una reserva activa concurrente', async () => {
  const createError = new Error('database unavailable');
  const { prisma } = createPrismaMock({ createError, fallbackActive: null });

  await assert.rejects(
    () => createScheduledInterviewBooking(prisma, bookingInput),
    error => error === createError
  );
});

test('cancela únicamente reservas activas, cierra su ventana y conserva el retorno Prisma', async () => {
  const { prisma, calls } = createPrismaMock({ updateCount: 2 });

  const result = await cancelActiveInterviewBookings(prisma, {
    candidateId: 'candidate-1',
    replacementStatus: 'CANCELLED'
  });

  assert.deepEqual(result, { count: 2 });
  assert.deepEqual(calls.updateMany, [{
    where: {
      candidateId: 'candidate-1',
      status: { in: ACTIVE_INTERVIEW_BOOKING_STATUSES }
    },
    data: {
      status: 'CANCELLED',
      reminderWindowClosed: true
    }
  }]);
});

test('rechaza contratos, entradas e identificadores inválidos antes de escribir', async () => {
  await assert.rejects(
    () => createScheduledInterviewBooking({}, bookingInput),
    /interview_booking_create_prisma_contract_invalid/
  );
  await assert.rejects(
    () => cancelActiveInterviewBookings({ interviewBooking: { updateMany: true } }, { candidateId: 'candidate-1' }),
    /interview_booking_cancel_prisma_contract_invalid/
  );

  const { prisma, calls } = createPrismaMock();
  await assert.rejects(
    () => createScheduledInterviewBooking(prisma, null),
    /interview_booking_create_input_invalid/
  );
  await assert.rejects(
    () => createScheduledInterviewBooking(prisma, { ...bookingInput, scheduledAt: false }),
    /scheduled_at_invalid/
  );
  await assert.rejects(
    () => createScheduledInterviewBooking(prisma, { ...bookingInput, slotId: '  ' }),
    /slot_id_required/
  );
  await assert.rejects(
    () => createScheduledInterviewBooking(prisma, { ...bookingInput, candidateId: true }),
    /candidate_id_invalid/
  );
  await assert.rejects(
    () => createScheduledInterviewBooking(prisma, { ...bookingInput, replacementStatus: {} }),
    /replacement_status_invalid/
  );
  await assert.rejects(
    () => cancelActiveInterviewBookings(prisma, 'candidate-1'),
    /interview_booking_cancel_input_invalid/
  );
  await assert.rejects(
    () => cancelActiveInterviewBookings(prisma, { candidateId: '' }),
    /candidate_id_required/
  );
  await assert.rejects(
    () => cancelActiveInterviewBookings(prisma, { candidateId: 'candidate-1', replacementStatus: false }),
    /replacement_status_invalid/
  );

  assert.equal(calls.updateMany.length, 0);
  assert.equal(calls.create.length, 0);
});
