import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_INTERVIEW_BOOKING_STATUSES,
  cancelActiveInterviewBookings,
  createScheduledInterviewBooking,
  requestActiveInterviewBookingReschedule
} from '../src/services/interviewBookingStateService.js';

function cloneBooking(booking) {
  return booking
    ? {
        ...booking,
        scheduledAt: booking.scheduledAt ? new Date(booking.scheduledAt) : booking.scheduledAt
      }
    : booking;
}

function createError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function matchesWhere(booking, where = {}) {
  if (where.candidateId !== undefined && booking.candidateId !== where.candidateId) return false;
  if (where.vacancyId !== undefined && booking.vacancyId !== where.vacancyId) return false;
  if (where.slotId !== undefined && booking.slotId !== where.slotId) return false;
  if (where.scheduledAt !== undefined
    && new Date(booking.scheduledAt).getTime() !== new Date(where.scheduledAt).getTime()) return false;
  if (where.status?.in && !where.status.in.includes(booking.status)) return false;
  return true;
}

function createPrismaHarness({
  bookings = [],
  createErrors = [],
  updateErrors = [],
  transactionErrors = [],
  afterRollback = null
} = {}) {
  let state = bookings.map(cloneBooking);
  let createdCount = 0;
  let transactionAttempt = 0;
  const queuedCreateErrors = [...createErrors];
  const queuedUpdateErrors = [...updateErrors];
  const queuedTransactionErrors = [...transactionErrors];
  const calls = {
    transactions: [],
    sequence: [],
    findMany: [],
    findFirst: [],
    create: [],
    updateMany: []
  };

  function insertBooking(booking) {
    state.push(cloneBooking(booking));
  }

  function makeClient() {
    return {
      interviewBooking: {
        findMany: async (args) => {
          calls.sequence.push('findMany');
          calls.findMany.push(args);
          const rows = state.filter((booking) => matchesWhere(booking, args.where));
          rows.sort((left, right) => new Date(left.scheduledAt) - new Date(right.scheduledAt));
          return rows.map(cloneBooking);
        },
        findFirst: async (args) => {
          calls.sequence.push('findFirst');
          calls.findFirst.push(args);
          const rows = state.filter((booking) => matchesWhere(booking, args.where));
          rows.sort((left, right) => new Date(left.scheduledAt) - new Date(right.scheduledAt));
          return cloneBooking(rows[0] || null);
        },
        create: async (args) => {
          calls.sequence.push('create');
          calls.create.push(args);
          const error = queuedCreateErrors.shift();
          if (error) throw error;

          const activeExists = state.some((booking) => (
            booking.candidateId === args.data.candidateId
            && ACTIVE_INTERVIEW_BOOKING_STATUSES.includes(booking.status)
          ));
          if (activeExists) {
            throw createError('P2002', 'InterviewBooking_one_active_per_candidate_idx');
          }

          createdCount += 1;
          const created = {
            id: `booking-created-${createdCount}`,
            status: 'SCHEDULED',
            ...args.data
          };
          state.push(cloneBooking(created));
          return cloneBooking(created);
        },
        updateMany: async (args) => {
          calls.sequence.push('updateMany');
          calls.updateMany.push(args);
          const error = queuedUpdateErrors.shift();
          if (error) throw error;
          let count = 0;
          state = state.map((booking) => {
            if (!matchesWhere(booking, args.where)) return booking;
            count += 1;
            return { ...booking, ...args.data };
          });
          return { count };
        }
      }
    };
  }

  const tx = makeClient();
  const prisma = makeClient();
  prisma.$transaction = async (work, options) => {
    transactionAttempt += 1;
    calls.transactions.push(options);
    const transactionError = queuedTransactionErrors.shift();
    if (transactionError) throw transactionError;

    const snapshot = state.map(cloneBooking);
    try {
      return await work(makeClient());
    } catch (error) {
      state = snapshot;
      if (afterRollback) {
        await afterRollback({ error, insertBooking, attempt: transactionAttempt });
      }
      throw error;
    }
  };

  return {
    prisma,
    tx,
    calls,
    getState: () => state.map(cloneBooking)
  };
}

