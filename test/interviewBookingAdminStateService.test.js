import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAdministrativeInterviewBookingAction } from '../src/services/interviewBookingStateService.js';

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

const bookingId = 'booking-admin-1';

async function apply(prisma, action, currentStatus) {
  return applyAdministrativeInterviewBookingAction(prisma, {
    bookingId,
    action,
    currentStatus
  });
}

test('SCHEDULED → CONFIRMED usa comparación por estado de origen', async () => {
  const { prisma, calls } = createPrismaMock();

  const result = await apply(prisma, 'confirmed', 'SCHEDULED');

  assert.deepEqual(result, {
    count: 1,
    action: 'confirmed',
    previousStatus: 'SCHEDULED',
    nextStatus: 'CONFIRMED',
    statusChanged: true,
    requiresReplacement: false,
    persisted: true
  });
  assert.deepEqual(calls, [{
    where: { id: bookingId, status: 'SCHEDULED' },
    data: { status: 'CONFIRMED' }
  }]);
});

test('confirmación repetida es idempotente y sigue comprobando existencia', async () => {
  const { prisma, calls } = createPrismaMock();

  const result = await apply(prisma, 'confirmed', 'CONFIRMED');

  assert.equal(result.count, 1);
  assert.equal(result.nextStatus, 'CONFIRMED');
  assert.equal(result.statusChanged, false);
  assert.equal(result.persisted, true);
  assert.deepEqual(calls[0].where, { id: bookingId, status: 'CONFIRMED' });
});

test('no revive una reserva CANCELLED como CONFIRMED', async () => {
  const { prisma, calls } = createPrismaMock();

  await assert.rejects(
    () => apply(prisma, 'confirmed', 'CANCELLED'),
    /interview_booking_transition_not_allowed:transition_origin_not_allowed/
  );

  assert.equal(calls.length, 0);
});

test('permite cerrar el resultado real desde NO_RESPONSE', async () => {
  for (const [action, expectedStatus] of [
    ['attended', 'ATTENDED'],
    ['no_show', 'NO_SHOW'],
    ['cancelled', 'CANCELLED']
  ]) {
    const { prisma, calls } = createPrismaMock();
    const result = await apply(prisma, action, 'NO_RESPONSE');
    assert.equal(result.nextStatus, expectedStatus);
    assert.equal(result.statusChanged, true);
    assert.equal(calls[0].data.status, expectedStatus);
  }
});

test('CONFIRMED → NO_RESPONSE es rechazado por la política', async () => {
  const { prisma, calls } = createPrismaMock();

  await assert.rejects(
    () => apply(prisma, 'no_response', 'CONFIRMED'),
    /interview_booking_transition_not_allowed:transition_origin_not_allowed/
  );

  assert.equal(calls.length, 0);
});

test('reprogramar desde una reserva activa exige reemplazo y no escribe estado', async () => {
  for (const currentStatus of ['SCHEDULED', 'CONFIRMED']) {
    const { prisma, calls } = createPrismaMock();
    const result = await apply(prisma, 'rescheduled', currentStatus);

    assert.deepEqual(result, {
      count: 0,
      action: 'rescheduled',
      previousStatus: currentStatus,
      nextStatus: currentStatus,
      statusChanged: false,
      requiresReplacement: true,
      persisted: false
    });
    assert.equal(calls.length, 0);
  }
});

test('reprogramar una reserva cerrada es rechazado', async () => {
  const { prisma, calls } = createPrismaMock();

  await assert.rejects(
    () => apply(prisma, 'rescheduled', 'CANCELLED'),
    /interview_booking_transition_not_allowed:transition_origin_not_allowed/
  );

  assert.equal(calls.length, 0);
});

test('una carrera con count cero no informa una transición persistida', async () => {
  const { prisma } = createPrismaMock({ count: 0 });

  const result = await apply(prisma, 'confirmed', 'SCHEDULED');

  assert.deepEqual(result, {
    count: 0,
    action: 'confirmed',
    previousStatus: 'SCHEDULED',
    nextStatus: 'SCHEDULED',
    statusChanged: false,
    requiresReplacement: false,
    persisted: false
  });
});

test('rechaza contratos, entradas, acciones y estados inválidos antes de escribir', async () => {
  await assert.rejects(
    () => applyAdministrativeInterviewBookingAction({}, {
      bookingId,
      action: 'confirmed',
      currentStatus: 'SCHEDULED'
    }),
    /interview_admin_transition_prisma_contract_invalid/
  );

  const { prisma, calls } = createPrismaMock();
  await assert.rejects(
    () => applyAdministrativeInterviewBookingAction(prisma, null),
    /interview_admin_transition_input_invalid/
  );
  await assert.rejects(
    () => apply(prisma, 'UPDATE_ANYTHING', 'SCHEDULED'),
    /interview_admin_action_not_allowed/
  );
  await assert.rejects(
    () => apply(prisma, 'confirmed', 'ACTIVE'),
    /current_status_not_allowed/
  );

  assert.equal(calls.length, 0);
});
