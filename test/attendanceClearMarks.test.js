import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerManualAttendance } from '../src/modules/dispatch-attendance/application/adminAttendance.js';
import { reviewAttendanceWorkdaySession } from '../src/modules/dispatch-attendance/application/attendanceAdminWorkday.js';

function attendanceFixture() {
  const marks = [
    { id: 'mark-arrival', markType: 'ARRIVAL', clientCapturedAt: new Date('2026-08-09T13:00:00.000Z'), decision: 'MANUAL_VALIDATED' },
    { id: 'mark-break-start', markType: 'BREAK_START', clientCapturedAt: new Date('2026-08-09T17:00:00.000Z'), decision: 'MANUAL_VALIDATED' },
    { id: 'mark-break-end', markType: 'BREAK_END', clientCapturedAt: new Date('2026-08-09T18:00:00.000Z'), decision: 'MANUAL_VALIDATED' },
    { id: 'mark-departure', markType: 'DEPARTURE', clientCapturedAt: new Date('2026-08-09T22:00:00.000Z'), decision: 'MANUAL_VALIDATED' }
  ];
  const session = {
    id: 'session-test',
    assignmentId: 'assignment-test',
    attendanceStatus: 'COMPLETED',
    validationStatus: 'MANUAL_VALIDATED',
    punctualityStatus: 'ON_TIME',
    riskScore: 12,
    riskFlags: ['TEST_FLAG'],
    expectedStartAt: new Date('2026-08-09T13:00:00.000Z'),
    expectedEndAt: new Date('2026-08-09T22:00:00.000Z'),
    arrivalReportedAt: new Date('2026-08-09T13:00:00.000Z'),
    arrivalValidatedAt: new Date('2026-08-09T13:00:05.000Z'),
    departureReportedAt: new Date('2026-08-09T22:00:00.000Z'),
    departureValidatedAt: new Date('2026-08-09T22:00:05.000Z'),
    workedMinutes: 480,
    marks
  };
  const assignment = {
    id: 'assignment-test',
    workerId: 'worker-test',
    serviceRequestId: 'request-test',
    status: 'CONFIRMED',
    worker: { id: 'worker-test', fullName: 'Auxiliar Prueba' },
    serviceRequest: {
      id: 'request-test',
      serviceDate: new Date('2026-08-09T00:00:00.000Z'),
      startTime: '08:00',
      endTime: '17:00',
      operationPoint: {
        id: 'point-test',
        manualAttendanceAllowed: true,
        attendanceEnabled: true
      }
    },
    attendanceSession: session
  };
  session.assignment = assignment;

  const state = {
    deletedMarksWhere: null,
    updates: [],
    reviews: [],
    createdMarks: []
  };

  const client = {
    dispatchAssignment: {
      async findMany() { return []; },
      async findUnique() { return assignment; }
    },
    dispatchAttendanceSession: {
      async findUnique() { return session; },
      async create({ data }) { Object.assign(session, data); return session; },
      async update({ data }) {
        state.updates.push({ ...data });
        Object.assign(session, data);
        return { ...session };
      }
    },
    dispatchAttendanceMark: {
      async findFirst() { return null; },
      async create({ data }) {
        const mark = { id: `new-mark-${state.createdMarks.length + 1}`, ...data };
        state.createdMarks.push(mark);
        session.marks.push(mark);
        return mark;
      },
      async update({ where, data }) { return { id: where.id, ...data }; },
      async deleteMany({ where }) {
        state.deletedMarksWhere = where;
        const count = session.marks.length;
        session.marks.splice(0, session.marks.length);
        return { count };
      }
    },
    dispatchAttendanceReview: {
      async create({ data }) {
        state.reviews.push(data);
        return { id: `review-${state.reviews.length}`, ...data };
      }
    }
  };
  const prisma = {
    ...client,
    async $transaction(callback) { return callback(client); }
  };
  return { prisma, assignment, session, state };
}

