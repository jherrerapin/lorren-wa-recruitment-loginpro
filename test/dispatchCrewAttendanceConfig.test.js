import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CREW_ATTENDANCE_CONFIG_ACTION,
  CREW_ATTENDANCE_MODE,
  CREW_ATTENDANCE_OPERATION_ENTITY_TYPE,
  CREW_LEADER_ASSIGNMENT_STATUS,
  loadCrewAttendanceConfiguration,
  loadCrewAttendancePortalContexts,
  saveCrewAttendanceOperationCapability,
  saveCrewAttendanceServiceConfiguration
} from '../src/modules/dispatch-attendance/application/crewAttendanceConfig.js';
import { ACTIVE_DISPATCH_ASSIGNMENT_STATUSES as ATTENDANCE_ASSIGNMENT_STATUSES } from '../src/modules/dispatch-attendance/application/registerArrival.js';
import { registerCrewArrivalForLeader } from '../src/modules/dispatch-attendance/application/registerCrewArrival.js';
import {
  ACTIVE_DISPATCH_ASSIGNMENT_STATUSES as COVERAGE_ASSIGNMENT_STATUSES,
  deriveDispatchRequestOperationalState
} from '../src/services/dispatchOperationalCoverage.js';

function testFixture({ attendanceEnabled = true } = {}) {
  const events = [];
  let eventSequence = 0;
  let assignmentSequence = 2;
  const operation = {
    id: 'TEST-OP-CREW',
    clientId: 'TEST-CLIENT-CREW',
    name: 'Operación Prueba Cuadrilla',
    cityName: 'Ciudad Prueba',
    isActive: true,
    attendanceEnabled,
    client: { id: 'TEST-CLIENT-CREW', name: 'Cliente Prueba Cuadrilla' }
  };
  const workers = [
    { id: 'TEST-WORKER-A', fullName: 'Auxiliar Prueba A', contractType: 'DIRECTO', operationalStatus: 'CONTRATADO', isTestProfile: false },
    { id: 'TEST-WORKER-B', fullName: 'Auxiliar Prueba B', contractType: 'CONTRATISTA', operationalStatus: 'CONTRATADO', isTestProfile: false },
    { id: 'TEST-WORKER-LEADER', fullName: 'Encargado Prueba', contractType: 'DIRECTO', operationalStatus: 'CONTRATADO', isTestProfile: false }
  ];
  const workerById = new Map(workers.map((worker) => [worker.id, worker]));
  const service = {
    id: 'TEST-SERVICE-CREW',
    operationPointId: operation.id,
    clientName: operation.client.name,
    operationPointName: operation.name,
    serviceDate: new Date('2026-08-14T00:00:00.000Z'),
    startTime: '07:00',
    endTime: '16:00',
    status: 'ASSIGNMENT_COMPLETE',
    requiredWorkers: 2,
    operationPoint: operation,
    assignments: [
      {
        id: 'TEST-ASSIGNMENT-A',
        workerId: 'TEST-WORKER-A',
        status: 'ASSIGNED',
        createdAt: new Date('2026-08-13T12:00:00.000Z'),
        worker: workerById.get('TEST-WORKER-A')
      },
      {
        id: 'TEST-ASSIGNMENT-B',
        workerId: 'TEST-WORKER-B',
        status: 'CONFIRMED',
        createdAt: new Date('2026-08-13T12:01:00.000Z'),
        worker: workerById.get('TEST-WORKER-B')
      }
    ]
  };

  function matchesWhere(event, where = {}) {
    if (where.entityType && event.entityType !== where.entityType) return false;
    if (where.action && event.action !== where.action) return false;
    if (where.entityId) {
      if (typeof where.entityId === 'string' && event.entityId !== where.entityId) return false;
      if (where.entityId.in && !where.entityId.in.includes(event.entityId)) return false;
    }
    return true;
  }

  function orderedEvents(where) {
    return events
      .filter((event) => matchesWhere(event, where))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  function assignmentMatches(assignment, where = {}) {
    if (where.id && assignment.id !== where.id) return false;
    if (where.serviceRequestId && assignment.serviceRequestId !== where.serviceRequestId) return false;
    if (where.workerId) {
      if (typeof where.workerId === 'string' && assignment.workerId !== where.workerId) return false;
      if (where.workerId.not && assignment.workerId === where.workerId.not) return false;
    }
    if (where.status) {
      if (typeof where.status === 'string' && assignment.status !== where.status) return false;
      if (where.status.in && !where.status.in.includes(assignment.status)) return false;
    }
    return true;
  }

  function assignmentRecord(assignment) {
    if (!assignment) return null;
    return {
      ...assignment,
      serviceRequestId: service.id,
      worker: assignment.worker || workerById.get(assignment.workerId) || null,
      serviceRequest: {
        id: service.id,
        operationPointId: service.operationPointId,
        operationPoint: operation
      }
    };
  }

  const prisma = {
    async $transaction(callback) { return callback(prisma); },
    dispatchOperationPoint: {
      async findMany() { return [{ ...operation }]; },
      async findFirst({ where }) { return where.id === operation.id ? { ...operation } : null; }
    },
    dispatchWorker: {
      async findMany() { return workers.map((worker) => ({ ...worker })); },
      async findFirst({ where }) {
        const worker = workerById.get(where.id) || null;
        return worker && (!where.operationalStatus || worker.operationalStatus === where.operationalStatus)
          ? { ...worker }
          : null;
      }
    },
    dispatchServiceRequest: {
      async findMany() {
        return [{ ...service, assignments: service.assignments.map((item) => assignmentRecord(item)) }];
      },
      async findUnique({ where }) {
        return where.id === service.id
          ? { ...service, assignments: service.assignments.map((item) => assignmentRecord(item)) }
          : null;
      }
    },
    dispatchAssignment: {
      async findMany({ where = {} }) {
        return service.assignments
          .map((assignment) => assignmentRecord(assignment))
          .filter((assignment) => assignmentMatches(assignment, where));
      },
      async findUnique({ where }) {
        if (where.id) return assignmentRecord(service.assignments.find((item) => item.id === where.id) || null);
        const composite = where.serviceRequestId_workerId;
        if (!composite) return null;
        return assignmentRecord(service.assignments.find((item) => (
          item.workerId === composite.workerId && service.id === composite.serviceRequestId
        )) || null);
      },
      async create({ data }) {
        assignmentSequence += 1;
        const created = {
          id: `TEST-ASSIGNMENT-${assignmentSequence}`,
          ...data,
          createdAt: new Date(`2026-08-14T13:${String(assignmentSequence).padStart(2, '0')}:00.000Z`),
          worker: workerById.get(data.workerId) || null
        };
        service.assignments.push(created);
        return assignmentRecord(created);
      },
      async update({ where, data }) {
        const current = service.assignments.find((item) => item.id === where.id);
        if (!current) throw new Error('TEST-assignment-not-found');
        Object.assign(current, data);
        return assignmentRecord(current);
      }
    },
    devAuditEvent: {
      async findMany({ where }) { return orderedEvents(where); },
      async findFirst({ where }) { return orderedEvents(where)[0] || null; },
      async create({ data }) {
        eventSequence += 1;
        const event = {
          id: `TEST-AUDIT-${eventSequence}`,
          ...data,
          createdAt: new Date(`2026-08-14T12:${String(eventSequence).padStart(2, '0')}:00.000Z`)
        };
        events.push(event);
        return event;
      }
    }
  };

  return { prisma, operation, service, events };
}

const actor = Object.freeze({
  actorUsername: 'TEST-COORDINATOR',
  actorRole: 'dev',
  ipAddress: '127.0.0.1',
  userAgent: 'TEST-AGENT'
});

async function enableCrew(prisma, operationPointId) {
  return saveCrewAttendanceOperationCapability(prisma, { operationPointId, allowed: true, ...actor });
}

test('no permite habilitar cuadrillas si Asistencia no está habilitada en la operación', async () => {
  const { prisma, operation, events } = testFixture({ attendanceEnabled: false });
  await assert.rejects(enableCrew(prisma, operation.id), /crew_attendance_requires_attendance_enabled/);
  assert.equal(events.length, 0);
});

test('persiste capacidad y expone personal contratado para seleccionar encargado', async () => {
  const { prisma, operation, events } = testFixture();
  const first = await enableCrew(prisma, operation.id);
  const replay = await saveCrewAttendanceOperationCapability(prisma, {
    operationPointId: operation.id,
    allowed: 'true',
    ...actor
  });
  assert.equal(first.changed, true);
  assert.equal(replay.changed, false);
  assert.equal(events.length, 1);
  assert.equal(events[0].entityType, CREW_ATTENDANCE_OPERATION_ENTITY_TYPE);
  assert.equal(events[0].action, CREW_ATTENDANCE_CONFIG_ACTION);
  const loaded = await loadCrewAttendanceConfiguration(prisma, { from: '2026-08-14', to: '2026-08-14' });
  assert.equal(loaded.leaderCandidates.length, 3);
  assert.match(loaded.leaderCandidates.find((item) => item.id === 'TEST-WORKER-LEADER').label, /Encargado Prueba/);
});

test('Cuadrilla exige encargado contratado pero no exige que ya consuma un cupo auxiliar', async () => {
  const { prisma, operation, service } = testFixture();
  await enableCrew(prisma, operation.id);
  await assert.rejects(saveCrewAttendanceServiceConfiguration(prisma, {
    serviceRequestId: service.id,
    mode: CREW_ATTENDANCE_MODE.CREW,
    ...actor
  }), /crew_attendance_leader_required/);
  await assert.rejects(saveCrewAttendanceServiceConfiguration(prisma, {
    serviceRequestId: service.id,
    mode: CREW_ATTENDANCE_MODE.CREW,
    crewLeaderWorkerId: 'TEST-WORKER-NOT-AVAILABLE',
    ...actor
  }), /crew_attendance_leader_not_available/);
});

test('crea al encargado dentro de la petición sin aumentar la cobertura requerida', async () => {
  const { prisma, operation, service } = testFixture();
  await enableCrew(prisma, operation.id);
  const saved = await saveCrewAttendanceServiceConfiguration(prisma, {
    serviceRequestId: service.id,
    mode: CREW_ATTENDANCE_MODE.CREW,
    crewLeaderWorkerId: 'TEST-WORKER-LEADER',
    ...actor
  });
  assert.equal(saved.assignmentStatus, CREW_LEADER_ASSIGNMENT_STATUS);
  const leaderAssignment = service.assignments.find((item) => item.workerId === 'TEST-WORKER-LEADER');
  assert.equal(leaderAssignment.status, CREW_LEADER_ASSIGNMENT_STATUS);
  assert.match(leaderAssignment.notes, /Encargado \/ Líder de cuadrilla/);
  assert.equal(COVERAGE_ASSIGNMENT_STATUSES.includes(CREW_LEADER_ASSIGNMENT_STATUS), false);
  assert.equal(ATTENDANCE_ASSIGNMENT_STATUSES.includes(CREW_LEADER_ASSIGNMENT_STATUS), true);
  const coverage = deriveDispatchRequestOperationalState(service);
  assert.equal(coverage.requiredWorkers, 2);
  assert.equal(coverage.activeCount, 2);
  assert.equal(coverage.confirmedCount, 1);
  const loaded = await loadCrewAttendanceConfiguration(prisma, { from: '2026-08-14', to: '2026-08-14' });
  assert.equal(loaded.services[0].crewLeaderAssignmentStatus, CREW_LEADER_ASSIGNMENT_STATUS);
  assert.equal(loaded.services[0].assignments.length, 2);
  assert.equal(loaded.services[0].leaderValid, true);
  const contexts = await loadCrewAttendancePortalContexts(prisma, { workerId: 'TEST-WORKER-LEADER' });
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].assignmentStatus, CREW_LEADER_ASSIGNMENT_STATUS);
  assert.equal(contexts[0].isCrewLeader, true);
  assert.equal(contexts[0].proximityRequired, true);
});

