import test from 'node:test';
import assert from 'node:assert/strict';
import { createDevTestServiceRequests } from '../src/services/dispatchDevPayrollTest.js';

test('permite omitir servicio aunque el cliente tenga servicios activos', async () => {
  let requestData = null;
  const prisma = {
    dispatchClient: {
      findFirst: async () => ({
        id: 'client-real',
        name: 'Cliente real',
        cityName: 'Bogotá',
        operationPoints: [{ id: 'point-real', name: 'Operación real', isActive: true }],
        services: [{ id: 'service-real', name: 'Servicio real', isActive: true }]
      })
    },
    dispatchServiceRequest: {
      create: ({ data }) => ({ __data: data })
    },
    devAuditEvent: { create: async () => ({}) },
    $transaction: async (operations) => operations.map((operation, index) => {
      requestData = operation.__data;
      return { id: `request-${index + 1}`, ...operation.__data };
    })
  };

  await createDevTestServiceRequests(prisma, {
    clientId: 'client-real',
    operationPointId: 'point-real',
    serviceId: '',
    serviceDateBlock: '2026-07-29',
    startTime: '08:00',
    endTime: '16:00',
    requiredWorkers: '1'
  }, { actorUsername: 'devloginpro', actorRole: 'dev' });

  assert.equal(requestData.serviceId, null);
  assert.equal(requestData.serviceName, 'Servicio de prueba');
  assert.equal(requestData.source, 'DEV_TEST');
});

test('rechaza un servicio enviado que no pertenece al cliente', async () => {
  const prisma = {
    dispatchClient: {
      findFirst: async () => ({
        id: 'client-real',
        name: 'Cliente real',
        operationPoints: [{ id: 'point-real', name: 'Operación real' }],
        services: [{ id: 'service-real', name: 'Servicio real' }]
      })
    }
  };

  await assert.rejects(() => createDevTestServiceRequests(prisma, {
    clientId: 'client-real',
    operationPointId: 'point-real',
    serviceId: 'service-other',
    serviceDateBlock: '2026-07-29',
    startTime: '08:00',
    endTime: '16:00',
    requiredWorkers: '1'
  }), /dev_test_service_not_found/);
});