test('el coordinador elimina marcaciones sin borrar la sesión ni la asignación y conserva auditoría', async () => {
  const { prisma, session, state } = attendanceFixture();
  const result = await reviewAttendanceWorkdaySession(prisma, {
    sessionId: session.id,
    action: 'CLEAR',
    actorUsername: 'coordinacion-prueba',
    actorRole: 'admin',
    now: new Date('2026-08-09T23:00:00.000Z')
  });

  assert.deepEqual(state.deletedMarksWhere, { attendanceSessionId: 'session-test' });
  assert.equal(session.marks.length, 0);
  assert.equal(result.id, 'session-test');
  assert.equal(result.attendanceStatus, 'PENDING');
  assert.equal(result.validationStatus, 'PENDING');
  assert.equal(result.punctualityStatus, null);
  assert.equal(result.arrivalReportedAt, null);
  assert.equal(result.arrivalValidatedAt, null);
  assert.equal(result.departureReportedAt, null);
  assert.equal(result.departureValidatedAt, null);
  assert.equal(result.workedMinutes, null);
  assert.equal(result.riskScore, 0);
  assert.deepEqual(result.riskFlags, []);

  const review = state.reviews[0];
  assert.equal(review.action, 'WORKDAY_CLEAR_MARKS');
  assert.equal(review.actorUsername, 'coordinacion-prueba');
  assert.equal(review.reason, 'Marcaciones eliminadas por coordinación para corregir la jornada.');
  assert.equal(review.metadata.assignmentId, 'assignment-test');
  assert.equal(review.metadata.removedMarkCount, 4);
  assert.deepEqual(review.metadata.removedMarks.map((mark) => mark.markType), [
    'ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE'
  ]);
  assert.equal(review.metadata.previousWorkedMinutes, 480);
});

test('después de limpiar la misma sesión acepta una nueva jornada manual con horas corregidas', async () => {
  const { prisma, session, state } = attendanceFixture();
  await reviewAttendanceWorkdaySession(prisma, {
    sessionId: session.id,
    action: 'CLEAR',
    actorUsername: 'coordinacion-prueba',
    actorRole: 'admin',
    now: new Date('2026-08-09T23:00:00.000Z')
  });

  const corrected = await registerManualAttendance(prisma, {
    assignmentId: 'assignment-test',
    arrivalReportedAt: '2026-08-09T08:15',
    departureReportedAt: '2026-08-09T16:15',
    breakTaken: 'true',
    breakStartAt: '2026-08-09T12:00',
    breakEndAt: '2026-08-09T13:00',
    actorUsername: 'coordinacion-prueba',
    actorRole: 'admin',
    now: new Date('2026-08-09T23:05:00.000Z')
  });

  assert.equal(corrected.id, 'session-test');
  assert.equal(corrected.attendanceStatus, 'COMPLETED');
  assert.equal(corrected.validationStatus, 'MANUAL_VALIDATED');
  assert.equal(corrected.arrivalReportedAt.toISOString(), '2026-08-09T13:15:00.000Z');
  assert.equal(corrected.departureReportedAt.toISOString(), '2026-08-09T21:15:00.000Z');
  assert.equal(corrected.workedMinutes, 420);
  assert.deepEqual(state.createdMarks.map((mark) => mark.markType), [
    'ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE'
  ]);
  assert.equal(state.reviews.at(-1).action, 'MANUAL_WORKDAY');
});

test('el panel exige confirmación y reutiliza la misma ruta administrativa de revisión', () => {
  const ui = readFileSync(new URL('../src/public/attendance-admin-clear-marks.js', import.meta.url), 'utf8');
  const runtime = readFileSync(new URL('../src/public/attendance-admin-runtime.js', import.meta.url), 'utf8');
  const route = readFileSync(new URL('../src/routes/dispatchAttendanceAdmin.js', import.meta.url), 'utf8');
  const workday = readFileSync(new URL('../src/modules/dispatch-attendance/application/attendanceAdminWorkday.js', import.meta.url), 'utf8');
  const payroll = readFileSync(new URL('../src/modules/dispatch-payroll/application/payrollReport.js', import.meta.url), 'utf8');

  assert.match(ui, /attendance-validation-form/);
  assert.match(ui, /hiddenInput\('action', 'CLEAR'\)/);
  assert.match(ui, /Eliminar marcaciones/);
  assert.match(ui, /window\.confirm/);
  assert.match(ui, /la auditoría se conservará/);
  assert.match(runtime, /attendance-admin-clear-marks\.js/);
  assert.match(route, /router\.post\('\/sessions\/:sessionId\/review'/);
  assert.match(route, /reviewAttendanceWorkdaySession/);
  assert.match(workday, /dispatchAttendanceMark\.deleteMany/);
  assert.doesNotMatch(workday, /dispatchAttendanceSession\.delete/);
  assert.doesNotMatch(workday, /dispatchAssignment\.delete/);
  assert.match(payroll, /arrivalReportedAt:\s*\{ gte: start, lt: end \}/);
  assert.match(payroll, /departureReportedAt:\s*\{ not: null \}/);
});