test('si un auxiliar pasa a encargado deja de contar como cupo y al volver a Individual recupera su estado', async () => {
  const { prisma, operation, service } = testFixture();
  await enableCrew(prisma, operation.id);
  await saveCrewAttendanceServiceConfiguration(prisma, {
    serviceRequestId: service.id,
    mode: CREW_ATTENDANCE_MODE.CREW,
    crewLeaderWorkerId: 'TEST-WORKER-A',
    ...actor
  });
  assert.equal(service.assignments.find((item) => item.workerId === 'TEST-WORKER-A').status, CREW_LEADER_ASSIGNMENT_STATUS);
  assert.equal(deriveDispatchRequestOperationalState(service).activeCount, 1);
  await saveCrewAttendanceServiceConfiguration(prisma, {
    serviceRequestId: service.id,
    mode: CREW_ATTENDANCE_MODE.INDIVIDUAL,
    ...actor
  });
  assert.equal(service.assignments.find((item) => item.workerId === 'TEST-WORKER-A').status, 'ASSIGNED');
  assert.equal(deriveDispatchRequestOperationalState(service).activeCount, 2);
});

test('cambiar encargado deja una sola asignación CREW_LEADER activa y conserva historial anterior', async () => {
  const { prisma, operation, service } = testFixture();
  await enableCrew(prisma, operation.id);
  await saveCrewAttendanceServiceConfiguration(prisma, {
    serviceRequestId: service.id,
    mode: CREW_ATTENDANCE_MODE.CREW,
    crewLeaderWorkerId: 'TEST-WORKER-LEADER',
    ...actor
  });
  await saveCrewAttendanceServiceConfiguration(prisma, {
    serviceRequestId: service.id,
    mode: CREW_ATTENDANCE_MODE.CREW,
    crewLeaderWorkerId: 'TEST-WORKER-B',
    ...actor
  });
  const activeLeaders = service.assignments.filter((item) => item.status === CREW_LEADER_ASSIGNMENT_STATUS);
  assert.equal(activeLeaders.length, 1);
  assert.equal(activeLeaders[0].workerId, 'TEST-WORKER-B');
  assert.equal(service.assignments.find((item) => item.workerId === 'TEST-WORKER-LEADER').status, 'CANCELLED');
});

