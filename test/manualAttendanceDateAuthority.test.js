import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadAttendanceAdminBoard,
  registerManualAttendance,
  validateAttendanceTimelineAgainstAssignment
} from '../src/modules/dispatch-attendance/application/adminAttendance.js';

function assignmentFixture({
  startTime = '22:00',
  endTime = null,
  sessionExpectedEndAt = null
} = {}) {
  const serviceDate = new Date('2026-08-13T00:00:00.000Z');
  const startHour = Number(startTime.split(':')[0]);
  const startMinute = Number(startTime.split(':')[1]);
  const expectedStartAt = new Date(Date.UTC(2026, 7, 13, startHour + 5, startMinute));
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
    expectedEndAt: sessionExpectedEndAt,
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
    worker: { id: 'worker-test', fullName: 'Auxiliar Prueba' },
    serviceRequest: {
      id: 'request-test',
      clientName: 'Cliente Prueba',
      operationPointName: 'Operación Prueba',
      cityName: 'Bogotá',
      address: 'Dirección de prueba',
      serviceDate,
      startTime,
      endTime,
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

test('22:00 sin hora fin deriva una ventana operativa hasta 06:00 del día siguiente sin inventar expectedEndAt', async () => {
  const assignment = assignmentFixture();
  const { prisma } = prismaContract(assignment);
  const board = await loadAttendanceAdminBoard(prisma, {
    from: '2026-08-13',
    to: '2026-08-13',
    now: new Date('2026-08-14T07:00:00.000Z')
  });

  assert.equal(board.rows.length, 1);
  assert.equal(board.rows[0].expectedEndAt, null);
  assert.equal(board.rows[0].operationalWindowDerived, true);
  assert.equal(board.rows[0].latestManualDateIso, '2026-08-14');
  assert.equal(board.rows[0].manualBreakStartMin, '2026-08-13T22:00');
  assert.equal(board.rows[0].manualBreakStartMax, '2026-08-14T05:59');
  assert.equal(board.rows[0].manualDepartureMax, '2026-08-14T13:59');
});

test('coordinación puede marcar almuerzo a las 02:00 de X+1 en una jornada iniciada a las 22:00', async () => {
  const assignment = assignmentFixture();
  const { prisma, createdMarks } = prismaContract(assignment);

  await registerManualAttendance(prisma, {
    assignmentId: assignment.id,
    breakStartAt: '2026-08-14T02:00',
    actorUsername: 'coordinacion-prueba',
    actorRole: 'admin',
    now: new Date('2026-08-14T07:10:00.000Z')
  });

  assert.equal(createdMarks.at(-1)?.markType, 'BREAK_START');
  assert.equal(createdMarks.at(-1)?.clientCapturedAt.toISOString(), '2026-08-14T07:00:00.000Z');
});

test('una jornada 22:00→06:00 explícita acepta la madrugada de X+1', () => {
  const assignment = assignmentFixture({ endTime: '06:00' });
  const timeline = validateAttendanceTimelineAgainstAssignment(
    assignment.serviceRequest,
    {
      arrivalAt: assignment.attendanceSession.arrivalReportedAt,
      breakStartAt: new Date('2026-08-14T07:00:00.000Z')
    },
    assignment.attendanceSession
  );

  assert.equal(timeline.overnight, true);
  assert.equal(timeline.latestDateKey, '2026-08-14');
  assert.equal(timeline.operational.operationalEndAt.toISOString(), '2026-08-14T11:00:00.000Z');
});

test('una jornada iniciada a las 22:00 rechaza un almuerzo a las 22:00 de la noche siguiente', () => {
  const assignment = assignmentFixture();
  assert.throws(
    () => validateAttendanceTimelineAgainstAssignment(
      assignment.serviceRequest,
      {
        arrivalAt: assignment.attendanceSession.arrivalReportedAt,
        breakStartAt: new Date('2026-08-15T03:00:00.000Z')
      },
      assignment.attendanceSession
    ),
    /attendance_manual_break_operational_window_invalid/
  );
});

test('un turno diurno 08:00 sin hora fin no habilita marcaciones en X+1', async () => {
  const assignment = assignmentFixture({ startTime: '08:00' });
  const { prisma } = prismaContract(assignment);
  const board = await loadAttendanceAdminBoard(prisma, {
    from: '2026-08-13',
    to: '2026-08-13',
    now: new Date('2026-08-13T18:00:00.000Z')
  });

  assert.equal(board.rows[0].latestManualDateIso, '2026-08-13');
  assert.equal(board.rows[0].manualBreakStartMax, '2026-08-13T15:59');
  assert.equal(board.rows[0].manualDepartureMax, '2026-08-13T23:59');
  assert.throws(
    () => validateAttendanceTimelineAgainstAssignment(
      assignment.serviceRequest,
      {
        arrivalAt: assignment.attendanceSession.arrivalReportedAt,
        breakStartAt: new Date('2026-08-14T07:00:00.000Z')
      },
      assignment.attendanceSession
    ),
    /attendance_manual_break_operational_window_invalid/
  );
});

test('el formulario refleja los límites exactos del backend y el runtime no los elimina', () => {
  const view = readFileSync(
    new URL('../src/views/operacionesAsistencia.ejs', import.meta.url),
    'utf8'
  );
  const runtime = readFileSync(
    new URL('../src/public/attendance-admin-manual-workday.js', import.meta.url),
    'utf8'
  );

  assert.match(view, /name="arrivalReportedAt" min="<%= serviceDateTimeMin %>" max="<%= serviceDateTimeMax %>"/);
  assert.match(view, /name="breakStartAt" min="<%= manualBreakStartMin %>" max="<%= manualBreakStartMax %>"/);
  assert.match(view, /name="breakEndAt" min="<%= manualBreakEndMin %>" max="<%= manualBreakEndMax %>"/);
  assert.match(view, /name="departureReportedAt" min="<%= manualDepartureMin %>" max="<%= manualDepartureMax %>"/);
  assert.doesNotMatch(runtime, /removeAttribute\(['"]max['"]\)/);
});
