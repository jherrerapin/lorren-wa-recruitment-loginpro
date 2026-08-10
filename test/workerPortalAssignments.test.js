import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  loadWorkerPortalAssignmentForArrival,
  loadWorkerPortalAssignments
} from '../src/modules/dispatch-attendance/application/workerPortalAssignments.js';

const NOW = new Date('2026-07-22T13:00:00.000Z');

function assignmentFixture(overrides = {}) {
  return {
    id: 'assignment-1',
    workerId: 'worker-1',
    serviceRequestId: 'request-1',
    status: 'CONFIRMED',
    attendanceSession: null,
    serviceRequest: {
      clientName: 'Cliente Prueba',
      operationPointName: 'Centro logístico',
      cityName: 'Bogotá',
      address: 'Carrera 1 # 2-3',
      serviceDate: new Date('2026-07-22T00:00:00.000Z'),
      startTime: '08:30',
      endTime: '17:00',
      operationPoint: {
        name: 'Centro logístico',
        cityName: 'Bogotá',
        address: 'Carrera 1 # 2-3',
        attendanceEnabled: true,
        attendancePhotoPolicy: 'RISK_ONLY'
      },
      ...overrides.serviceRequest
    },
    ...overrides
  };
}

function sessionFixture(overrides = {}) {
  return {
    arrivalReportedAt: NOW,
    departureReportedAt: null,
    validationStatus: 'AUTO_VALIDATED',
    attendanceStatus: 'ON_TIME',
    punctualityStatus: 'ON_TIME',
    workedMinutes: null,
    marks: [],
    ...overrides
  };
}

function prismaWithAssignments(methods, worker = {}) {
  return {
    dispatchAssignment: methods,
    dispatchWorker: {
      async findUnique() {
        return {
          fullName: 'Auxiliar Prueba',
          documentNumber: 'TEST-DOC-001',
          ...worker
        };
      }
    }
  };
}

test('lista asignaciones activas y permite llegada sin ventana temporal', async () => {
  let observedQuery;
  const prisma = prismaWithAssignments({ async findMany(query) { observedQuery = query; return [assignmentFixture()]; } });
  const assignments = await loadWorkerPortalAssignments(prisma, { workerId: 'worker-1', now: NOW });
  assert.equal(observedQuery.where.workerId, 'worker-1');
  assert.deepEqual(observedQuery.where.status.in, ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED']);
  assert.equal(assignments[0].canRegisterArrival, true);
  assert.equal(assignments[0].arrivalWindowExpired, false);
  assert.match(assignments[0].breakLabel, /si no toma almuerzo/i);
  assert.equal(assignments[0].photoRequired, false);
  assert.equal(assignments[0].workerId, undefined);
  assert.deepEqual(assignments.workerIdentity, {
    fullName: 'Auxiliar Prueba',
    documentNumber: 'TEST-DOC-001'
  });
});

test('conserva la fecha operativa de registros históricos y modernos sin desplazarlos al día anterior', async () => {
  const prisma = prismaWithAssignments({
    async findMany() {
      return [
        assignmentFixture({ id: 'legacy', serviceRequest: { serviceDate: new Date('2026-07-22T00:00:00.000Z') } }),
        assignmentFixture({ id: 'modern', serviceRequest: { serviceDate: new Date('2026-07-22T05:00:00.000Z') } })
      ];
    }
  });

  const assignments = await loadWorkerPortalAssignments(prisma, { workerId: 'worker-1', now: NOW });
  assert.equal(assignments.length, 2);
  for (const assignment of assignments) {
    assert.match(assignment.dateLabel, /22 de julio de 2026/i);
    assert.doesNotMatch(assignment.dateLabel, /21 de julio de 2026/i);
    assert.equal(assignment.expectedStartAt, '2026-07-22T13:30:00.000Z');
  }
});

test('el encabezado de Mi jornada presenta nombre y documento obtenidos en servidor', async () => {
  const view = await readFile(new URL('../src/views/workerPortal.ejs', import.meta.url), 'utf8');
  const activeHeader = view.match(/<% } else if \(mode === 'active'\) \{ %>[\s\S]*?<\/header>/)?.[0] || '';

  assert.match(activeHeader, /const portalWorkerIdentity = portalAssignments\.workerIdentity \|\| null/);
  assert.match(activeHeader, /<h1>Mi jornada<\/h1>/);
  assert.match(activeHeader, /portalWorkerIdentity\.fullName/);
  assert.match(activeHeader, /Documento: <%= portalWorkerIdentity\.documentNumber \|\| 'No registrado' %>/);
});

test('conserva una jornada finalizada aunque haya pasado más de un día', async () => {
  const historicalDeparture = new Date('2026-06-01T22:00:00.000Z');
  const prisma = prismaWithAssignments({
    async findMany() {
      return [assignmentFixture({
        serviceRequest: {
          serviceDate: new Date('2026-06-01T00:00:00.000Z'),
          startTime: '08:30',
          endTime: '17:00'
        },
        attendanceSession: sessionFixture({
          arrivalReportedAt: new Date('2026-06-01T13:30:00.000Z'),
          departureReportedAt: historicalDeparture,
          attendanceStatus: 'COMPLETED',
          workedMinutes: 450
        })
      })];
    }
  });

  const assignments = await loadWorkerPortalAssignments(prisma, {
    workerId: 'worker-1',
    now: new Date('2026-07-22T13:00:00.000Z')
  });

  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].departureReportedAt, historicalDeparture.toISOString());
  assert.equal(assignments[0].actionType, 'DONE');
});

