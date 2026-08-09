import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerManualAttendance } from '../src/modules/dispatch-attendance/application/adminAttendance.js';
import { reviewAttendanceWorkdaySession } from '../src/modules/dispatch-attendance/application/attendanceAdminWorkday.js';

const ORIGINAL_MARK_IDS = Object.freeze([
  'mark-arrival',
  'mark-break-start',
  'mark-break-end',
  'mark-departure'
]);

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
    deletedMarkIds: [],
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
      async delete({ where }) {
        const index = session.marks.findIndex((mark) => mark.id === where.id);
        if (index < 0) throw new Error('mock_mark_not_found');
        const [removed] = session.marks.splice(index, 1);
        state.deletedMarkIds.push(removed.id);
        return removed;
      },
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

test('el coordinador elimina todas las marcaciones sin borrar la sesión ni la asignación y conserva auditoría', async () => {
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

const individualCases = [
  { markType: 'ARRIVAL', markId: 'mark-arrival', reportedAt: '2026-08-09T08:15', expectedWorkedMinutes: 465, expectedPunctuality: 'LATE' },
  { markType: 'BREAK_START', markId: 'mark-break-start', reportedAt: '2026-08-09T11:45', expectedWorkedMinutes: 465, expectedPunctuality: 'ON_TIME' },
  { markType: 'BREAK_END', markId: 'mark-break-end', reportedAt: '2026-08-09T12:45', expectedWorkedMinutes: 495, expectedPunctuality: 'ON_TIME' },
  { markType: 'DEPARTURE', markId: 'mark-departure', reportedAt: '2026-08-09T16:30', expectedWorkedMinutes: 450, expectedPunctuality: 'ON_TIME' }
];

for (const correction of individualCases) {
  test(`elimina solo ${correction.markType} y permite registrar una nueva hora sin borrar las demás marcas`, async () => {
    const { prisma, session, state } = attendanceFixture();
    const remainingBeforeAdd = ORIGINAL_MARK_IDS.filter((id) => id !== correction.markId);

    const afterDelete = await reviewAttendanceWorkdaySession(prisma, {
      sessionId: session.id,
      action: 'DELETE_MARK',
      markType: correction.markType,
      markId: correction.markId,
      actorUsername: 'coordinacion-prueba',
      actorRole: 'admin',
      now: new Date('2026-08-09T23:10:00.000Z')
    });

    assert.deepEqual(state.deletedMarkIds, [correction.markId]);
    assert.deepEqual(session.marks.map((mark) => mark.id), remainingBeforeAdd);
    assert.equal(afterDelete.id, 'session-test');
    assert.equal(state.reviews.at(-1).action, 'WORKDAY_DELETE_MARK');
    assert.equal(state.reviews.at(-1).metadata.markId, correction.markId);
    assert.equal(state.reviews.at(-1).metadata.markType, correction.markType);
    assert.equal(state.reviews.at(-1).metadata.previousMarkCount, 4);
    assert.equal(state.reviews.at(-1).metadata.nextMarkCount, 3);

    const afterAdd = await reviewAttendanceWorkdaySession(prisma, {
      sessionId: session.id,
      action: 'ADD_MARK',
      markType: correction.markType,
      reportedAt: correction.reportedAt,
      actorUsername: 'coordinacion-prueba',
      actorRole: 'admin',
      now: new Date('2026-08-09T23:12:00.000Z')
    });

    assert.equal(session.marks.length, 4);
    assert.deepEqual(
      session.marks.filter((mark) => ORIGINAL_MARK_IDS.includes(mark.id)).map((mark) => mark.id),
      remainingBeforeAdd
    );
    assert.equal(state.createdMarks.at(-1).markType, correction.markType);
    assert.equal(state.createdMarks.at(-1).decision, 'MANUAL_VALIDATED');
    assert.equal(afterAdd.attendanceStatus, 'COMPLETED');
    assert.equal(afterAdd.validationStatus, 'MANUAL_VALIDATED');
    assert.equal(afterAdd.punctualityStatus, correction.expectedPunctuality);
    assert.equal(afterAdd.workedMinutes, correction.expectedWorkedMinutes);
    assert.equal(state.reviews.at(-1).action, 'WORKDAY_ADD_MARK');
    assert.equal(state.reviews.at(-1).metadata.markType, correction.markType);
    assert.equal(state.reviews.at(-1).metadata.previousMarkCount, 3);
    assert.equal(state.reviews.at(-1).metadata.nextMarkCount, 4);
  });
}

test('eliminar inicio de almuerzo conserva fin y salida pero deja la sesión fuera de nómina hasta reponer la marca', async () => {
  const { prisma, session } = attendanceFixture();
  const result = await reviewAttendanceWorkdaySession(prisma, {
    sessionId: session.id,
    action: 'DELETE_MARK',
    markType: 'BREAK_START',
    markId: 'mark-break-start',
    actorUsername: 'coordinacion-prueba',
    actorRole: 'admin',
    now: new Date('2026-08-09T23:20:00.000Z')
  });

  assert.deepEqual(session.marks.map((mark) => mark.markType), ['ARRIVAL', 'BREAK_END', 'DEPARTURE']);
  assert.equal(result.attendanceStatus, 'DEPARTURE_REPORTED');
  assert.equal(result.validationStatus, 'REVIEW_REQUIRED');
  assert.equal(result.departureReportedAt, null);
  assert.equal(result.workedMinutes, null);
});

test('el panel ofrece eliminar y reponer cada marca individual usando la misma ruta administrativa', () => {
  const ui = readFileSync(new URL('../src/public/attendance-admin-clear-marks.js', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../src/views/operacionesAsistencia.ejs', import.meta.url), 'utf8');
  const runtime = readFileSync(new URL('../src/public/attendance-admin-runtime.js', import.meta.url), 'utf8');
  const route = readFileSync(new URL('../src/routes/dispatchAttendanceAdmin.js', import.meta.url), 'utf8');
  const workday = readFileSync(new URL('../src/modules/dispatch-attendance/application/attendanceAdminWorkday.js', import.meta.url), 'utf8');
  const payroll = readFileSync(new URL('../src/modules/dispatch-payroll/application/payrollReport.js', import.meta.url), 'utf8');

  assert.match(ui, /correctionForm\('DELETE_MARK'/);
  assert.match(ui, /correctionForm\('ADD_MARK'/);
  assert.match(ui, /ARRIVAL/);
  assert.match(ui, /BREAK_START/);
  assert.match(ui, /BREAK_END/);
  assert.match(ui, /DEPARTURE/);
  assert.match(ui, /Eliminar solo/);
  assert.match(ui, /Registrar nueva/);
  assert.match(ui, /window\.confirm/);
  assert.match(ui, /Las demás marcaciones de la jornada se conservarán/);
  assert.match(ui, /hiddenInput\('action', 'CLEAR'\)/);
  assert.match(ui, /Eliminar todas las marcaciones/);
  assert.match(runtime, /attendance-admin-clear-marks\.js/);
  assert.match(view, /data-attendance-review-action/);
  assert.match(view, /data-arrival-mark-id/);
  assert.match(view, /data-break-start-mark-id/);
  assert.match(view, /data-break-end-mark-id/);
  assert.match(view, /data-departure-mark-id/);
  assert.match(route, /router\.post\('\/sessions\/:sessionId\/review'/);
  assert.match(route, /markId:\s*req\.body\.markId/);
  assert.match(route, /markType:\s*req\.body\.markType/);
  assert.match(route, /reportedAt:\s*req\.body\.reportedAt/);
  assert.match(route, /reviewAttendanceWorkdaySession/);
  assert.match(workday, /dispatchAttendanceMark\.deleteMany/);
  assert.match(workday, /dispatchAttendanceMark\.delete\(/);
  assert.match(workday, /WORKDAY_DELETE_MARK/);
  assert.match(workday, /WORKDAY_ADD_MARK/);
  assert.doesNotMatch(workday, /dispatchAttendanceSession\.delete/);
  assert.doesNotMatch(workday, /dispatchAssignment\.delete/);
  assert.match(payroll, /arrivalReportedAt:\s*\{ gte: start, lt: end \}/);
  assert.match(payroll, /departureReportedAt:\s*\{ not: null \}/);
});
