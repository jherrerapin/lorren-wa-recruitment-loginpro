import test from 'node:test';
import assert from 'node:assert/strict';
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

function prismaWithAssignments(methods) {
  return { dispatchAssignment: methods };
}

test('lista asignaciones activas y permite llegada sin ventana temporal', async () => {
  let observedQuery;
  const prisma = prismaWithAssignments({ async findMany(query) { observedQuery = query; return [assignmentFixture()]; } });
  const assignments = await loadWorkerPortalAssignments(prisma, { workerId: 'worker-1', now: NOW });
  assert.equal(observedQuery.where.workerId, 'worker-1');
  assert.deepEqual(observedQuery.where.status.in, ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED']);
  assert.equal(assignments[0].canRegisterArrival, true);
  assert.equal(assignments[0].arrivalWindowExpired, false);
  assert.equal(assignments[0].breakLabel, 'No registrado · el tiempo seguirá contando como trabajado');
  assert.equal(assignments[0].photoRequired, false);
  assert.equal(assignments[0].workerId, undefined);
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

test('mientras el almuerzo está abierto exige finalizarlo antes de salir', async () => {
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
  assert.equal(assignment.breakOpen, true);
  assert.equal(assignment.breakActionType, 'BREAK_END');
  assert.equal(assignment.canRegisterDeparture, false);
  assert.match(assignment.actionLabel, /Finaliza el almuerzo/i);
});

test('después de la salida muestra horas netas y cierra la jornada', async () => {
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
  assert.match(assignment.actionLabel, /8 h/);
});
