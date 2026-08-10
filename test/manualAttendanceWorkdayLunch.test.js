import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerManualAttendance } from '../src/modules/dispatch-attendance/application/adminAttendance.js';
import { reviewAttendanceWorkdaySession } from '../src/modules/dispatch-attendance/application/attendanceAdminWorkday.js';

function assignment({ manualAttendanceAllowed = true } = {}) {
  return {
    id: 'assignment-manual-lunch',
    workerId: 'worker-test',
    serviceRequestId: 'request-test',
    status: 'CONFIRMED',
    worker: {
      id: 'worker-test',
      fullName: 'Auxiliar Prueba'
    },
    serviceRequest: {
      id: 'request-test',
      serviceDate: new Date('2026-08-09T00:00:00.000Z'),
      startTime: '08:00',
      endTime: '16:00',
      operationPoint: {
        id: 'point-test',
        manualAttendanceAllowed
      }
    },
    attendanceSession: null
  };
}

function prismaContract(options = {}) {
  const state = {
    assignment: assignment(options),
    session: null,
    marks: [],
    reviews: []
  };

  const sessionSnapshot = () => state.session ? {
    ...state.session,
    marks: state.marks.map((mark) => ({ ...mark })),
    reviews: state.reviews.map((review) => ({ ...review })),
    assignment: {
      ...state.assignment,
      attendanceSession: undefined
    }
  } : null;

  const prisma = {
    dispatchAssignment: {
      async findMany() { return []; },
      async findUnique() {
        return {
          ...state.assignment,
          attendanceSession: state.session ? { ...state.session } : null
        };
      }
    },
    dispatchAttendanceSession: {
      async findUnique() { return sessionSnapshot(); },
      async create({ data }) {
        state.session = { id: 'session-test', ...data };
        return { ...state.session };
      },
      async update({ where, data }) {
        assert.equal(where.id, state.session.id);
        state.session = { ...state.session, ...data };
        return { ...state.session };
      }
    },
    dispatchAttendanceMark: {
      async findFirst({ where }) {
        return state.marks.find((mark) => (
          mark.attendanceSessionId === where.attendanceSessionId
          && (!where.markType || mark.markType === where.markType)
        )) || null;
      },
      async create({ data }) {
        const mark = { id: `mark-${state.marks.length + 1}`, ...data };
        state.marks.push(mark);
        return { ...mark };
      },
      async update({ where, data }) {
        const index = state.marks.findIndex((mark) => mark.id === where.id);
        if (index >= 0) state.marks[index] = { ...state.marks[index], ...data };
        return index >= 0 ? { ...state.marks[index] } : { id: where.id, ...data };
      }
    },
    dispatchAttendanceReview: {
      async create({ data }) {
        const review = { id: `review-${state.reviews.length + 1}`, createdAt: new Date(), ...data };
        state.reviews.unshift(review);
        return { ...review };
      }
    }
  };
  prisma.$transaction = async (callback) => callback(prisma);
  return { prisma, state };
}

async function registerArrival(prisma) {
  return registerManualAttendance(prisma, {
    assignmentId: 'assignment-manual-lunch',
    arrivalReportedAt: '2026-08-09T08:00',
    actorUsername: 'operaciones-prueba',
    actorRole: 'admin',
    now: new Date('2026-08-09T22:00:00.000Z')
  });
}

async function addMark(prisma, markType, reportedAt, nowMinute) {
  return reviewAttendanceWorkdaySession(prisma, {
    sessionId: 'session-test',
    action: 'ADD_MARK',
    markType,
    reportedAt,
    manualAddition: true,
    actorUsername: 'operaciones-prueba',
    actorRole: 'admin',
    now: new Date(`2026-08-09T22:${String(nowMinute).padStart(2, '0')}:00.000Z`)
  });
}

