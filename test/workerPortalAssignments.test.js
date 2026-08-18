import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  loadWorkerPortalAssignmentForArrival,
  loadWorkerPortalAssignments
} from '../src/modules/dispatch-attendance/application/workerPortalAssignments.js';

const NOW = new Date('2026-07-22T14:00:00.000Z');

function assignmentFixture(overrides = {}) {
  const { serviceRequest: serviceRequestOverrides = {}, ...assignmentOverrides } = overrides;
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
      address: 'Dirección de prueba',
      serviceDate: new Date('2026-07-22T00:00:00.000Z'),
      startTime: '08:30',
      endTime: '17:00',
      operationPoint: {
        name: 'Centro logístico',
        cityName: 'Bogotá',
        address: 'Dirección de prueba',
        attendanceEnabled: true,
        attendancePhotoPolicy: 'RISK_ONLY'
      },
      ...serviceRequestOverrides
    },
    ...assignmentOverrides
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

test('lista asignaciones activas y permite llegada durante la ventana operativa', async () => {
  let observedQuery;
  const prisma = prismaWithAssignments({ async findMany(query) { observedQuery = query; return [assignmentFixture()]; } });
  const assignments = await loadWorkerPortalAssignments(prisma, { workerId: 'worker-1', now: NOW });
  assert.equal(observedQuery.where.workerId, 'worker-1');
  assert.deepEqual(observedQuery.where.status.in, ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED']);
  assert.equal(assignments[0].canRegisterArrival, true);
  assert.equal(assignments[0].arrivalWindowOpen, true);
  assert.equal(assignments[0].arrivalWindowExpired, false);
  assert.equal(assignments[0].arrivalWindowOpensAt, '2026-07-22T05:00:00.000Z');
  assert.equal(assignments[0].arrivalWindowClosesAt, '2026-07-22T21:30:00.000Z');
  assert.match(assignments[0].breakLabel, /si no toma almuerzo/i);
  assert.equal(assignments[0].photoRequired, false);
  assert.equal(assignments[0].workerId, undefined);
  assert.deepEqual(assignments.workerIdentity, {
    fullName: 'Auxiliar Prueba',
    documentNumber: 'TEST-DOC-001'
  });
});

test('distingue configuración del punto y fecha operativa de la asignación', async () => {
  const disabledToday = assignmentFixture({
    id: 'disabled-today',
    serviceRequest: {
      serviceDate: new Date('2026-07-22T00:00:00.000Z'),
      operationPoint: {
        name: 'Punto sin asistencia',
        cityName: 'Bogotá',
        address: 'Dirección de prueba',
        attendanceEnabled: false,
        attendancePhotoPolicy: 'RISK_ONLY'
      }
    }
  });
  const enabledTomorrow = assignmentFixture({
    id: 'enabled-tomorrow',
    serviceRequest: {
      serviceDate: new Date('2026-07-23T00:00:00.000Z'),
      operationPoint: {
        name: 'Punto con asistencia',
        cityName: 'Bogotá',
        address: 'Otra dirección de prueba',
        attendanceEnabled: true,
        attendancePhotoPolicy: 'RISK_ONLY'
      }
    }
  });
  const prisma = prismaWithAssignments({ async findMany() { return [disabledToday, enabledTomorrow]; } });
  const todayAssignments = await loadWorkerPortalAssignments(prisma, { workerId: 'worker-1', now: NOW });
  const today = todayAssignments.find((assignment) => assignment.id === 'disabled-today');
  const tomorrowBeforeItsDay = todayAssignments.find((assignment) => assignment.id === 'enabled-tomorrow');

  assert.equal(today.canRegisterArrival, false);
  assert.equal(today.actionLabel, 'Marcación no habilitada');
  assert.equal(tomorrowBeforeItsDay.canRegisterArrival, false);
  assert.equal(tomorrowBeforeItsDay.actionLabel, 'Disponible el día de la asignación');

  const tomorrowAssignments = await loadWorkerPortalAssignments(prisma, {
    workerId: 'worker-1',
    now: new Date('2026-07-23T13:30:00.000Z')
  });
  const tomorrow = tomorrowAssignments.find((assignment) => assignment.id === 'enabled-tomorrow');
  assert.equal(tomorrow.canRegisterArrival, true);
  assert.equal(tomorrow.actionLabel, 'Registrar llegada');
});

test('la vista usa la etiqueta calculada por la autoridad de asignaciones para la llegada', async () => {
  const view = await readFile(new URL('../src/views/workerPortal.ejs', import.meta.url), 'utf8');
  const arrivalBranch = view.match(/<% if \(!assignment\.arrivalReported && !assignment\.departureReported\) \{ %>[\s\S]*?<% \} else if \(!assignment\.departureReported\) \{ %>/)?.[0] || '';

  assert.match(arrivalBranch, /assignment\.canRegisterArrival \? '' : 'disabled'/);
  assert.match(arrivalBranch, /<%= assignment\.actionLabel %>/);
  assert.doesNotMatch(arrivalBranch, />Registrar llegada<\/button>/);
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

test('el encabezado presenta el nombre del auxiliar una sola vez y conserva el documento', async () => {
  const view = await readFile(new URL('../src/views/workerPortal.ejs', import.meta.url), 'utf8');
  const activeHeader = view.match(/<% } else if \(mode === 'active'\) \{ %>[\s\S]*?<\/header>/)?.[0] || '';

  assert.match(activeHeader, /const portalWorkerIdentity = portalAssignments\.workerIdentity \|\| null/);
  assert.match(activeHeader, /<h1><%= portalWorkerIdentity \? portalWorkerIdentity\.fullName : 'Portal del Auxiliar' %><\/h1>/);
  assert.equal((activeHeader.match(/portalWorkerIdentity\.fullName/g) || []).length, 1);
  assert.doesNotMatch(activeHeader, /<h1>Mi jornada<\/h1>/);
  assert.doesNotMatch(activeHeader, /<strong><%= portalWorkerIdentity\.fullName %><\/strong>/);
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
    now: new Date('2026-07-22T14:00:00.000Z')
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

test('habilita llegada anticipada del mismo día y conserva el cierre +8 horas', async () => {
  const prisma = prismaWithAssignments({ async findMany() { return [assignmentFixture()]; } });
  const [previousDay] = await loadWorkerPortalAssignments(prisma, { workerId: 'worker-1', now: new Date('2026-07-22T04:59:59.999Z') });
  const [earlySameDay] = await loadWorkerPortalAssignments(prisma, { workerId: 'worker-1', now: new Date('2026-07-22T13:29:59.999Z') });
  const [atStart] = await loadWorkerPortalAssignments(prisma, { workerId: 'worker-1', now: new Date('2026-07-22T13:30:00.000Z') });
  const [atClose] = await loadWorkerPortalAssignments(prisma, { workerId: 'worker-1', now: new Date('2026-07-22T21:30:00.000Z') });
  const [afterClose] = await loadWorkerPortalAssignments(prisma, { workerId: 'worker-1', now: new Date('2026-07-22T21:30:00.001Z') });

  assert.equal(previousDay.canRegisterArrival, false);
  assert.equal(previousDay.arrivalWindowExpired, false);
  assert.equal(previousDay.actionLabel, 'Disponible el día de la asignación');
  assert.equal(earlySameDay.canRegisterArrival, true);
  assert.equal(earlySameDay.actionLabel, 'Registrar llegada');
  assert.equal(atStart.canRegisterArrival, true);
  assert.equal(atStart.actionLabel, 'Registrar llegada');
  assert.equal(atClose.canRegisterArrival, true);
  assert.equal(atClose.arrivalWindowExpired, false);
  assert.equal(afterClose.canRegisterArrival, false);
  assert.equal(afterClose.arrivalWindowExpired, true);
  assert.equal(afterClose.actionLabel, 'Jornada vencida');
});

test('portal permite 06:48 para una entrada programada a las 07:00 del mismo día', async () => {
  const prisma = prismaWithAssignments({
    async findMany() {
      return [assignmentFixture({ serviceRequest: { startTime: '07:00' } })];
    }
  });
  const [assignment] = await loadWorkerPortalAssignments(prisma, {
    workerId: 'worker-1',
    now: new Date('2026-07-22T11:48:00.000Z')
  });

  assert.equal(assignment.expectedStartAt, '2026-07-22T12:00:00.000Z');
  assert.equal(assignment.arrivalWindowOpensAt, '2026-07-22T05:00:00.000Z');
  assert.equal(assignment.arrivalWindowClosesAt, '2026-07-22T20:00:00.000Z');
  assert.equal(assignment.canRegisterArrival, true);
  assert.equal(assignment.actionLabel, 'Registrar llegada');
});

test('un turno nocturno permite llegada en X+1 dentro de la ventana de ocho horas', async () => {
  const prisma = prismaWithAssignments({
    async findMany() {
      return [assignmentFixture({
        serviceRequest: {
          serviceDate: new Date('2026-07-22T00:00:00.000Z'),
          startTime: '21:00',
          endTime: '06:00'
        }
      })];
    }
  });

  const [duringNextDay] = await loadWorkerPortalAssignments(prisma, {
    workerId: 'worker-1',
    now: new Date('2026-07-23T06:30:00.000Z')
  });
  const [afterWindow] = await loadWorkerPortalAssignments(prisma, {
    workerId: 'worker-1',
    now: new Date('2026-07-23T10:00:00.001Z')
  });

  assert.equal(duringNextDay.expectedStartAt, '2026-07-23T02:00:00.000Z');
  assert.equal(duringNextDay.arrivalWindowClosesAt, '2026-07-23T10:00:00.000Z');
  assert.equal(duringNextDay.canRegisterArrival, true);
  assert.equal(duringNextDay.actionLabel, 'Registrar llegada');
  assert.equal(afterWindow.canRegisterArrival, false);
  assert.equal(afterWindow.arrivalWindowExpired, true);
  assert.equal(afterWindow.actionLabel, 'Jornada vencida');
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
