import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadAttendanceAdminBoard,
  registerManualAttendance,
  validateAttendanceTimelineAgainstAssignment
} from '../src/modules/dispatch-attendance/application/adminAttendance.js';

function activeAssignment({ overnight = true } = {}) {
  const expectedStartAt = new Date('2026-08-14T03:00:00.000Z'); // 13-ago 22:00 Bogotá
  const expectedEndAt = overnight
    ? new Date('2026-08-14T11:00:00.000Z') // 14-ago 06:00 Bogotá
    : new Date('2026-08-14T04:00:00.000Z'); // 13-ago 23:00 Bogotá
  const arrivalMark = {
    id: 'mark-arrival-test',
    markType: 'ARRIVAL',
    clientCapturedAt: expectedStartAt,
    serverReceivedAt: expectedStartAt,
    decision: 'MANUAL_VALIDATED',
    riskScore: 0,
    riskFlags: []
  };
  const attendanceSession = {
    id: 'session-test',
    assignmentId: 'assignment-test',
    expectedStartAt,
    expectedEndAt,
    attendanceStatus: 'ARRIVAL_REPORTED',
    validationStatus: 'REVIEW_REQUIRED',
    punctualityStatus: 'ON_TIME',
    arrivalReportedAt: expectedStartAt,
    arrivalValidatedAt: expectedStartAt,
    departureReportedAt: null,
    departureValidatedAt: null,
    workedMinutes: null,
    source: 'MANUAL',
    riskScore: 0,
    riskFlags: [],
    marks: [arrivalMark],
    reviews: []
  };
  return {
    id: 'assignment-test',
    workerId: 'worker-test',
    serviceRequestId: 'request-test',
    status: 'CONFIRMED',
    worker: {
      id: 'worker-test',
      fullName: 'Auxiliar Prueba'
    },
    serviceRequest: {
      id: 'request-test',
      clientName: 'Cliente Prueba',
      operationPointName: 'Operación Prueba',
      cityName: 'Bogotá',
      address: 'Dirección de prueba',
      serviceDate: new Date('2026-08-13T00:00:00.000Z'),
      startTime: '22:00',
      // El fin ya no está disponible para reconstruir la ventana desde la solicitud.
      // La sesión activa conserva la ventana con la que realmente inició.
      endTime: null,
      operationPoint: {
        id: 'point-test',
        manualAttendanceAllowed: true,
        attendanceEnabled: true,
        absenceGraceMinutes: 15
      }
    },
    attendanceSession
  };
}

function prismaContract(assignment) {
  const createdMarks = [];
  const reviews = [];
  const prisma = {
    dispatchAssignment: {
      async findMany() { return [assignment]; },
      async findUnique() { return assignment; }
    },
    dispatchAttendanceSession: {
      async findUnique() { return assignment.attendanceSession; },
      async create({ data }) {
        Object.assign(assignment.attendanceSession, data);
        return assignment.attendanceSession;
      },
      async update({ data }) {
        Object.assign(assignment.attendanceSession, data);
        return assignment.attendanceSession;
      }
    },
    dispatchAttendanceMark: {
      async findFirst() { return null; },
      async create({ data }) {
        const mark = { id: `mark-created-${createdMarks.length + 1}`, ...data };
        createdMarks.push(mark);
        assignment.attendanceSession.marks.push(mark);
        return mark;
      },
      async update({ where, data }) { return { id: where.id, ...data }; }
    },
    dispatchAttendanceReview: {
      async create({ data }) {
        reviews.push(data);
        return { id: `review-${reviews.length}`, ...data };
      }
    }
  };
  prisma.$transaction = async (callback) => callback(prisma);
  return { prisma, createdMarks, reviews };
}

test('el panel habilita el día siguiente cuando la sesión activa conserva una ventana nocturna', async () => {
  const assignment = activeAssignment({ overnight: true });
  const { prisma } = prismaContract(assignment);
  const board = await loadAttendanceAdminBoard(prisma, {
    from: '2026-08-13',
    to: '2026-08-13',
    now: new Date('2026-08-14T07:00:00.000Z')
  });

  assert.equal(board.rows.length, 1);
  assert.equal(board.rows[0].serviceDateIso, '2026-08-13');
  assert.equal(board.rows[0].latestManualDateIso, '2026-08-14');
  assert.equal(board.rows[0].expectedEndAt, '2026-08-14T11:00:00.000Z');
});

test('la marcación manual del almuerzo acepta X+1 usando la ventana persistida de la sesión nocturna', async () => {
  const assignment = activeAssignment({ overnight: true });
  const { prisma, createdMarks } = prismaContract(assignment);

  const result = await registerManualAttendance(prisma, {
    assignmentId: assignment.id,
    breakStartAt: '2026-08-14T01:00',
    actorUsername: 'coordinacion-prueba',
    actorRole: 'admin',
    now: new Date('2026-08-14T07:05:00.000Z')
  });

  assert.equal(result.attendanceStatus, 'ARRIVAL_REPORTED');
  assert.equal(createdMarks.length, 1);
  assert.equal(createdMarks[0].markType, 'BREAK_START');
  assert.equal(createdMarks[0].clientCapturedAt.toISOString(), '2026-08-14T06:00:00.000Z');
});

test('una sesión diurna conserva el límite en la fecha X y rechaza X+1', () => {
  const assignment = activeAssignment({ overnight: false });

  assert.throws(
    () => validateAttendanceTimelineAgainstAssignment(
      assignment.serviceRequest,
      {
        arrivalAt: assignment.attendanceSession.arrivalReportedAt,
        breakStartAt: new Date('2026-08-14T07:00:00.000Z')
      },
      assignment.attendanceSession
    ),
    /attendance_manual_mark_date_outside_assignment/
  );
});

test('la UI solo presenta el acceso al día siguiente cuando el board clasifica la jornada como nocturna', () => {
  const view = readFileSync(
    new URL('../src/views/operacionesAsistencia.ejs', import.meta.url),
    'utf8'
  );

  assert.match(view, /hasOvernightManualDate = Boolean\(row\.serviceDateIso && row\.latestManualDateIso && row\.latestManualDateIso !== row\.serviceDateIso\)/);
  assert.match(view, /<% if \(hasOvernightManualDate\) \{ %><div class="manual-day-picker">/);
  assert.match(view, /Día siguiente · <%= row\.latestManualDateIso %>/);
  assert.match(view, /name="arrivalReportedAt" min="<%= serviceDateTimeMin %>" max="<%= serviceDateTimeMax %>"/);
  assert.match(view, /name="breakStartAt" min="<%= serviceDateTimeMin %>" max="<%= latestManualDateTimeMax %>"/);
});