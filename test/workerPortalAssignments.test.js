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
        earlyArrivalWindowMinutes: 60,
        attendancePhotoPolicy: 'RISK_ONLY'
      },
      ...overrides.serviceRequest
    },
    ...overrides
  };
}

test('lista únicamente asignaciones activas del auxiliar y prepara una tarjeta segura', async () => {
  let observedQuery;
  const prisma = {
    dispatchAssignment: {
      async findMany(query) {
        observedQuery = query;
        return [assignmentFixture()];
      }
    }
  };

  const assignments = await loadWorkerPortalAssignments(prisma, {
    workerId: 'worker-1',
    now: NOW
  });

  assert.equal(observedQuery.where.workerId, 'worker-1');
  assert.deepEqual(observedQuery.where.status.in, ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED']);
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].clientName, 'Cliente Prueba');
  assert.equal(assignments[0].canRegisterArrival, true);
  assert.equal(assignments[0].photoRequired, true);
  assert.equal(assignments[0].workerId, undefined);
  assert.equal(assignments[0].serviceRequest, undefined);
});

test('la consulta puntual exige simultáneamente assignmentId y workerId', async () => {
  let observedWhere;
  const prisma = {
    dispatchAssignment: {
      async findFirst(query) {
        observedWhere = query.where;
        return assignmentFixture();
      }
    }
  };

  const assignment = await loadWorkerPortalAssignmentForArrival(prisma, {
    workerId: 'worker-1',
    assignmentId: 'assignment-1',
    now: NOW
  });

  assert.equal(observedWhere.id, 'assignment-1');
  assert.equal(observedWhere.workerId, 'worker-1');
  assert.equal(assignment.id, 'assignment-1');
});

test('antes de la ventana anticipada informa la hora y bloquea la marcación', async () => {
  const prisma = {
    dispatchAssignment: {
      async findMany() {
        return [assignmentFixture()];
      }
    }
  };

  const assignments = await loadWorkerPortalAssignments(prisma, {
    workerId: 'worker-1',
    now: new Date('2026-07-22T11:00:00.000Z')
  });

  assert.equal(assignments[0].canRegisterArrival, false);
  assert.match(assignments[0].actionLabel, /Disponible desde/i);
  assert.equal(assignments[0].arrivalWindowOpensAt, '2026-07-22T12:30:00.000Z');
});

test('una llegada existente se muestra como estado y no ofrece una segunda marcación', async () => {
  const prisma = {
    dispatchAssignment: {
      async findMany() {
        return [assignmentFixture({
          attendanceSession: {
            arrivalReportedAt: NOW,
            validationStatus: 'AUTO_VALIDATED',
            attendanceStatus: 'ON_TIME',
            punctualityStatus: 'ON_TIME'
          }
        })];
      }
    }
  };

  const assignments = await loadWorkerPortalAssignments(prisma, {
    workerId: 'worker-1',
    now: NOW
  });

  assert.equal(assignments[0].arrivalReported, true);
  assert.equal(assignments[0].canRegisterArrival, false);
  assert.equal(assignments[0].actionLabel, 'Llegada validada · a tiempo');
});
