import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEV_TEST_ATTENDANCE_SOURCE,
  DEV_TEST_REQUEST_SOURCE,
  assignDevTestWorker,
  buildDevTestTimeBlocks,
  createDevTestServiceRequests,
  defaultDevTestTimes,
  saveDevTestAttendance
} from '../src/services/dispatchDevPayrollTest.js';

test('convierte los bloques DEV sin perder fecha, horas ni cantidad', () => {
  const blocks = buildDevTestTimeBlocks({
    serviceDateBlock: ['2026-07-28', '2026-07-29'],
    startTime: ['08:00', '19:00'],
    endTime: ['16:00', '23:30'],
    requiredWorkers: ['1', '2']
  });
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].requiredWorkers, 1);
  assert.equal(blocks[1].requiredWorkers, 2);
  assert.equal(blocks[1].startTime, '19:00');
});

test('crea solicitudes aisladas con source DEV_TEST y sin autoasignación', async () => {
  const createdData = [];
  const prisma = {
    dispatchClient: {
      findFirst: async () => ({
        id: 'client-test', name: 'Cliente prueba', cityName: 'Bogotá',
        operationPoints: [{ id: 'point-test', name: 'Operación prueba', cityName: 'Bogotá', address: 'Calle prueba' }],
        services: []
      })
    },
    dispatchServiceRequest: {
      create: ({ data }) => ({ __create: data })
    },
    devAuditEvent: { create: async () => ({}) },
    $transaction: async (operations) => operations.map((operation, index) => {
      createdData.push(operation.__create);
      return { id: `request-${index + 1}`, ...operation.__create };
    })
  };

  const result = await createDevTestServiceRequests(prisma, {
    clientId: 'client-test', operationPointId: 'point-test',
    serviceDateBlock: '2026-07-28', startTime: '08:00', endTime: '16:00', requiredWorkers: '1'
  }, { actorUsername: 'devloginpro' });

  assert.equal(result.created.length, 1);
  assert.equal(createdData[0].source, DEV_TEST_REQUEST_SOURCE);
  assert.equal(createdData[0].status, 'PENDING_ASSIGNMENT');
});

test('rechaza asignar un auxiliar real a una solicitud de prueba', async () => {
  const prisma = {
    dispatchServiceRequest: { findUnique: async () => ({ id: 'request-1', source: DEV_TEST_REQUEST_SOURCE }) },
    dispatchWorker: { findUnique: async () => ({ id: 'worker-real', isTestProfile: false }) }
  };
  await assert.rejects(() => assignDevTestWorker(prisma, {
    serviceRequestId: 'request-1', workerId: 'worker-real'
  }), /dev_test_worker_required/);
});

test('la jornada manual exige una cronología válida', async () => {
  await assert.rejects(() => saveDevTestAttendance({}, {
    assignmentId: 'assignment-1',
    arrivalAt: '2026-07-28T08:00',
    breakStartAt: '2026-07-28T12:00',
    breakEndAt: '2026-07-28T11:00',
    departureAt: '2026-07-28T16:00'
  }), /dev_test_break_end_invalid/);
});

test('los turnos nocturnos terminan al día siguiente por defecto', () => {
  const defaults = defaultDevTestTimes({
    serviceDate: new Date('2026-07-28T05:00:00.000Z'),
    startTime: '19:00',
    endTime: '05:00'
  });
  assert.equal(defaults.arrivalAt, '2026-07-28T19:00');
  assert.equal(defaults.departureAt, '2026-07-29T05:00');
});

test('las constantes aíslan solicitud y marcaciones manuales', () => {
  assert.equal(DEV_TEST_REQUEST_SOURCE, 'DEV_TEST');
  assert.equal(DEV_TEST_ATTENDANCE_SOURCE, 'DEV_TEST_MANUAL');
});
