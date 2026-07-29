import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchAuditMiddleware } from '../src/services/dispatchAuditMiddleware.js';

function guardedPrisma({ workerIsTest = false } = {}) {
  let guard = null;
  const prisma = {
    $use(handler) { guard = handler; },
    appUser: { findUnique: async () => null },
    dispatchServiceRequest: {
      findUnique: async () => ({ source: 'DEV_TEST' })
    },
    dispatchWorker: {
      findUnique: async () => ({ isTestProfile: workerIsTest })
    },
    dispatchAssignment: {
      findUnique: async () => ({
        serviceRequestId: 'request-test',
        workerId: workerIsTest ? 'worker-test' : 'worker-real',
        status: 'DEV_TEST_ASSIGNED'
      })
    },
    devAuditEvent: {
      create: async () => ({}),
      findFirst: async () => null
    }
  };
  dispatchAuditMiddleware(prisma);
  return { prisma, guard };
}

test('bloquea que una ruta heredada asigne personal real a DEV_TEST', async () => {
  const { guard } = guardedPrisma({ workerIsTest: false });
  assert.equal(typeof guard, 'function');
  await assert.rejects(() => guard({
    model: 'DispatchAssignment',
    action: 'create',
    args: {
      data: {
        serviceRequestId: 'request-test',
        workerId: 'worker-real',
        status: 'CONFIRMATION_PENDING'
      }
    }
  }, async () => ({ id: 'should-not-run' })), /dev_test_assignment_isolated/);
});

test('permite únicamente sujeto y estado propios del entorno DEV', async () => {
  const { guard } = guardedPrisma({ workerIsTest: true });
  let nextCalled = false;
  const result = await guard({
    model: 'DispatchAssignment',
    action: 'create',
    args: {
      data: {
        serviceRequestId: 'request-test',
        workerId: 'worker-test',
        status: 'DEV_TEST_ASSIGNED'
      }
    }
  }, async () => {
    nextCalled = true;
    return { id: 'assignment-test' };
  });
  assert.equal(nextCalled, true);
  assert.equal(result.id, 'assignment-test');
});

test('permite que la cuenta secundaria confirme mediante updateMany sin salir de DEV_TEST', async () => {
  const { guard } = guardedPrisma({ workerIsTest: true });
  let nextCalled = false;
  await guard({
    model: 'DispatchAssignment',
    action: 'updateMany',
    args: {
      where: { id: 'assignment-test', status: { in: ['DEV_TEST_ASSIGNED'] } },
      data: { status: 'DEV_TEST_CONFIRMED' }
    }
  }, async () => {
    nextCalled = true;
    return { count: 1 };
  });
  assert.equal(nextCalled, true);
});

test('bloquea que una actualización masiva convierta una prueba en estado operativo', async () => {
  const { guard } = guardedPrisma({ workerIsTest: true });
  await assert.rejects(() => guard({
    model: 'DispatchAssignment',
    action: 'updateMany',
    args: {
      where: { id: 'assignment-test' },
      data: { status: 'CONFIRMED' }
    }
  }, async () => ({ count: 1 })), /dev_test_assignment_isolated/);
});