test('fan-out registra primero al encargado y delega solo sobre auxiliares de cobertura', async () => {
  const calls = [];
  const reviews = [];
  const prisma = {
    dispatchAssignment: {
      async findMany() {
        return [
          { id: 'TEST-ASSIGNMENT-A', workerId: 'TEST-WORKER-A' },
          { id: 'TEST-ASSIGNMENT-B', workerId: 'TEST-WORKER-B' }
        ];
      }
    }
  };
  const result = await registerCrewArrivalForLeader(prisma, {
    leaderWorkerId: 'TEST-WORKER-LEADER',
    assignmentId: 'TEST-ASSIGNMENT-LEADER',
    idempotencyKey: 'TEST-CREW-ARRIVAL-KEY',
    captureMode: 'ONLINE_WEB',
    now: new Date('2026-08-14T12:00:00.000Z'),
    latitude: 4.7,
    longitude: -74.1,
    accuracyMeters: 10,
    installationIdHash: 'TEST-INSTALLATION-HASH'
  }, {
    async loadCrewContextsFn() {
      return [{ assignmentId: 'TEST-ASSIGNMENT-LEADER', serviceRequestId: 'TEST-SERVICE-CREW', mode: 'CREW', isCrewLeader: true, crewAvailable: true }];
    },
    async registerArrivalFn(_prisma, input) {
      calls.push(input);
      const isLeader = input.assignmentId === 'TEST-ASSIGNMENT-LEADER';
      return {
        recorded: true,
        replayed: false,
        attendanceSession: { id: `SESSION-${input.assignmentId}`, validationStatus: isLeader ? 'AUTO_VALIDATED' : 'REVIEW_REQUIRED' },
        validation: { validationStatus: isLeader ? 'AUTO_VALIDATED' : 'REVIEW_REQUIRED', reportedPunctuality: 'ON_TIME', riskFlags: [] }
      };
    },
    async reviewAttendanceFn(_prisma, input) { reviews.push(input); return { ok: true }; }
  });
  assert.deepEqual(calls.map((item) => item.assignmentId), ['TEST-ASSIGNMENT-LEADER', 'TEST-ASSIGNMENT-A', 'TEST-ASSIGNMENT-B']);
  assert.equal(reviews.length, 2);
  assert.equal(result.summary.totalMembers, 3);
  assert.equal(result.summary.delegatedCount, 2);
});

