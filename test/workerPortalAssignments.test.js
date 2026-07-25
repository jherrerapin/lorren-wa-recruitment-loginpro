import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadWorkerPortalAssignmentForArrival,
  loadWorkerPortalAssignments
} from '../src/modules/dispatch-attendance/application/workerPortalAssignments.js';

const NOW = new Date('2026-07-22T13:00:00.000Z');

function assignmentFixture(overrides = {}) {
  return {
    id: 'assignment-1', workerId: 'worker-1', serviceRequestId: 'request-1', status: 'CONFIRMED', attendanceSession: null,
    serviceRequest: {
      clientName: 'Cliente Prueba', operationPointName: 'Centro logístico', cityName: 'Bogotá', address: 'Carrera 1 # 2-3',
      serviceDate: new Date('2026-07-22T00:00:00.000Z'), startTime: '08:30', endTime: '17:00',
      operationPoint: { name: 'Centro logístico', cityName: 'Bogotá', address: 'Carrera 1 # 2-3', attendanceEnabled: true, earlyArrivalWindowMinutes: 60, absenceGraceMinutes: 15, attendancePhotoPolicy: 'RISK_ONLY' },
      ...overrides.serviceRequest
    },
    ...overrides
  };
}

function prismaWithAssignments(methods) {
  return {
    dispatchAssignment: methods,
    async $queryRaw() { return []; },
    async $executeRaw() { return 0; }
  };
}

test('lista asignaciones activas y prepara llegada con descanso predeterminado cero', async () => {
  let observedQuery;
  const prisma = prismaWithAssignments({ async findMany(query) { observedQuery = query; return [assignmentFixture()]; } });
  const assignments = await loadWorkerPortalAssignments(prisma, { workerId: 'worker-1', now: NOW });
  assert.equal(observedQuery.where.workerId, 'worker-1');
  assert.deepEqual(observedQuery.where.status.in, ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED']);
  assert.equal(assignments[0].canRegisterArrival, true);
  assert.equal(assignments[0].canRegisterDeparture, false);
  assert.equal(assignments[0].breakLabel, 'Sin descanso no remunerado');
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

test('antes de la ventana anticipada bloquea llegada', async () => {
  const prisma = prismaWithAssignments({ async findMany() { return [assignmentFixture()]; } });
  const [assignment] = await loadWorkerPortalAssignments(prisma, { workerId: 'worker-1', now: new Date('2026-07-22T11:00:00.000Z') });
  assert.equal(assignment.canRegisterArrival, false);
  assert.match(assignment.actionLabel, /Disponible desde/i);
});

test('después del margen muestra jornada vencida', async () => {
  const prisma = prismaWithAssignments({ async findMany() { return [assignmentFixture()]; } });
  const [assignment] = await loadWorkerPortalAssignments(prisma, { workerId: 'worker-1', now: new Date('2026-07-22T13:45:01.000Z') });
  assert.equal(assignment.arrivalWindowExpired, true);
  assert.equal(assignment.actionLabel, 'Jornada vencida');
});

test('después de la llegada ofrece registrar salida y no una segunda llegada', async () => {
  const prisma = prismaWithAssignments({ async findMany() { return [assignmentFixture({ attendanceSession: { arrivalReportedAt: NOW, departureReportedAt: null, validationStatus: 'AUTO_VALIDATED', attendanceStatus: 'ON_TIME', punctualityStatus: 'ON_TIME', workedMinutes: null } })]; } });
  const [assignment] = await loadWorkerPortalAssignments(prisma, { workerId: 'worker-1', now: NOW });
  assert.equal(assignment.arrivalReported, true);
  assert.equal(assignment.canRegisterArrival, false);
  assert.equal(assignment.canRegisterDeparture, true);
  assert.equal(assignment.actionType, 'DEPARTURE');
  assert.equal(assignment.actionLabel, 'Registrar salida');
});

test('después de la salida muestra horas netas y cierra la jornada', async () => {
  const prisma = prismaWithAssignments({ async findMany() { return [assignmentFixture({ attendanceSession: { arrivalReportedAt: new Date('2026-07-22T13:00:00Z'), departureReportedAt: new Date('2026-07-22T22:00:00Z'), validationStatus: 'AUTO_VALIDATED', attendanceStatus: 'COMPLETED', punctualityStatus: 'ON_TIME', workedMinutes: 480 } })]; } });
  const [assignment] = await loadWorkerPortalAssignments(prisma, { workerId: 'worker-1', now: new Date('2026-07-22T22:01:00Z') });
  assert.equal(assignment.departureReported, true);
  assert.equal(assignment.actionType, 'DONE');
  assert.match(assignment.actionLabel, /8 h/);
});
