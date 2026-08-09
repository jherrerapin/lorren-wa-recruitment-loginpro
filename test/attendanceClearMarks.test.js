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
    marks,
    reviews: []
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
        const review = {
          id: `review-${state.reviews.length + 1}`,
          createdAt: new Date(`2026-08-09T23:${String(state.reviews.length).padStart(2, '0')}:30.000Z`),
          ...data
        };
        state.reviews.push(data);
        session.reviews.unshift(review);
        return review;
      }
    }
  };
  const prisma = {
    ...client,
    async $transaction(callback) { return callback(client); }
  };
  return { prisma, assignment, session, state };
}

async function clearFixtureWorkday(prisma, session) {
  return reviewAttendanceWorkdaySession(prisma, {
    sessionId: session.id,
    action: 'CLEAR',
    actorUsername: 'coordinacion-prueba',
    actorRole: 'admin',
    now: new Date('2026-08-09T23:00:00.000Z')
  });
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
  await clearFixtureWorkday(prisma, session);

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

test('no permite agregar una marcación ausente si no fue eliminada previamente para corregirla', async () => {
  const { prisma, session } = attendanceFixture();
  session.marks.splice(session.marks.findIndex((mark) => mark.markType === 'BREAK_START'), 1);

  await assert.rejects(
    reviewAttendanceWorkdaySession(prisma, {
      sessionId: session.id,
      action: 'ADD_MARK',
      markType: 'BREAK_START',
      reportedAt: '2026-08-09T12:00',
      actorUsername: 'coordinacion-prueba',
      actorRole: 'admin',
      now: new Date('2026-08-09T23:15:00.000Z')
    }),
    /attendance_review_mark_not_pending_correction/
  );
});

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

test('eliminar fin de almuerzo conserva inicio y salida pero no aplica penalización mientras la corrección está pendiente', async () => {
  const { prisma, session } = attendanceFixture();
  const result = await reviewAttendanceWorkdaySession(prisma, {
    sessionId: session.id,
    action: 'DELETE_MARK',
    markType: 'BREAK_END',
    markId: 'mark-break-end',
    actorUsername: 'coordinacion-prueba',
    actorRole: 'admin',
    now: new Date('2026-08-09T23:21:00.000Z')
  });

  assert.deepEqual(session.marks.map((mark) => mark.markType), ['ARRIVAL', 'BREAK_START', 'DEPARTURE']);
  assert.equal(result.attendanceStatus, 'DEPARTURE_REPORTED');
  assert.equal(result.validationStatus, 'REVIEW_REQUIRED');
  assert.equal(result.departureReportedAt, null);
  assert.equal(result.workedMinutes, null);
});

test('eliminar un inicio de almuerzo sin fin previo tampoco convierte la corrección en una jornada sin almuerzo', async () => {
  const { prisma, session } = attendanceFixture();
  session.marks.splice(session.marks.findIndex((mark) => mark.markType === 'BREAK_END'), 1);

  const result = await reviewAttendanceWorkdaySession(prisma, {
    sessionId: session.id,
    action: 'DELETE_MARK',
    markType: 'BREAK_START',
    markId: 'mark-break-start',
    actorUsername: 'coordinacion-prueba',
    actorRole: 'admin',
    now: new Date('2026-08-09T23:22:00.000Z')
  });

  assert.deepEqual(session.marks.map((mark) => mark.markType), ['ARRIVAL', 'DEPARTURE']);
  assert.equal(result.validationStatus, 'REVIEW_REQUIRED');
  assert.equal(result.departureReportedAt, null);
  assert.equal(result.workedMinutes, null);
});

test('eliminar entrada conserva la salida persistida y evita reconstruir la jornada completa sobre marcas parciales', async () => {
  const { prisma, session } = attendanceFixture();
  const result = await reviewAttendanceWorkdaySession(prisma, {
    sessionId: session.id,
    action: 'DELETE_MARK',
    markType: 'ARRIVAL',
    markId: 'mark-arrival',
    actorUsername: 'coordinacion-prueba',
    actorRole: 'admin',
    now: new Date('2026-08-09T23:23:00.000Z')
  });

  assert.equal(result.arrivalReportedAt, null);
  assert.equal(result.departureReportedAt.toISOString(), '2026-08-09T22:00:00.000Z');
  assert.equal(result.validationStatus, 'REVIEW_REQUIRED');

  await assert.rejects(
    registerManualAttendance(prisma, {
      assignmentId: 'assignment-test',
      arrivalReportedAt: '2026-08-09T08:15',
      departureReportedAt: '2026-08-09T16:15',
      breakTaken: 'false',
      actorUsername: 'coordinacion-prueba',
      actorRole: 'admin',
      now: new Date('2026-08-09T23:24:00.000Z')
    }),
    /attendance_manual_arrival_exists/
  );
});

test('la jornada manual rechaza una entrada en fecha distinta de la asignación', async () => {
  const { prisma, session, state } = attendanceFixture();
  await clearFixtureWorkday(prisma, session);

  await assert.rejects(
    registerManualAttendance(prisma, {
      assignmentId: 'assignment-test',
      arrivalReportedAt: '2026-08-10T08:00',
      departureReportedAt: '2026-08-10T16:00',
      breakTaken: 'false',
      actorUsername: 'coordinacion-prueba',
      actorRole: 'admin',
      now: new Date('2026-08-10T22:00:00.000Z')
    }),
    /attendance_manual_arrival_date_mismatch/
  );
  assert.equal(state.createdMarks.length, 0);
});

test('una jornada diurna no permite llevar la salida manual al día siguiente', async () => {
  const { prisma, session, state } = attendanceFixture();
  await clearFixtureWorkday(prisma, session);

  await assert.rejects(
    registerManualAttendance(prisma, {
      assignmentId: 'assignment-test',
      arrivalReportedAt: '2026-08-09T08:00',
      departureReportedAt: '2026-08-10T01:00',
      breakTaken: 'false',
      actorUsername: 'coordinacion-prueba',
      actorRole: 'admin',
      now: new Date('2026-08-10T06:30:00.000Z')
    }),
    /attendance_manual_mark_date_outside_assignment/
  );
  assert.equal(state.createdMarks.length, 0);
});

test('un turno nocturno permite almuerzo y salida al día siguiente dentro de la misma jornada', async () => {
  const { prisma, assignment, session, state } = attendanceFixture();
  assignment.serviceRequest.startTime = '21:00';
  assignment.serviceRequest.endTime = '05:00';
  await clearFixtureWorkday(prisma, session);

  const corrected = await registerManualAttendance(prisma, {
    assignmentId: 'assignment-test',
    arrivalReportedAt: '2026-08-09T21:00',
    departureReportedAt: '2026-08-10T05:00',
    breakTaken: 'true',
    breakStartAt: '2026-08-10T01:00',
    breakEndAt: '2026-08-10T02:00',
    actorUsername: 'coordinacion-prueba',
    actorRole: 'admin',
    now: new Date('2026-08-10T10:30:00.000Z')
  });

  assert.equal(corrected.arrivalReportedAt.toISOString(), '2026-08-10T02:00:00.000Z');
  assert.equal(corrected.departureReportedAt.toISOString(), '2026-08-10T10:00:00.000Z');
  assert.equal(corrected.workedMinutes, 420);
  assert.deepEqual(state.createdMarks.map((mark) => mark.markType), [
    'ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE'
  ]);
  assert.equal(state.createdMarks.find((mark) => mark.markType === 'BREAK_START').clientCapturedAt.toISOString(), '2026-08-10T06:00:00.000Z');
});

test('la reposición individual de entrada tampoco acepta otra fecha', async () => {
  const { prisma, session, state } = attendanceFixture();
  await reviewAttendanceWorkdaySession(prisma, {
    sessionId: session.id,
    action: 'DELETE_MARK',
    markType: 'ARRIVAL',
    markId: 'mark-arrival',
    actorUsername: 'coordinacion-prueba',
    actorRole: 'admin',
    now: new Date('2026-08-09T23:30:00.000Z')
  });

  await assert.rejects(
    reviewAttendanceWorkdaySession(prisma, {
      sessionId: session.id,
      action: 'ADD_MARK',
      markType: 'ARRIVAL',
      reportedAt: '2026-08-10T08:15',
      actorUsername: 'coordinacion-prueba',
      actorRole: 'admin',
      now: new Date('2026-08-10T23:31:00.000Z')
    }),
    /attendance_manual_arrival_date_mismatch/
  );
  assert.equal(state.createdMarks.length, 0);
});

test('la jornada manual rechaza un almuerzo fuera del orden entrada salida', async () => {
  const { prisma, session, state } = attendanceFixture();
  await clearFixtureWorkday(prisma, session);

  await assert.rejects(
    registerManualAttendance(prisma, {
      assignmentId: 'assignment-test',
      arrivalReportedAt: '2026-08-09T08:00',
      departureReportedAt: '2026-08-09T17:00',
      breakTaken: 'true',
      breakStartAt: '2026-08-09T18:00',
      breakEndAt: '2026-08-09T19:00',
      actorUsername: 'coordinacion-prueba',
      actorRole: 'admin',
      now: new Date('2026-08-09T23:40:00.000Z')
    }),
    /attendance_manual_break_after_departure/
  );
  assert.equal(state.createdMarks.length, 0);
});

test('el panel muestra eliminar solo para marcas existentes y repone únicamente correcciones auditadas', () => {
  const ui = readFileSync(new URL('../src/public/attendance-admin-clear-marks.js', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../src/views/operacionesAsistencia.ejs', import.meta.url), 'utf8');
  const runtime = readFileSync(new URL('../src/public/attendance-admin-runtime.js', import.meta.url), 'utf8');
  const route = readFileSync(new URL('../src/routes/dispatchAttendanceAdmin.js', import.meta.url), 'utf8');
  const adminAttendance = readFileSync(new URL('../src/modules/dispatch-attendance/application/adminAttendance.js', import.meta.url), 'utf8');
  const workday = readFileSync(new URL('../src/modules/dispatch-attendance/application/attendanceAdminWorkday.js', import.meta.url), 'utf8');
  const payroll = readFileSync(new URL('../src/modules/dispatch-payroll/application/payrollReport.js', import.meta.url), 'utf8');

  assert.match(ui, /correctionForm\('DELETE_MARK'/);
  assert.match(ui, /correctionForm\('ADD_MARK'/);
  assert.match(ui, /existingMarks = markState\.filter\(\(mark\) => Boolean\(mark\.markId\)\)/);
  assert.match(ui, /replacementMarks = markState\.filter\(\(mark\) => !mark\.markId && pendingTypes\.has\(mark\.markType\)\)/);
  assert.match(ui, /button\.textContent = `Eliminar \$\{mark\.label\}`/);
  assert.doesNotMatch(ui, /Eliminar solo/);
  assert.match(ui, /Guardar nueva \$\{mark\.label\}/);
  assert.match(ui, /correctionSessionId/);
  assert.match(ui, /pendingCorrectionMarkTypes/);
  assert.match(ui, /window\.confirm/);
  assert.match(ui, /Las demás marcaciones de la jornada se conservarán/);
  assert.match(ui, /Corregir jornada completa/);
  assert.match(ui, /hiddenInput\('action', 'CLEAR'\)/);
  assert.match(ui, /Eliminar todas las marcaciones/);
  assert.match(runtime, /attendance-admin-clear-marks\.js/);
  assert.match(view, /data-attendance-review-action/);
  assert.match(view, /data-arrival-mark-id/);
  assert.match(view, /data-break-start-mark-id/);
  assert.match(view, /data-break-end-mark-id/);
  assert.match(view, /data-departure-mark-id/);
  assert.match(view, /data-pending-correction-mark-types/);
  assert.match(view, /Corrección de marcación pendiente/);
  assert.match(view, /row\.sessionId && row\.arrivalReportedAt && !granularCorrectionActive/);
  assert.match(view, /row\.serviceDateLabel %> · <%= row\.scheduleLabel/);
  assert.match(view, /data-correction-focused/);
  assert.match(view, /correctionFocused \? 'open' : ''/);
  assert.match(view, /scrollIntoView/);
  assert.match(view, /name="arrivalReportedAt" min="<%= serviceDateTimeMin %>" max="<%= serviceDateTimeMax %>"/);
  assert.match(view, /name="departureReportedAt" min="<%= serviceDateTimeMin %>" max="<%= latestManualDateTimeMax %>"/);
  assert.match(route, /router\.post\('\/sessions\/:sessionId\/review'/);
  assert.match(route, /markId:\s*req\.body\.markId/);
  assert.match(route, /markType:\s*req\.body\.markType/);
  assert.match(route, /reportedAt:\s*req\.body\.reportedAt/);
  assert.match(route, /correctionMarkType/);
  assert.match(route, /correctionSessionId/);
  assert.match(route, /focusSessionId:\s*correctionSessionId\(req\.query\?\.correctionSessionId\)/);
  assert.match(route, /correctionAction = \['DELETE_MARK', 'ADD_MARK', 'CLEAR'\]\.includes\(action\)/);
  assert.match(route, /attendance_review_mark_not_pending_correction/);
  assert.match(route, /reviewAttendanceWorkdaySession/);
  assert.match(adminAttendance, /validateAttendanceTimelineAgainstAssignment/);
  assert.match(adminAttendance, /attendance_manual_arrival_date_mismatch/);
  assert.match(adminAttendance, /attendance_manual_mark_date_outside_assignment/);
  assert.match(adminAttendance, /latestManualDateIso/);
  assert.match(workday, /dispatchAttendanceMark\.deleteMany/);
  assert.match(workday, /dispatchAttendanceMark\.delete\(/);
  assert.match(workday, /WORKDAY_DELETE_MARK/);
  assert.match(workday, /WORKDAY_ADD_MARK/);
  assert.match(workday, /markCorrectionPending/);
  assert.match(workday, /attendance_review_mark_not_pending_correction/);
  assert.match(workday, /pendingCorrectionMarkTypes/);
  assert.match(workday, /validateAttendanceTimelineAgainstAssignment/);
  assert.doesNotMatch(workday, /dispatchAttendanceSession\.delete/);
  assert.doesNotMatch(workday, /dispatchAssignment\.delete/);
  assert.match(payroll, /arrivalReportedAt:\s*\{ gte: start, lt: end \}/);
  assert.match(payroll, /departureReportedAt:\s*\{ not: null \}/);
});