test('deshabilitar la operación actúa como kill switch sin borrar el encargado histórico', async () => {
  const { prisma, operation, service } = testFixture();
  await enableCrew(prisma, operation.id);
  await saveCrewAttendanceServiceConfiguration(prisma, {
    serviceRequestId: service.id,
    mode: CREW_ATTENDANCE_MODE.CREW,
    crewLeaderWorkerId: 'TEST-WORKER-LEADER',
    ...actor
  });
  await saveCrewAttendanceOperationCapability(prisma, { operationPointId: operation.id, allowed: false, ...actor });
  const loaded = await loadCrewAttendanceConfiguration(prisma, { from: '2026-08-14', to: '2026-08-14' });
  assert.equal(loaded.operations[0].crewAttendanceAllowed, false);
  assert.equal(loaded.services[0].mode, CREW_ATTENDANCE_MODE.CREW);
  assert.equal(loaded.services[0].crewLeaderWorkerId, 'TEST-WORKER-LEADER');
  assert.equal(loaded.services[0].crewAvailable, false);
  assert.equal(loaded.services[0].configurationReady, false);
});

test('UI explica Personal operativo y el tablero de petición conserva todas las asignaciones visibles', async () => {
  const [route, loader, ui, operationsView, assignmentView] = await Promise.all([
    readFile(new URL('../src/routes/dispatchAttendanceAdmin.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/public/attendance-admin-runtime.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/public/attendance-admin-crew.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/views/operacionesClienteOperaciones.ejs', import.meta.url), 'utf8'),
    readFile(new URL('../src/views/operacionesAsignacionesConfirmacion.ejs', import.meta.url), 'utf8')
  ]);
  assert.match(route, /\/cuadrillas\/config/);
  assert.doesNotMatch(loader, /attendance-admin-crew\.js/);
  assert.match(operationsView, /details class="crud-details attendance-config"/);
  assert.match(operationsView, /attendance-admin-crew\.js/);
  assert.match(ui, /Encargado \/ líder de cuadrilla/);
  assert.match(ui, /Personal operativo/);
  assert.match(ui, /no aumenta la cobertura|sin consumir cupo/i);
  assert.doesNotMatch(ui, /Selecciona un auxiliar asignado/);
  assert.doesNotMatch(ui, /navigator\.bluetooth/);
  assert.match(assignmentView, /selectedServiceRequest\.assignments\.forEach/);
  assert.match(assignmentView, /activeCodes=\['ASSIGNED','CONFIRMATION_PENDING','CONFIRMED'\]/);
});