test('la asistencia manual se completa por marcaciones independientes y solo calcula al tener lo necesario', async () => {
  const { prisma, state } = prismaContract();

  const arrivalSession = await registerArrival(prisma);
  assert.equal(arrivalSession.attendanceStatus, 'ARRIVAL_REPORTED');
  assert.equal(arrivalSession.validationStatus, 'REVIEW_REQUIRED');
  assert.equal(arrivalSession.workedMinutes, undefined);
  assert.deepEqual(state.marks.map((mark) => mark.markType), ['ARRIVAL']);
  assert.equal(state.reviews[0].action, 'MANUAL_MARK');
  assert.equal(state.reviews[0].reason, 'Marcación manual registrada por coordinación.');

  const afterBreakStart = await addMark(prisma, 'BREAK_START', '2026-08-09T12:00', 1);
  assert.equal(afterBreakStart.attendanceStatus, 'ARRIVAL_REPORTED');
  assert.equal(afterBreakStart.workedMinutes, null);
  assert.deepEqual(state.marks.map((mark) => mark.markType), ['ARRIVAL', 'BREAK_START']);

  const afterBreakEnd = await addMark(prisma, 'BREAK_END', '2026-08-09T13:00', 2);
  assert.equal(afterBreakEnd.attendanceStatus, 'ARRIVAL_REPORTED');
  assert.equal(afterBreakEnd.workedMinutes, null);
  assert.deepEqual(state.marks.map((mark) => mark.markType), ['ARRIVAL', 'BREAK_START', 'BREAK_END']);

  const completed = await addMark(prisma, 'DEPARTURE', '2026-08-09T16:00', 3);
  assert.equal(completed.attendanceStatus, 'COMPLETED');
  assert.equal(completed.validationStatus, 'MANUAL_VALIDATED');
  assert.equal(completed.workedMinutes, 420);
  assert.deepEqual(
    state.marks.map((mark) => mark.markType),
    ['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE']
  );
  assert.equal(state.marks[1].clientCapturedAt.toISOString(), '2026-08-09T17:00:00.000Z');
  assert.equal(state.marks[2].clientCapturedAt.toISOString(), '2026-08-09T18:00:00.000Z');
  assert.equal(state.reviews.filter((review) => review.action === 'MANUAL_MARK').length, 4);
});

test('inicio y fin de almuerzo no se obligan a enviarse juntos', async () => {
  const { prisma, state } = prismaContract();
  await registerArrival(prisma);

  await addMark(prisma, 'BREAK_END', '2026-08-09T13:00', 1);
  assert.deepEqual(state.marks.map((mark) => mark.markType), ['ARRIVAL', 'BREAK_END']);
  assert.equal(state.session.workedMinutes, null);

  await addMark(prisma, 'BREAK_START', '2026-08-09T12:00', 2);
  assert.deepEqual(state.marks.map((mark) => mark.markType), ['ARRIVAL', 'BREAK_END', 'BREAK_START']);
  assert.equal(state.session.workedMinutes, null);
});

test('una marcación manual faltante conserva permiso backend y evita duplicados', async () => {
  const { prisma, state } = prismaContract();
  await registerArrival(prisma);
  await addMark(prisma, 'BREAK_START', '2026-08-09T12:00', 1);

  await assert.rejects(
    () => addMark(prisma, 'BREAK_START', '2026-08-09T12:05', 2),
    /attendance_review_mark_exists/
  );

  state.assignment.serviceRequest.operationPoint.manualAttendanceAllowed = false;
  await assert.rejects(
    () => addMark(prisma, 'BREAK_END', '2026-08-09T13:00', 3),
    /attendance_manual_not_allowed/
  );
});

