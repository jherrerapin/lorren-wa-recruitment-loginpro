import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ejs from 'ejs';
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

test('crea solicitudes aisladas con source y estado DEV_TEST', async () => {
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
  assert.equal(createdData[0].status, 'DEV_TEST_PENDING');
  assert.notEqual(createdData[0].status, 'PENDING_ASSIGNMENT');
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

test('asigna sujetos de prueba con estado separado del flujo real', async () => {
  const saved = { assignment: null, requestStatus: null };
  const prisma = {
    dispatchServiceRequest: {
      findUnique: async () => ({ id: 'request-1', source: DEV_TEST_REQUEST_SOURCE, requiredWorkers: 1 }),
      update: async ({ data }) => { saved.requestStatus = data.status; }
    },
    dispatchWorker: { findUnique: async () => ({ id: 'worker-test', isTestProfile: true }) },
    dispatchAssignment: {
      upsert: async (input) => { saved.assignment = input; return { id: 'assignment-1', ...input.create }; },
      count: async () => 1
    }
  };
  const result = await assignDevTestWorker(prisma, {
    serviceRequestId: 'request-1', workerId: 'worker-test'
  }, { actorUsername: 'devloginpro' });
  assert.equal(result.status, 'DEV_TEST_ASSIGNED');
  assert.equal(saved.assignment.create.status, 'DEV_TEST_ASSIGNED');
  assert.equal(saved.requestStatus, 'DEV_TEST_COMPLETE');
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

test('la vista DEV usa el mensaje realmente aplicado en producción y deja el almuerzo vacío', async () => {
  const [template, publicTemplateSync, confirmationPatch] = await Promise.all([
    readFile('src/views/operacionesPruebasNomina.ejs', 'utf8'),
    readFile('src/public/assignment-template-sync.js', 'utf8'),
    readFile('src/services/dispatchWhatsappConfirmationPatch.js', 'utf8')
  ]);
  const canonicalLines = [
    'Hola *{{nombre}}*,',
    'Mañana: *{{fecha}}*',
    'Llegar a: *{{operacion}}  - {{direccion}}*',
    'Hora : *{{horaInicio}} por favor.*',
    '*Confirmado?*'
  ];
  const assignment = {
    id: 'assignment-test',
    workerId: 'worker-test',
    status: 'DEV_TEST_ASSIGNED',
    attendanceSession: null,
    worker: {
      id: 'worker-test',
      fullName: 'Jhon Herrera',
      documentNumber: '1000000000',
      phone: '3000000000'
    }
  };
  const request = {
    id: 'request-test',
    clientName: 'Cliente prueba',
    operationPointName: 'Operación prueba',
    cityName: 'Bogotá',
    address: 'Calle prueba',
    serviceName: 'Cargue y descargue',
    serviceDate: new Date('2026-07-28T05:00:00.000Z'),
    startTime: '08:00',
    endTime: '16:00',
    requiredWorkers: 1,
    operationPoint: { clientId: 'client-test', address: 'Calle prueba', cityName: 'Bogotá' },
    assignments: [assignment]
  };

  const html = ejs.render(template, {
    pageTitle: 'Pruebas DEV',
    role: 'dev',
    workspace: { requests: [request], selectedRequest: request, availableWorkers: [] },
    message: null,
    error: null,
    formatBogotaDateTimeLocal: () => '',
    defaultDevTestTimes: () => ({
      arrivalAt: '2026-07-28T08:00',
      breakStartAt: '2026-07-28T12:00',
      breakEndAt: '2026-07-28T13:00',
      departureAt: '2026-07-28T16:00'
    }),
    testRequestSource: DEV_TEST_REQUEST_SOURCE
  });

  assert.match(html, /name="breakStartAt" value=""/);
  assert.match(html, /name="breakEndAt" value=""/);
  assert.match(html, /Inicio de almuerzo \(opcional\)/);
  assert.match(html, /Regreso de almuerzo \(opcional\)/);
  for (const line of canonicalLines) {
    assert.ok(publicTemplateSync.includes(line), `La capa pública productiva debe contener: ${line}`);
    assert.ok(confirmationPatch.includes(line), `La capa de confirmación productiva debe contener: ${line}`);
    assert.ok(template.includes(line), `La vista DEV debe contener: ${line}`);
  }
  assert.doesNotMatch(template, /Te confirmamos la asignación de prueba/);
  assert.doesNotMatch(template, /te confirmamos asignación para \{\{fecha\}\}/i);
  assert.doesNotMatch(html, /Responde CONFIRMADO para validar la recepción/);
});

test('las constantes aíslan solicitud y marcaciones manuales', () => {
  assert.equal(DEV_TEST_REQUEST_SOURCE, 'DEV_TEST');
  assert.equal(DEV_TEST_ATTENDANCE_SOURCE, 'DEV_TEST_MANUAL');
});