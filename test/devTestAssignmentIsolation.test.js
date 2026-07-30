import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchAuditMiddleware } from '../src/services/dispatchAuditMiddleware.js';

function guardedPrisma({ operationalStatus = 'DISPONIBLE', workerId = 'worker-real' } = {}) {
  let guard = null;
  const prisma = {
    $use(handler) { guard = handler; },
    appUser: { findUnique: async () => null },
    dispatchServiceRequest: { findUnique: async () => ({ source: 'DEV_TEST' }) },
    dispatchWorker: { findUnique: async () => ({ id: workerId, operationalStatus }) },
    dispatchAssignment: {
      findUnique: async () => ({
        serviceRequestId: 'request-test', workerId, status: 'DEV_TEST_ASSIGNED'
      })
    },
    devAuditEvent: { create: async () => ({}), findFirst: async () => null }
  };
  dispatchAuditMiddleware(prisma);
  return { prisma, guard };
}

test('permite un auxiliar real cuando la solicitud y el estado siguen aislados', async () => {
  const { guard } = guardedPrisma();
  assert.equal(typeof guard, 'function');
  let nextCalled = false;
  const result = await guard({
    model: 'DispatchAssignment',
    action: 'create',
    args: { data: { serviceRequestId: 'request-test', workerId: 'worker-real', status: 'DEV_TEST_ASSIGNED' } }
  }, async () => {
    nextCalled = true;
    return { id: 'assignment-test' };
  });
  assert.equal(nextCalled, true);
  assert.equal(result.id, 'assignment-test');
});

test('bloquea que una solicitud DEV_TEST use un estado operativo', async () => {
  const { guard } = guardedPrisma();
  await assert.rejects(() => guard({
    model: 'DispatchAssignment',
    action: 'create',
    args: { data: { serviceRequestId: 'request-test', workerId: 'worker-real', status: 'CONFIRMATION_PENDING' } }
  }, async () => ({ id: 'should-not-run' })), /dev_test_assignment_isolated/);
});

test('bloquea auxiliares eliminados incluso dentro del entorno de pruebas', async () => {
  const { guard } = guardedPrisma({ operationalStatus: 'ELIMINADO' });
  await assert.rejects(() => guard({
    model: 'DispatchAssignment',
    action: 'create',
    args: { data: { serviceRequestId: 'request-test', workerId: 'worker-real', status: 'DEV_TEST_ASSIGNED' } }
  }, async () => ({ id: 'should-not-run' })), /dev_test_assignment_isolated/);
});

test('permite que la cuenta secundaria confirme mediante updateMany sin salir de DEV_TEST', async () => {
  const { guard } = guardedPrisma();
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
  const { guard } = guardedPrisma();
  await assert.rejects(() => guard({
    model: 'DispatchAssignment',
    action: 'updateMany',
    args: { where: { id: 'assignment-test' }, data: { status: 'CONFIRMED' } }
  }, async () => ({ count: 1 })), /dev_test_assignment_isolated/);
});