test('la consulta puntual exige assignmentId y workerId', async () => {
  let observedWhere;
  const prisma = prismaWithAssignments({ async findFirst(query) { observedWhere = query.where; return assignmentFixture(); } });
  const assignment = await loadWorkerPortalAssignmentForArrival(prisma, { workerId: 'worker-1', assignmentId: 'assignment-1', now: NOW });
  assert.equal(observedWhere.id, 'assignment-1');
  assert.equal(observedWhere.workerId, 'worker-1');
  assert.equal(assignment.id, 'assignment-1');
});

test('permite entrada anticipada y tardía mientras la asignación siga activa', async () => {
  const prisma = prismaWithAssignments({ async findMany() { return [assignmentFixture()]; } });
  const [early] = await loadWorkerPortalAssignments(prisma, { workerId: 'worker-1', now: new Date('2026-07-22T11:00:00.000Z') });
  const [late] = await loadWorkerPortalAssignments(prisma, { workerId: 'worker-1', now: new Date('2026-07-23T13:45:01.000Z') });
  assert.equal(early.canRegisterArrival, true);
  assert.equal(late.canRegisterArrival, true);
  assert.equal(late.actionLabel, 'Registrar llegada');
});

test('después de la llegada ofrece almuerzo opcional y salida', async () => {
  const prisma = prismaWithAssignments({ async findMany() { return [assignmentFixture({ attendanceSession: sessionFixture() })]; } });
  const [assignment] = await loadWorkerPortalAssignments(prisma, { workerId: 'worker-1', now: NOW });
  assert.equal(assignment.canStartBreak, true);
  assert.equal(assignment.breakActionType, 'BREAK_START');
  assert.equal(assignment.canRegisterDeparture, true);
  assert.equal(assignment.actionType, 'DEPARTURE');
});

test('con almuerzo abierto permite finalizarlo o registrar salida con penalización', async () => {
  const prisma = prismaWithAssignments({
    async findMany() {
      return [assignmentFixture({
        attendanceSession: sessionFixture({
          marks: [{
            markType: 'BREAK_START',
            serverReceivedAt: new Date('2026-07-22T17:00:00.000Z'),
            clientCapturedAt: new Date('2026-07-22T17:00:00.000Z')
          }]
        })
      })];
    }
  });
  const [assignment] = await loadWorkerPortalAssignments(prisma, { workerId: 'worker-1', now: NOW });
  assert.equal(assignment.breakPending, true);
  assert.equal(assignment.breakOpen, false);
  assert.equal(assignment.breakActionType, 'BREAK_END');
  assert.equal(assignment.canRegisterDeparture, true);
  assert.match(assignment.actionLabel, /1 h 30 min/i);
});

test('después de la salida separa siete horas ordinarias y horas extra', async () => {
  const prisma = prismaWithAssignments({
    async findMany() {
      return [assignmentFixture({
        attendanceSession: sessionFixture({
          arrivalReportedAt: new Date('2026-07-22T13:00:00Z'),
          departureReportedAt: new Date('2026-07-22T22:00:00Z'),
          attendanceStatus: 'COMPLETED',
          workedMinutes: 480
        })
      })];
    }
  });
  const [assignment] = await loadWorkerPortalAssignments(prisma, { workerId: 'worker-1', now: new Date('2026-07-22T22:01:00Z') });
  assert.equal(assignment.departureReported, true);
  assert.equal(assignment.actionType, 'DONE');
  assert.equal(assignment.ordinaryWorkedMinutes, 420);
  assert.equal(assignment.overtimeMinutes, 60);
  assert.equal(assignment.overtimeLabel, '1 h');
  assert.match(assignment.actionLabel, /8 h/);
});

test('una jornada cerrada sin fin de almuerzo muestra la penalización aplicada', async () => {
  const prisma = prismaWithAssignments({
    async findMany() {
      return [assignmentFixture({
        attendanceSession: sessionFixture({
          departureReportedAt: new Date('2026-07-22T22:00:00Z'),
          workedMinutes: 450,
          marks: [{
            markType: 'BREAK_START',
            clientCapturedAt: new Date('2026-07-22T17:00:00Z'),
            serverReceivedAt: new Date('2026-07-22T17:00:00Z')
          }]
        })
      })];
    }
  });
  const [assignment] = await loadWorkerPortalAssignments(prisma, { workerId: 'worker-1', now: new Date('2026-07-22T22:01:00Z') });
  assert.equal(assignment.breakPenaltyApplied, true);
  assert.equal(assignment.breakMinutesDeducted, 90);
  assert.match(assignment.breakLabel, /Se tomó 1 h 30 min de almuerzo/i);
});