const scheduledAt = new Date('2026-07-20T15:00:00.000Z');
const bookingInput = {
  candidateId: 'candidate-1',
  vacancyId: 'vacancy-1',
  slotId: 'slot-1',
  scheduledAt,
  reminderWindowClosed: false,
  replacementStatus: 'RESCHEDULED'
};

const activeBooking = {
  id: 'booking-old-1',
  candidateId: 'candidate-1',
  vacancyId: 'vacancy-old',
  slotId: 'slot-old',
  scheduledAt: new Date('2026-07-19T15:00:00.000Z'),
  status: 'SCHEDULED',
  reminderWindowClosed: false
};

test('reutiliza una reserva activa exacta sin crear ni cerrar otra', async () => {
  const exact = { id: 'booking-existing', status: 'SCHEDULED', ...bookingInput };
  const { prisma, calls, getState } = createPrismaHarness({ bookings: [exact] });

  const result = await createScheduledInterviewBooking(prisma, bookingInput);

  assert.equal(result.id, exact.id);
  assert.deepEqual(calls.sequence, ['findMany']);
  assert.equal(calls.transactions.length, 1);
  assert.equal(getState()[0].status, 'SCHEDULED');
});

test('cierra y crea dentro de una transacción serializable compatible con el índice único activo', async () => {
  const { prisma, calls, getState } = createPrismaHarness({ bookings: [activeBooking] });

  const result = await createScheduledInterviewBooking(prisma, bookingInput);
  const state = getState();
  const previous = state.find((booking) => booking.id === activeBooking.id);
  const replacement = state.find((booking) => booking.id === result.id);

  assert.deepEqual(calls.transactions, [{ isolationLevel: 'Serializable' }]);
  assert.deepEqual(calls.sequence, ['findMany', 'updateMany', 'create']);
  assert.equal(previous.status, 'RESCHEDULED');
  assert.equal(previous.reminderWindowClosed, true);
  assert.equal(replacement.status, 'SCHEDULED');
  assert.equal(replacement.reminderWindowClosed, false);
  assert.deepEqual(calls.updateMany[0].where, {
    candidateId: 'candidate-1',
    status: { in: ACTIVE_INTERVIEW_BOOKING_STATUSES }
  });
});

test('un fallo al crear revierte el cierre y conserva activa la reserva anterior', async () => {
  const createFailure = new Error('database unavailable');
  const { prisma, calls, getState } = createPrismaHarness({
    bookings: [activeBooking],
    createErrors: [createFailure]
  });

  await assert.rejects(
    () => createScheduledInterviewBooking(prisma, bookingInput),
    (error) => error === createFailure
  );

  assert.deepEqual(calls.sequence, ['findMany', 'updateMany', 'create']);
  assert.equal(calls.updateMany.length, 1);
  assert.deepEqual(getState(), [activeBooking]);
});

test('un fallo al cerrar impide crear y revierte la unidad', async () => {
  const updateFailure = new Error('update failed');
  const { prisma, calls, getState } = createPrismaHarness({
    bookings: [activeBooking],
    updateErrors: [updateFailure]
  });

  await assert.rejects(
    () => createScheduledInterviewBooking(prisma, bookingInput),
    (error) => error === updateFailure
  );

  assert.deepEqual(calls.sequence, ['findMany', 'updateMany']);
  assert.equal(calls.create.length, 0);
  assert.deepEqual(getState(), [activeBooking]);
});

test('reutiliza un tx existente sin intentar abrir una transacción anidada', async () => {
  const { tx, calls, getState } = createPrismaHarness({ bookings: [activeBooking] });

  const result = await createScheduledInterviewBooking(tx, bookingInput);
  const state = getState();

  assert.equal(calls.transactions.length, 0);
  assert.deepEqual(calls.sequence, ['findMany', 'updateMany', 'create']);
  assert.equal(state.find((booking) => booking.id === activeBooking.id).status, 'RESCHEDULED');
  assert.equal(state.find((booking) => booking.id === result.id).status, 'SCHEDULED');
});

test('reintenta conflictos serializables P2034 antes de completar el reemplazo', async () => {
  const { prisma, calls, getState } = createPrismaHarness({
    bookings: [activeBooking],
    transactionErrors: [createError('P2034')]
  });

  await createScheduledInterviewBooking(prisma, bookingInput);

  assert.equal(calls.transactions.length, 2);
  assert.equal(getState().filter((booking) => ACTIVE_INTERVIEW_BOOKING_STATUSES.includes(booking.status)).length, 1);
});

