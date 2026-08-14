import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CREW_ATTENDANCE_CONFIG_ACTION,
  CREW_ATTENDANCE_MODE,
  CREW_ATTENDANCE_OPERATION_ENTITY_TYPE,
  CREW_ATTENDANCE_SERVICE_ENTITY_TYPE,
  loadCrewAttendanceConfiguration,
  loadCrewAttendancePortalContexts,
  saveCrewAttendanceOperationCapability,
  saveCrewAttendanceServiceConfiguration
} from '../src/modules/dispatch-attendance/application/crewAttendanceConfig.js';
import { ACTIVE_DISPATCH_ASSIGNMENT_STATUSES } from '../src/services/dispatchOperationalCoverage.js';

function testFixture({
  attendanceEnabled = true,
  requiredWorkers = 2,
  assignmentCount = 2,
  serviceCreatedAt = '2026-08-14T12:01:30.000Z'
} = {}) {
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
    id: `TEST-ASSIGNMENT-${String(index + 1).padStart(2, '0')}`,
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
    createdAt: new Date(serviceCreatedAt),
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
    if (where.createdAt?.lte) {
      const limit = where.createdAt.lte instanceof Date ? where.createdAt.lte : new Date(where.createdAt.lte);
      if (event.createdAt.getTime() > limit.getTime()) return false;
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
    dispatchAssignment: {
      async findMany({ where }) {
        return service.assignments
          .filter((assignment) => assignment.workerId === where.workerId)
          .filter((assignment) => ACTIVE_DISPATCH_ASSIGNMENT_STATUSES.includes(assignment.status))
          .map((assignment) => ({
            id: assignment.id,
            workerId: assignment.workerId,
            serviceRequest: {
              id: service.id,
              operationPointId: service.operationPointId,
              createdAt: service.createdAt,
              operationPoint: {
                id: operation.id,
                isActive: operation.isActive,
                attendanceEnabled: operation.attendanceEnabled
              }
            }
          }));
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

test('una solicitud creada después de habilitar la operación hereda Cuadrilla sin configuración manual del turno', async () => {
  const { prisma, operation, events } = testFixture();
  await saveCrewAttendanceOperationCapability(prisma, {
    operationPointId: operation.id,
    allowed: true,
    ...actor
  });

  const loaded = await loadCrewAttendanceConfiguration(prisma, {
    from: '2026-08-14',
    to: '2026-08-14'
  });
  const service = loaded.services[0];
  assert.equal(service.crewEnabledAtCreation, true);
  assert.equal(service.crewEligible, true);
  assert.equal(service.crewEligibilitySource, 'OPERATION_AT_CREATION');
  assert.equal(service.mode, CREW_ATTENDANCE_MODE.CREW);
  assert.equal(service.crewLeaderWorkerId, null);
  assert.equal(service.crewAvailable, true);
  assert.equal(service.configurationReady, false);
  assert.equal(events.filter((event) => event.entityType === CREW_ATTENDANCE_SERVICE_ENTITY_TYPE).length, 0);

  const [portalContext] = await loadCrewAttendancePortalContexts(prisma, { workerId: 'TEST-WORKER-01' });
  assert.equal(portalContext.mode, CREW_ATTENDANCE_MODE.CREW);
  assert.equal(portalContext.crewEnabledAtCreation, true);
  assert.equal(portalContext.crewEligible, true);
  assert.equal(portalContext.isCrewLeader, false);
  assert.equal(portalContext.crewAvailable, true);
  assert.equal(portalContext.proximityRequired, false);
});

test('habilitar la operación después no convierte retroactivamente una solicitud antigua en cuadrilla', async () => {
  const { prisma, operation, service, events } = testFixture({
    serviceCreatedAt: '2026-08-14T12:00:30.000Z'
  });
  await saveCrewAttendanceOperationCapability(prisma, {
    operationPointId: operation.id,
    allowed: true,
    ...actor
  });

  const loaded = await loadCrewAttendanceConfiguration(prisma, {
    from: '2026-08-14',
    to: '2026-08-14'
  });
  assert.equal(loaded.services[0].crewEnabledAtCreation, false);
  assert.equal(loaded.services[0].crewEligible, false);
  assert.equal(loaded.services[0].mode, CREW_ATTENDANCE_MODE.INDIVIDUAL);
  assert.equal(loaded.services[0].crewAvailable, false);

  await assert.rejects(
    saveCrewAttendanceServiceConfiguration(prisma, {
      serviceRequestId: service.id,
      mode: CREW_ATTENDANCE_MODE.CREW,
      crewLeaderWorkerId: 'TEST-WORKER-01',
      ...actor
    }),
    /crew_attendance_service_not_crew_eligible/
  );
  assert.equal(events.filter((event) => event.entityType === CREW_ATTENDANCE_SERVICE_ENTITY_TYPE).length, 0);
});

test('el encargado es una de las personas requeridas y elegirlo no altera estados ni cobertura', async () => {
  const { prisma, operation, service } = testFixture({ requiredWorkers: 10, assignmentCount: 10 });
  const statusesBefore = service.assignments.map((assignment) => assignment.status);
  assert.equal(service.assignments.filter((assignment) => ACTIVE_DISPATCH_ASSIGNMENT_STATUSES.includes(assignment.status)).length, 10);

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

test('cambiar encargado solo reemplaza crewLeaderWorkerId y no muta las asignaciones', async () => {
  const { prisma, operation, service, events } = testFixture();
  const statusesBefore = service.assignments.map((assignment) => assignment.status);
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
  assert.deepEqual(service.assignments.map((assignment) => assignment.status), statusesBefore);
  const serviceEvents = events.filter((event) => event.entityType === CREW_ATTENDANCE_SERVICE_ENTITY_TYPE);
  assert.equal(serviceEvents.length, 2);
  assert.deepEqual(serviceEvents.at(-1).metadata, {
    mode: CREW_ATTENDANCE_MODE.CREW,
    crewLeaderWorkerId: 'TEST-WORKER-02'
  });
});

test('deshabilitar la operación actúa como kill switch sin borrar elegibilidad ni encargado histórico', async () => {
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
  assert.equal(loaded.services[0].crewEnabledAtCreation, true);
  assert.equal(loaded.services[0].crewEligible, true);
  assert.equal(loaded.services[0].mode, CREW_ATTENDANCE_MODE.CREW);
  assert.equal(loaded.services[0].crewLeaderWorkerId, 'TEST-WORKER-02');
  assert.equal(loaded.services[0].crewAvailable, false);
  assert.equal(loaded.services[0].configurationReady, false);
});

test('la UI habilita cuadrilla en la operación y el check del encargado solo vive en Asignaciones', async () => {
  const [operationUi, assignmentLoader, assignmentUi, assignmentView, crewArrival, workerPortalUi, arrival, breakMark] = await Promise.all([
    readFile(new URL('../src/public/attendance-admin-crew.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/public/service-request-delete-confirm.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/public/dispatch-assignment-crew-leader.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/views/operacionesAsignacionesConfirmacion.ejs', import.meta.url), 'utf8'),
    readFile(new URL('../src/modules/dispatch-attendance/application/registerCrewArrival.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/public/worker-biometric.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/modules/dispatch-attendance/application/registerArrival.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/modules/dispatch-attendance/application/registerBreak.js', import.meta.url), 'utf8')
  ]);

  assert.deepEqual(ACTIVE_DISPATCH_ASSIGNMENT_STATUSES, [
    'ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'
  ]);

  assert.match(operationUi, /Permitir marcación por cuadrilla/);
  assert.match(operationUi, /Debe quedar habilitado antes de crear la solicitud/);
  assert.match(operationUi, /no se activa retroactivamente/i);
  assert.match(operationUi, /Operaciones → Asignaciones/);
  assert.doesNotMatch(operationUi, /Modalidad de marcación/);
  assert.doesNotMatch(operationUi, /Guardar modalidad del turno/);

  assert.match(assignmentView, /service-request-delete-confirm\.js/);
  assert.match(assignmentView, /activeCodes=\['ASSIGNED','CONFIRMATION_PENDING','CONFIRMED'\]/);
  assert.match(assignmentView, /Asignados activos: <%= activeCount %> \/ <%= request\.requiredWorkers %>/);
  assert.match(assignmentLoader, /dispatch-assignment-crew-leader\.js/);
  assert.match(assignmentUi, /service\.crewEligible !== true/);
  assert.match(assignmentUi, /Encargado de cuadrilla/);
  assert.match(assignmentUi, /Encargado \/ Líder de cuadrilla/);
  assert.match(assignmentUi, /Esta persona hace parte del total requerido/);
  assert.match(assignmentUi, /crewLeaderWorkerId: selected \? workerId : ''/);
  assert.match(assignmentUi, /service\.assignments/);

  assert.match(workerPortalUi, /Marcar llegada de toda la cuadrilla/);
  assert.match(workerPortalUi, /verifyCrewBluetooth\(context\)/);
  assert.match(workerPortalUi, /Registrando la llegada de toda la cuadrilla/);
  assert.match(crewArrival, /members\.filter\(\(member\) => member\.id === leaderAssignmentId\)/);
  assert.match(crewArrival, /members\.filter\(\(member\) => member\.id !== leaderAssignmentId\)/);
  assert.doesNotMatch(`${crewArrival}\n${arrival}\n${breakMark}`, /CREW_LEADER/);
});
