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

function testFixture({ attendanceEnabled = true } = {}) {
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
  const service = {
    id: 'TEST-SERVICE-CREW',
    operationPointId: operation.id,
    clientName: operation.client.name,
    operationPointName: operation.name,
    serviceDate: new Date('2026-08-14T00:00:00.000Z'),
    startTime: '07:00',
    endTime: '16:00',
    status: 'ASSIGNMENT_PARTIAL',
    requiredWorkers: 2,
    operationPoint: operation,
    assignments: [
      {
        workerId: 'TEST-WORKER-A',
        status: 'ASSIGNED',
        createdAt: new Date('2026-08-13T12:00:00.000Z'),
        worker: { id: 'TEST-WORKER-A', fullName: 'Auxiliar Prueba A' }
      },
      {
        workerId: 'TEST-WORKER-B',
        status: 'CONFIRMED',
        createdAt: new Date('2026-08-13T12:01:00.000Z'),
        worker: { id: 'TEST-WORKER-B', fullName: 'Auxiliar Prueba B' }
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

  const prisma = {
    dispatchOperationPoint: {
      async findMany() { return [{ ...operation }]; },
      async findFirst({ where }) { return where.id === operation.id ? { ...operation } : null; }
    },
    dispatchServiceRequest: {
      async findMany() { return [{ ...service, assignments: service.assignments.map((item) => ({ ...item })) }]; },
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
  assert.equal(events[0].metadata.actorUsername, undefined);

  const loaded = await loadCrewAttendanceConfiguration(
    prisma,
    { from: '2026-08-14', to: '2026-08-14' },
    { now: new Date('2026-08-14T15:00:00.000Z') }
  );
  assert.equal(loaded.operations[0].crewAttendanceAllowed, true);
  assert.equal(loaded.operations[0].crewAvailable, true);
});

test('Cuadrilla exige un responsable que tenga asignación activa en el mismo servicio', async () => {
  const { prisma, operation, service } = testFixture();
  await saveCrewAttendanceOperationCapability(prisma, {
    operationPointId: operation.id,
    allowed: true,
    ...actor
  });

  await assert.rejects(
    saveCrewAttendanceServiceConfiguration(prisma, {
      serviceRequestId: service.id,
      mode: CREW_ATTENDANCE_MODE.CREW,
      ...actor
    }),
    /crew_attendance_leader_required/
  );

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

test('guarda Cuadrilla con responsable válido y volver a Individual limpia el responsable', async () => {
  const { prisma, operation, service, events } = testFixture();
  await saveCrewAttendanceOperationCapability(prisma, {
    operationPointId: operation.id,
    allowed: true,
    ...actor
  });
  const crew = await saveCrewAttendanceServiceConfiguration(prisma, {
    serviceRequestId: service.id,
    mode: CREW_ATTENDANCE_MODE.CREW,
    crewLeaderWorkerId: 'TEST-WORKER-A',
    ...actor
  });
  assert.equal(crew.crewLeaderWorkerId, 'TEST-WORKER-A');

  let loaded = await loadCrewAttendanceConfiguration(prisma, {
    from: '2026-08-14',
    to: '2026-08-14'
  });
  assert.equal(loaded.services[0].mode, CREW_ATTENDANCE_MODE.CREW);
  assert.equal(loaded.services[0].crewLeaderWorkerId, 'TEST-WORKER-A');
  assert.equal(loaded.services[0].leaderValid, true);
  assert.equal(loaded.services[0].configurationReady, true);

  const individual = await saveCrewAttendanceServiceConfiguration(prisma, {
    serviceRequestId: service.id,
    mode: CREW_ATTENDANCE_MODE.INDIVIDUAL,
    crewLeaderWorkerId: 'TEST-WORKER-A',
    ...actor
  });
  assert.equal(individual.crewLeaderWorkerId, null);
  loaded = await loadCrewAttendanceConfiguration(prisma, {
    from: '2026-08-14',
    to: '2026-08-14'
  });
  assert.equal(loaded.services[0].mode, CREW_ATTENDANCE_MODE.INDIVIDUAL);
  assert.equal(loaded.services[0].crewLeaderWorkerId, null);
  const serviceEvents = events.filter((event) => event.entityType === CREW_ATTENDANCE_SERVICE_ENTITY_TYPE);
  assert.equal(serviceEvents.length, 2);
  assert.deepEqual(serviceEvents.at(-1).metadata, { mode: CREW_ATTENDANCE_MODE.INDIVIDUAL, crewLeaderWorkerId: null });
});

test('deshabilitar la operación actúa como kill switch sin borrar el modo histórico del servicio', async () => {
  const { prisma, operation, service } = testFixture();
  await saveCrewAttendanceOperationCapability(prisma, {
    operationPointId: operation.id,
    allowed: true,
    ...actor
  });
  await saveCrewAttendanceServiceConfiguration(prisma, {
    serviceRequestId: service.id,
    mode: CREW_ATTENDANCE_MODE.CREW,
    crewLeaderWorkerId: 'TEST-WORKER-B',
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
  assert.equal(loaded.services[0].crewLeaderWorkerId, 'TEST-WORKER-B');
  assert.equal(loaded.services[0].crewAvailable, false);
  assert.equal(loaded.services[0].configurationReady, false);
});

test('contrato de transporte y UI mantiene Bluetooth y la marcación grupal fuera de esta fase', async () => {
  const [route, loader, ui] = await Promise.all([
    readFile(new URL('../src/routes/dispatchAttendanceAdmin.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/public/attendance-admin-runtime.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/public/attendance-admin-crew.js', import.meta.url), 'utf8')
  ]);

  assert.match(route, /\/cuadrillas\/config/);
  assert.match(route, /\/cuadrillas\/operaciones\/:operationPointId/);
  assert.match(route, /\/cuadrillas\/servicios\/:serviceRequestId/);
  assert.match(loader, /attendance-admin-crew\.js/);
  assert.match(ui, /Marcación por cuadrillas/);
  assert.match(ui, /Permitir marcación por cuadrilla/);
  assert.match(ui, /Individual/);
  assert.match(ui, /Cuadrilla/);
  assert.match(ui, /Bluetooth y la marcación grupal se habilitarán en una fase posterior/);
  assert.doesNotMatch(ui, /navigator\.bluetooth/);
});