test('ante P2002 solo recupera la reserva concurrente exacta solicitada', async () => {
  const concurrentExact = {
    id: 'booking-concurrent-exact',
    status: 'SCHEDULED',
    ...bookingInput
  };
  const { prisma } = createPrismaHarness({
    createErrors: [createError('P2002')],
    afterRollback: ({ insertBooking }) => insertBooking(concurrentExact)
  });

  const result = await createScheduledInterviewBooking(prisma, bookingInput);

  assert.equal(result.id, concurrentExact.id);
});

test('no confunde otra reserva activa con la reserva concurrente exacta', async () => {
  const uniqueFailure = createError('P2002');
  const concurrentOtherSlot = {
    ...activeBooking,
    id: 'booking-concurrent-other-slot'
  };
  const { prisma } = createPrismaHarness({
    createErrors: [uniqueFailure],
    afterRollback: ({ insertBooking }) => insertBooking(concurrentOtherSlot)
  });

  await assert.rejects(
    () => createScheduledInterviewBooking(prisma, bookingInput),
    (error) => error === uniqueFailure
  );
});

test('solicitar reprogramación conserva la reserva activa y no escribe estado', async () => {
  const { prisma, calls, getState } = createPrismaHarness({ bookings: [activeBooking] });

  const result = await requestActiveInterviewBookingReschedule(prisma, {
    candidateId: 'candidate-1'
  });

  assert.deepEqual(result, { count: 0 });
  assert.deepEqual(calls.sequence, ['findMany']);
  assert.deepEqual(getState(), [activeBooking]);
});

test('cancela únicamente reservas activas usando el destino canónico CANCELLED', async () => {
  const { prisma, calls, getState } = createPrismaHarness({ bookings: [activeBooking] });

  const result = await cancelActiveInterviewBookings(prisma, {
    candidateId: 'candidate-1',
    replacementStatus: 'CANCELLED'
  });

  assert.deepEqual(result, { count: 1 });
  assert.equal(getState()[0].status, 'CANCELLED');
  assert.equal(getState()[0].reminderWindowClosed, true);
  assert.equal(calls.updateMany.length, 1);
});

test('rechaza destinos arbitrarios y RESCHEDULED como cancelación ordinaria', async () => {
  const { prisma, calls } = createPrismaHarness({ bookings: [activeBooking] });

  await assert.rejects(
    () => createScheduledInterviewBooking(prisma, {
      ...bookingInput,
      replacementStatus: 'CANCELLED'
    }),
    /replacement_status_not_allowed/
  );
  await assert.rejects(
    () => cancelActiveInterviewBookings(prisma, {
      candidateId: 'candidate-1',
      replacementStatus: 'RESCHEDULED'
    }),
    /replacement_status_not_allowed/
  );
  await assert.rejects(
    () => cancelActiveInterviewBookings(prisma, {
      candidateId: 'candidate-1',
      replacementStatus: 'ATTENDED'
    }),
    /replacement_status_not_allowed/
  );

  assert.equal(calls.transactions.length, 0);
  assert.equal(calls.updateMany.length, 0);
});

test('rechaza contratos, entradas, identificadores y fechas inválidas antes de escribir', async () => {
  await assert.rejects(
    () => createScheduledInterviewBooking({}, bookingInput),
    /interview_booking_create_prisma_contract_invalid/
  );
  await assert.rejects(
    () => cancelActiveInterviewBookings({ interviewBooking: { updateMany: true } }, { candidateId: 'candidate-1' }),
    /interview_booking_cancel_prisma_contract_invalid/
  );

  const { prisma, calls } = createPrismaHarness();
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
    () => requestActiveInterviewBookingReschedule(prisma, []),
    /interview_booking_reschedule_request_input_invalid/
  );
  await assert.rejects(
    () => cancelActiveInterviewBookings(prisma, 'candidate-1'),
    /interview_booking_cancel_input_invalid/
  );

  assert.equal(calls.transactions.length, 0);
  assert.equal(calls.updateMany.length, 0);
  assert.equal(calls.create.length, 0);
});
