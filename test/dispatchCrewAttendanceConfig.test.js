import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CREW_ATTENDANCE_CONFIG_ACTION,
  CREW_ATTENDANCE_MODE,
  CREW_ATTENDANCE_OPERATION_ENTITY_TYPE,
  CREW_ATTENDANCE_SERVICE_ENTITY_TYPE,
  loadCrewAttendanceConfiguration,
  saveCrewAttendanceOperationCapability,
  saveCrewAttendanceServiceConfiguration
} from '../src/modules/dispatch-attendance/application/crewAttendanceConfig.js';
import { ACTIVE_DISPATCH_ASSIGNMENT_STATUSES } from '../src/services/dispatchOperationalCoverage.js';

function testFixture({ attendanceEnabled = true, requiredWorkers = 2, assignmentCount = 2 } = {}) {
  const events = [];
  let sequence = 0;
  const operation = {
    id: 'TEST-OP-CREW',
    clientId: 'TEST-CLIENT-CREW',
    name: 'Operación Prueba Cuadrilla',
    cityName: 'Ciudad Prueba',
    isActive: true,
    attendanceEnabled,
    client: { id: 'TEST-CLIENT-CREW', name: 'Cliente Prueba Cuadrilla' }
  };
  const assignments = Array.from({ length: assignmentCount }, (_, index) => ({
    workerId: `TEST-WORKER-${String(index + 1).padStart(2, '0')}`,
    status: index === 0 ? 'CONFIRMED' : 'ASSIGNED',
    createdAt: new Date(`2026-08-13T12:${String(index).padStart(2, '0')}:00.000Z`),
    worker: {
      id: `TEST-WORKER-${String(index + 1).padStart(2, '0')}`,
      fullName: `Persona Prueba ${index + 1}`
    }
  }));
  const service = {
    id: 'TEST-SERVICE-CREW',
    operationPointId: operation.id,
    clientName: operation.client.name,
    operationPointName: operation.name,
    serviceDate: new Date('2026-08-14T00:00:00.000Z'),
    startTime: '07:00',
    endTime: '16:00',
    status: assignmentCount >= requiredWorkers ? 'PENDING_CONFIRMATION' : 'ASSIGNMENT_PARTIAL',
    requiredWorkers,
    operationPoint: operation,
    assignments
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

  const prisma = {
    dispatchOperationPoint: {
      async findMany() { return [{ ...operation }]; },
      async findFirst({ where }) { return where.id === operation.id ? { ...operation } : null; }
    },
    dispatchServiceRequest: {
      async findMany() {
        return [{ ...service, assignments: service.assignments.map((item) => ({ ...item })) }];
      },
      async findUnique({ where }) {
        return where.id === service.id
          ? { ...service, assignments: service.assignments.map((item) => ({ ...item })) }
          : null;
      }
    },
    devAuditEvent: {
      async findMany({ where }) { return orderedEvents(where); },
      async findFirst({ where }) { return orderedEvents(where)[0] || null; },
      async create({ data }) {
        sequence += 1;
        const event = {
          id: `TEST-AUDIT-${sequence}`,
          ...data,
          createdAt: new Date(`2026-08-14T12:${String(sequence).padStart(2, '0')}:00.000Z`)
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

test('no permite habilitar cuadrillas si Asistencia no está habilitada en la operación', async () => {
  const { prisma, operation, events } = testFixture({ attendanceEnabled: false });
  await assert.rejects(
    saveCrewAttendanceOperationCapability(prisma, {
      operationPointId: operation.id,
      allowed: true,
      ...actor
    }),
    /crew_attendance_requires_attendance_enabled/
  );
  assert.equal(events.length, 0);
});

test('persiste la capacidad de operación de forma auditada e idempotente', async () => {
  const { prisma, operation, events } = testFixture();
  const first = await saveCrewAttendanceOperationCapability(prisma, {
    operationPointId: operation.id,
    allowed: true,
    ...actor
  });
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
  assert.deepEqual(events[0].metadata, { allowed: true });
});

test('permite preparar el modo Cuadrilla antes de elegir encargado y exige que cualquier encargado indicado esté asignado', async () => {
  const { prisma, operation, service } = testFixture();
  await saveCrewAttendanceOperationCapability(prisma, {
    operationPointId: operation.id,
    allowed: true,
    ...actor
  });

  const prepared = await saveCrewAttendanceServiceConfiguration(prisma, {
    serviceRequestId: service.id,
    mode: CREW_ATTENDANCE_MODE.CREW,
    ...actor
  });
  assert.equal(prepared.mode, CREW_ATTENDANCE_MODE.CREW);
  assert.equal(prepared.crewLeaderWorkerId, null);

  const loaded = await loadCrewAttendanceConfiguration(prisma, {
    from: '2026-08-14',
    to: '2026-08-14'
  });
  assert.equal(loaded.services[0].mode, CREW_ATTENDANCE_MODE.CREW);
  assert.equal(loaded.services[0].crewLeaderWorkerId, null);
  assert.equal(loaded.services[0].leaderValid, false);
  assert.equal(loaded.services[0].configurationReady, false);

  await assert.rejects(
    saveCrewAttendanceServiceConfiguration(prisma, {
      serviceRequestId: service.id,
      mode: CREW_ATTENDANCE_MODE.CREW,
      crewLeaderWorkerId: 'TEST-WORKER-NOT-ASSIGNED',
      ...actor
    }),
    /crew_attendance_leader_not_assigned/
  );
});

test('el encargado es una de las personas requeridas y elegirlo no altera estados ni cobertura', async () => {
  const { prisma, operation, service } = testFixture({ requiredWorkers: 10, assignmentCount: 10 });
  const statusesBefore = service.assignments.map((assignment) => assignment.status);
  const activeBefore = service.assignments.filter((assignment) => ACTIVE_DISPATCH_ASSIGNMENT_STATUSES.includes(assignment.status)).length;
  assert.equal(activeBefore, 10);

  await saveCrewAttendanceOperationCapability(prisma, {
    operationPointId: operation.id,
    allowed: true,
    ...actor
  });
  const saved = await saveCrewAttendanceServiceConfiguration(prisma, {
    serviceRequestId: service.id,
    mode: CREW_ATTENDANCE_MODE.CREW,
    crewLeaderWorkerId: 'TEST-WORKER-01',
    ...actor
  });

  assert.equal(saved.crewLeaderWorkerId, 'TEST-WORKER-01');
  assert.deepEqual(service.assignments.map((assignment) => assignment.status), statusesBefore);
  assert.equal(service.assignments.filter((assignment) => ACTIVE_DISPATCH_ASSIGNMENT_STATUSES.includes(assignment.status)).length, 10);

  const loaded = await loadCrewAttendanceConfiguration(prisma, {
    from: '2026-08-14',
    to: '2026-08-14'
  });
  assert.equal(loaded.services[0].requiredWorkers, 10);
  assert.equal(loaded.services[0].assignments.length, 10);
  assert.equal(loaded.services[0].crewLeaderWorkerId, 'TEST-WORKER-01');
  assert.equal(loaded.services[0].leaderValid, true);
  assert.equal(loaded.services[0].configurationReady, true);
});

test('cambiar de encargado solo reemplaza crewLeaderWorkerId y volver a Individual lo limpia', async () => {
  const { prisma, operation, service, events } = testFixture();
  await saveCrewAttendanceOperationCapability(prisma, {
    operationPointId: operation.id,
    allowed: true,
    ...actor
  });
  await saveCrewAttendanceServiceConfiguration(prisma, {
    serviceRequestId: service.id,
    mode: CREW_ATTENDANCE_MODE.CREW,
    crewLeaderWorkerId: 'TEST-WORKER-01',
    ...actor
  });
  const changed = await saveCrewAttendanceServiceConfiguration(prisma, {
    serviceRequestId: service.id,
    mode: CREW_ATTENDANCE_MODE.CREW,
    crewLeaderWorkerId: 'TEST-WORKER-02',
    ...actor
  });
  assert.equal(changed.crewLeaderWorkerId, 'TEST-WORKER-02');

  const individual = await saveCrewAttendanceServiceConfiguration(prisma, {
    serviceRequestId: service.id,
    mode: CREW_ATTENDANCE_MODE.INDIVIDUAL,
    crewLeaderWorkerId: 'TEST-WORKER-02',
    ...actor
  });
  assert.equal(individual.crewLeaderWorkerId, null);

  const serviceEvents = events.filter((event) => event.entityType === CREW_ATTENDANCE_SERVICE_ENTITY_TYPE);
  assert.equal(serviceEvents.length, 3);
  assert.deepEqual(serviceEvents.at(-1).metadata, {
    mode: CREW_ATTENDANCE_MODE.INDIVIDUAL,
    crewLeaderWorkerId: null
  });
});

test('deshabilitar la operación actúa como kill switch sin borrar el encargado histórico del servicio', async () => {
  const { prisma, operation, service } = testFixture();
  await saveCrewAttendanceOperationCapability(prisma, {
    operationPointId: operation.id,
    allowed: true,
    ...actor
  });
  await saveCrewAttendanceServiceConfiguration(prisma, {
    serviceRequestId: service.id,
    mode: CREW_ATTENDANCE_MODE.CREW,
    crewLeaderWorkerId: 'TEST-WORKER-02',
    ...actor
  });
  await saveCrewAttendanceOperationCapability(prisma, {
    operationPointId: operation.id,
    allowed: false,
    ...actor
  });

  const loaded = await loadCrewAttendanceConfiguration(prisma, {
    from: '2026-08-14',
    to: '2026-08-14'
  });
  assert.equal(loaded.operations[0].crewAttendanceAllowed, false);
  assert.equal(loaded.services[0].mode, CREW_ATTENDANCE_MODE.CREW);
  assert.equal(loaded.services[0].crewLeaderWorkerId, 'TEST-WORKER-02');
  assert.equal(loaded.services[0].crewAvailable, false);
  assert.equal(loaded.services[0].configurationReady, false);
});

test('la UI configura modalidad en la operación pero el encargado se marca desde Asignaciones', async () => {
  const [operationUi, assignmentLoader, assignmentUi, assignmentView, crewArrival, arrival, breakMark] = await Promise.all([
    readFile(new URL('../src/public/attendance-admin-crew.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/public/service-request-delete-confirm.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/public/dispatch-assignment-crew-leader.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/views/operacionesAsignacionesConfirmacion.ejs', import.meta.url), 'utf8'),
    readFile(new URL('../src/modules/dispatch-attendance/application/registerCrewArrival.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/modules/dispatch-attendance/application/registerArrival.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/modules/dispatch-attendance/application/registerBreak.js', import.meta.url), 'utf8')
  ]);

  assert.deepEqual(ACTIVE_DISPATCH_ASSIGNMENT_STATUSES, [
    'ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'
  ]);

  assert.match(operationUi, /Permitir marcación por cuadrilla/);
  assert.match(operationUi, /Modalidad de marcación/);
  assert.match(operationUi, /El encargado no es una persona adicional/);
  assert.match(operationUi, /Operaciones → Asignaciones/);
  assert.doesNotMatch(operationUi, /Responsable de la cuadrilla/);

  assert.match(assignmentView, /service-request-delete-confirm\.js/);
  assert.match(assignmentView, /activeCodes=\['ASSIGNED','CONFIRMATION_PENDING','CONFIRMED'\]/);
  assert.match(assignmentView, /Asignados activos: <%= activeCount %> \/ <%= request\.requiredWorkers %>/);
  assert.match(assignmentLoader, /dispatch-assignment-crew-leader\.js/);
  assert.match(assignmentUi, /Encargado de cuadrilla/);
  assert.match(assignmentUi, /Encargado \/ Líder de cuadrilla/);
  assert.match(assignmentUi, /Esta persona hace parte del total requerido/);
  assert.match(assignmentUi, /crewLeaderWorkerId: selected \? workerId : ''/);
  assert.match(assignmentUi, /service\.assignments/);

  assert.match(crewArrival, /members\.filter\(\(member\) => member\.id === leaderAssignmentId\)/);
  assert.match(crewArrival, /members\.filter\(\(member\) => member\.id !== leaderAssignmentId\)/);
  assert.doesNotMatch(`${crewArrival}\n${arrival}\n${breakMark}`, /CREW_LEADER/);
});