test('la vista ofrece un formulario independiente para cada marcación faltante', () => {
  const loader = fs.readFileSync(
    new URL('../src/public/attendance-admin-runtime.js', import.meta.url),
    'utf8'
  );
  const route = fs.readFileSync(
    new URL('../src/routes/dispatchAttendanceAdmin.js', import.meta.url),
    'utf8'
  );
  const view = fs.readFileSync(
    new URL('../src/views/operacionesAsistencia.ejs', import.meta.url),
    'utf8'
  );

  assert.match(view, /data-manual-mark-section="true"/);
  assert.match(view, /Marcación manual por evento/);
  assert.match(view, /Registra únicamente la marcación que necesites/);
  assert.match(view, /data-manual-mark-form="ARRIVAL"/);
  assert.match(view, /type: 'BREAK_START', label: 'Inicio de almuerzo'/);
  assert.match(view, /type: 'BREAK_END', label: 'Fin de almuerzo'/);
  assert.match(view, /type: 'DEPARTURE', label: 'Salida'/);
  assert.match(view, /name="action" value="ADD_MARK"/);
  assert.match(view, /name="manualMark" value="true"/);
  assert.doesNotMatch(view, /data-manual-workday-form="true"/);
  assert.doesNotMatch(view, /name="breakTaken"/);
  assert.doesNotMatch(view, /Registrar jornada manual/);

  assert.match(loader, /attendance-admin-manual-workday\.js/);
  assert.match(route, /manualAddition:\s*manualMarkAddition/);
  assert.match(route, /La marcación manual quedó registrada y auditada\./);
  assert.match(route, /La nueva hora quedó registrada en la misma jornada y quedó auditada\./);
});

test('la tarjeta comprimida muestra solo identificación operativa esencial', () => {
  const view = fs.readFileSync(
    new URL('../src/views/operacionesAsistencia.ejs', import.meta.url),
    'utf8'
  );
  const compactRuntime = fs.readFileSync(
    new URL('../src/public/attendance-admin-compact.js', import.meta.url),
    'utf8'
  );
  const summary = view.match(/<summary class="attendance-summary">[\s\S]*?<\/summary>/)?.[0] || '';

  assert.match(summary, /row\.serviceDateLabel/);
  assert.match(summary, /row\.workerName/);
  assert.match(summary, /Ciudad/);
  assert.match(summary, /row\.cityName/);
  assert.match(summary, /Operación/);
  assert.match(summary, /row\.operationPointName/);
  assert.match(summary, /Documento/);
  assert.match(summary, /row\.documentType/);
  assert.match(summary, /row\.documentNumber/);
  assert.doesNotMatch(summary, /Fecha de asignación/i);

  assert.doesNotMatch(summary, /row\.phone/);
  assert.doesNotMatch(summary, /row\.address/);
  assert.doesNotMatch(summary, /row\.scheduleLabel/);
  assert.doesNotMatch(summary, /row\.statusLabel/);
  assert.doesNotMatch(summary, /row\.arrivalReportedLabel/);
  assert.doesNotMatch(summary, /row\.departureReportedLabel/);
  assert.doesNotMatch(summary, /row\.overtimeLabel/);
  assert.doesNotMatch(summary, /row\.riskScore/);

  assert.match(compactRuntime, /installSummaryLayouts\(\)/);
  assert.match(compactRuntime, /width < 360/);
  assert.match(compactRuntime, /width < 560/);
  assert.match(compactRuntime, /repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(compactRuntime, /minmax\(0, 1\.35fr\) repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(compactRuntime, /item\.style\.overflowWrap = 'anywhere'/);
  assert.doesNotMatch(compactRuntime, /label\.includes\('inicio de almuerzo'\)/);
  assert.doesNotMatch(compactRuntime, /label\.includes\('fin de almuerzo'\)/);

  assert.doesNotMatch(view, /row\.phone/);
  assert.doesNotMatch(view, /row\.address/);
  assert.match(view, /Llegada reportada/);
  assert.match(view, /Inicio de almuerzo/);
  assert.match(view, /Fin de almuerzo/);
  assert.match(view, /Salida reportada/);
  assert.match(view, /Almuerzo descontado/);
});