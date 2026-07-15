import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deleteAdministrativeInterviewBooking,
  deleteCandidateInterviewBookings
} from '../src/services/interviewBookingStateService.js';

function createPrismaMock({ count = 1 } = {}) {
  const calls = [];
  let transactionCalls = 0;
  return {
    calls,
    get transactionCalls() {
      return transactionCalls;
    },
    prisma: {
      interviewBooking: {
        deleteMany: async (args) => {
          calls.push(args);
          return { count };
        }
      },
      $transaction: async () => {
        transactionCalls += 1;
        throw new Error('unexpected_nested_transaction');
      }
    }
  };
}

const bookingId = 'booking-delete-1';
const candidateId = 'candidate-delete-1';

test('la eliminación administrativa exige coincidencia exacta de reserva y candidato', async () => {
  const mock = createPrismaMock();

  const result = await deleteAdministrativeInterviewBooking(mock.prisma, {
    bookingId,
    candidateId
  });

  assert.deepEqual(result, { count: 1 });
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(mock.calls, [{
    where: {
      id: bookingId,
      candidateId
    }
  }]);
  assert.equal(mock.transactionCalls, 0);
});

test('count cero conserva una eliminación administrativa no persistida', async () => {
  const mock = createPrismaMock({ count: 0 });

  const result = await deleteAdministrativeInterviewBooking(mock.prisma, {
    bookingId,
    candidateId
  });

  assert.deepEqual(result, { count: 0 });
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.transactionCalls, 0);
});

test('la limpieza de ciclo de vida elimina todas las reservas solo por candidato', async () => {
  const mock = createPrismaMock({ count: 3 });

  const result = await deleteCandidateInterviewBookings(mock.prisma, {
    candidateId
  });

  assert.deepEqual(result, { count: 3 });
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(mock.calls, [{
    where: { candidateId }
  }]);
  assert.equal(mock.transactionCalls, 0);
});

test('rechaza clientes, entradas e identificadores inválidos antes de escribir', async () => {
  await assert.rejects(
    () => deleteAdministrativeInterviewBooking({}, { bookingId, candidateId }),
    /interview_admin_delete_prisma_contract_invalid/
  );
  await assert.rejects(
    () => deleteCandidateInterviewBookings({}, { candidateId }),
    /interview_candidate_cleanup_prisma_contract_invalid/
  );

  const mock = createPrismaMock();
  await assert.rejects(
    () => deleteAdministrativeInterviewBooking(mock.prisma, null),
    /interview_admin_delete_input_invalid/
  );
  await assert.rejects(
    () => deleteAdministrativeInterviewBooking(mock.prisma, { bookingId: ' ', candidateId }),
    /booking_id_required/
  );
  await assert.rejects(
    () => deleteAdministrativeInterviewBooking(mock.prisma, { bookingId, candidateId: 123 }),
    /candidate_id_invalid/
  );
  await assert.rejects(
    () => deleteCandidateInterviewBookings(mock.prisma, []),
    /interview_candidate_cleanup_input_invalid/
  );
  await assert.rejects(
    () => deleteCandidateInterviewBookings(mock.prisma, { candidateId: '' }),
    /candidate_id_required/
  );

  assert.equal(mock.calls.length, 0);
  assert.equal(mock.transactionCalls, 0);
});
