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
  loadDevTestWorkspace,
  saveDevTestAttendance
} from '../src/services/dispatchDevPayrollTest.js';

test('convierte los bloques de prueba sin perder fecha, horas ni cantidad', () => {
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

test('crea solicitudes DEV_TEST usando un cliente y operación reales solo como referencia', async () => {
  const createdData = [];
  let auditData = null;
  const prisma = {
    dispatchClient: {
      findFirst: async () => ({
        id: 'client-real', name: 'Cliente real', cityName: 'Bogotá',
        operationPoints: [{ id: 'point-real', name: 'Operación real', cityName: 'Bogotá', address: 'Calle real' }],
        services: []
      })
    },
    dispatchServiceRequest: { create: ({ data }) => ({ __create: data }) },
    devAuditEvent: { create: async ({ data }) => { auditData = data; return {}; } },
    $transaction: async (operations) => operations.map((operation, index) => {
      createdData.push(operation.__create);
      return { id: `request-${index + 1}`, ...operation.__create };
    })
  };

  const result = await createDevTestServiceRequests(prisma, {
    clientId: 'client-real', operationPointId: 'point-real',
    serviceDateBlock: '2026-07-28', startTime: '08:00', endTime: '16:00', requiredWorkers: '1'
  }, { actorUsername: 'devloginpro', actorRole: 'dev' });

  assert.equal(result.created.length, 1);
  assert.equal(createdData[0].operationPointId, 'point-real');
  assert.equal(createdData[0].source, DEV_TEST_REQUEST_SOURCE);
  assert.equal(createdData[0].status, 'DEV_TEST_PENDING');
  assert.notEqual(createdData[0].status, 'PENDING_ASSIGNMENT');
  assert.equal(auditData.metadata.realEntityReferences, true);
  assert.equal(auditData.metadata.operationalRecordsChanged, false);
});

test('el entorno consulta todos los clientes activos y auxiliares no eliminados', async () => {
  let clientWhere = null;
  let workerWhere = null;
  const realWorker = { id: 'worker-real', fullName: 'Auxiliar real', isTestProfile: false, operationalStatus: 'DISPONIBLE' };
  const testWorker = { id: 'worker-test', fullName: 'Perfil prueba', isTestProfile: true, operationalStatus: 'DISPONIBLE' };
  const prisma = {
    dispatchServiceRequest: { findMany: async () => [] },
    dispatchClient: {
      findMany: async (input) => {
        clientWhere = input.where;
        return [{ id: 'client-real', name: 'Cliente real', operationPoints: [{ id: 'point-real' }], services: [] }];
      }
    },
    dispatchWorker: {
      findMany: async (input) => {
        workerWhere = input.where;
        return [realWorker, testWorker];
      }
    }
  };

  const workspace = await loadDevTestWorkspace(prisma);
  assert.deepEqual(clientWhere, { isActive: true });
  assert.deepEqual(workerWhere, { operationalStatus: { not: 'ELIMINADO' } });
  assert.equal(workspace.clients.length, 1);
  assert.deepEqual(workspace.workers.map((worker) => worker.id), ['worker-real', 'worker-test']);
  assert.deepEqual(workspace.availableWorkers.map((worker) => worker.id), ['worker-real', 'worker-test']);
});

test('permite asignar un auxiliar real sin modificar su perfil operativo', async () => {
  const saved = { assignment: null, requestStatus: null };
  const worker = { id: 'worker-real', isTestProfile: false, operationalStatus: 'DISPONIBLE' };
  const prisma = {
    dispatchServiceRequest: {
      findUnique: async () => ({ id: 'request-1', source: DEV_TEST_REQUEST_SOURCE, requiredWorkers: 1 }),
      update: async ({ data }) => { saved.requestStatus = data.status; }
    },
    dispatchWorker: { findUnique: async () => worker },
    dispatchAssignment: {
      upsert: async (input) => { saved.assignment = input; return { id: 'assignment-1', ...input.create }; },
      count: async () => 1
    }
  };

  const result = await assignDevTestWorker(prisma, {
    serviceRequestId: 'request-1', workerId: 'worker-real'
  }, { actorUsername: 'usuario-pruebas', actorRole: 'admin' });

  assert.equal(result.status, 'DEV_TEST_ASSIGNED');
  assert.equal(saved.assignment.create.workerId, 'worker-real');
  assert.equal(saved.assignment.create.status, 'DEV_TEST_ASSIGNED');
  assert.equal(saved.requestStatus, 'DEV_TEST_COMPLETE');
  assert.equal(worker.isTestProfile, false);
  assert.equal(worker.operationalStatus, 'DISPONIBLE');
});

test('rechaza únicamente auxiliares eliminados o inexistentes', async () => {
  const prisma = {
    dispatchServiceRequest: { findUnique: async () => ({ id: 'request-1', source: DEV_TEST_REQUEST_SOURCE }) },
    dispatchWorker: { findUnique: async () => ({ id: 'worker-deleted', operationalStatus: 'ELIMINADO' }) }
  };
  await assert.rejects(() => assignDevTestWorker(prisma, {
    serviceRequestId: 'request-1', workerId: 'worker-deleted'
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

test('los turnos nocturnos terminan al día siguiente y el almuerzo inicia vacío', () => {
  const defaults = defaultDevTestTimes({
    serviceDate: new Date('2026-07-28T05:00:00.000Z'),
    startTime: '19:00',
    endTime: '05:00'
  });
  assert.equal(defaults.arrivalAt, '2026-07-28T19:00');
  assert.equal(defaults.departureAt, '2026-07-29T05:00');
  assert.equal(defaults.breakStartAt, '');
  assert.equal(defaults.breakEndAt, '');
});

test('la vista permite crear solicitudes y distingue auxiliares reales de perfiles de prueba', async () => {
  const [template, publicTemplateSync, confirmationPatch] = await Promise.all([
    readFile('src/views/operacionesPruebasNominaV2.ejs', 'utf8'),
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
    id: 'assignment-real', workerId: 'worker-real', status: 'DEV_TEST_ASSIGNED', attendanceSession: null,
    worker: { id: 'worker-real', fullName: 'Auxiliar real', documentNumber: '1000000000', phone: '3000000000', isTestProfile: false }
  };
  const request = {
    id: 'request-test', clientName: 'Cliente real', operationPointName: 'Operación real', cityName: 'Bogotá',
    address: 'Calle real', serviceName: 'Cargue y descargue', serviceDate: new Date('2026-07-28T05:00:00.000Z'),
    startTime: '08:00', endTime: '16:00', requiredWorkers: 1,
    operationPoint: { clientId: 'client-real', address: 'Calle real', cityName: 'Bogotá' }, assignments: [assignment]
  };
  const locals = {
    pageTitle: 'Entorno de pruebas', role: 'dev', canUseTestWhatsapp: true,
    workspace: {
      requests: [request], selectedRequest: request, availableWorkers: [],
      clients: [{ id: 'client-real', name: 'Cliente real', operationPoints: [{ id: 'point-real', name: 'Operación real' }], services: [] }]
    },
    message: null, error: null, formatBogotaDateTimeLocal: () => '',
    defaultDevTestTimes: () => ({ arrivalAt: '2026-07-28T08:00', breakStartAt: '', breakEndAt: '', departureAt: '2026-07-28T16:00' }),
    testRequestSource: DEV_TEST_REQUEST_SOURCE
  };
  const html = ejs.render(template, locals);

  assert.match(html, /Nueva solicitud de prueba/);
  assert.match(html, /Cliente existente/);
  assert.match(html, /Auxiliar existente/);
  assert.match(html, /AUXILIAR REAL USADO COMO REFERENCIA/);
  assert.match(html, /name="breakStartAt" value=""/);
  assert.match(html, /name="breakEndAt" value=""/);
  for (const line of canonicalLines) {
    assert.ok(publicTemplateSync.includes(line));
    assert.ok(confirmationPatch.includes(line));
    assert.ok(template.includes(line));
  }

  const adminHtml = ejs.render(template, { ...locals, role: 'admin', canUseTestWhatsapp: false });
  assert.doesNotMatch(adminHtml, /Enviar desde WhatsApp de pruebas/);
  assert.doesNotMatch(adminHtml, /href="\/admin\/operaciones\/pruebas\/whatsapp"/);
});

test('las constantes aíslan solicitud y marcaciones manuales', () => {
  assert.equal(DEV_TEST_REQUEST_SOURCE, 'DEV_TEST');
  assert.equal(DEV_TEST_ATTENDANCE_SOURCE, 'DEV_TEST_MANUAL');
});
