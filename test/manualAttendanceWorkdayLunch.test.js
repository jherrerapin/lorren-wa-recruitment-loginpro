import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerManualAttendance } from '../src/modules/dispatch-attendance/application/adminAttendance.js';

function assignment() {
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
        manualAttendanceAllowed: true
      }
    },
    attendanceSession: null
  };
}

function prismaContract() {
  const marks = [];
  const reviews = [];
  const prisma = {
    dispatchAssignment: {
      async findMany() { return []; },
      async findUnique() { return assignment(); }
    },
    dispatchAttendanceSession: {
      async findUnique() { return null; },
      async create({ data }) { return { id: 'session-test', ...data }; },
      async update({ where, data }) { return { id: where.id, ...data }; }
    },
    dispatchAttendanceMark: {
      async findFirst() { return null; },
      async create({ data }) {
        marks.push(data);
        return { id: `mark-${marks.length}`, ...data };
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
  return { prisma, marks, reviews };
}

function incrementalPrismaContract() {
  const baseAssignment = assignment();
  const marks = [];
  const reviews = [];
  let session = null;
  const prisma = {
    dispatchAssignment: {
      async findMany() { return []; },
      async findUnique() {
        return {
          ...baseAssignment,
          attendanceSession: session ? { ...session, marks: [...marks] } : null
        };
      }
    },
    dispatchAttendanceSession: {
      async findUnique() { return session ? { ...session } : null; },
      async create({ data }) {
        session = { id: 'session-incremental', ...data };
        return { ...session };
      },
      async update({ where, data }) {
        assert.equal(where.id, 'session-incremental');
        session = { ...session, ...data };
        return { ...session };
      }
    },
    dispatchAttendanceMark: {
      async findFirst() { return null; },
      async create({ data }) {
        const mark = { id: `mark-${marks.length + 1}`, ...data };
        marks.push(mark);
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
  return {
    prisma,
    marks,
    reviews,
    session: () => session
  };
}

const manualActor = Object.freeze({
  actorUsername: 'operaciones-prueba',
  actorRole: 'admin',
  now: new Date('2026-08-09T22:00:00.000Z')
});

test('la jornada manual no pide motivo al coordinador y conserva auditoría técnica', async () => {
  const { prisma, marks, reviews } = prismaContract();

  const session = await registerManualAttendance(prisma, {
    assignmentId: 'assignment-manual-lunch',
    arrivalReportedAt: '2026-08-09T08:00',
    departureReportedAt: '2026-08-09T16:00',
    ...manualActor
  });

  assert.equal(session.workedMinutes, 480);
  assert.deepEqual(marks.map((mark) => mark.markType), ['ARRIVAL', 'DEPARTURE']);
  assert.equal(reviews[0].action, 'MANUAL_WORKDAY');
  assert.equal(reviews[0].reason, 'Jornada manual registrada por coordinación.');
  assert.equal(reviews[0].metadata.breakTaken, false);
});

test('una jornada completa conserva el descuento real cuando se ingresan las dos marcas de almuerzo', async () => {
  const { prisma, marks, reviews } = prismaContract();

  const session = await registerManualAttendance(prisma, {
    assignmentId: 'assignment-manual-lunch',
    arrivalReportedAt: '2026-08-09T08:00',
    departureReportedAt: '2026-08-09T16:00',
    breakStartAt: '2026-08-09T12:00',
    breakEndAt: '2026-08-09T13:00',
    ...manualActor
  });

  assert.equal(session.workedMinutes, 420);
  assert.deepEqual(
    marks.map((mark) => mark.markType),
    ['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE']
  );
  assert.equal(reviews[0].metadata.breakTaken, true);
  assert.equal(reviews[0].metadata.manualBreakStartAt, '2026-08-09T17:00:00.000Z');
  assert.equal(reviews[0].metadata.manualBreakEndAt, '2026-08-09T18:00:00.000Z');
});

test('permite registrar entrada, inicio de almuerzo, fin de almuerzo y salida en cuatro operaciones independientes', async () => {
  const { prisma, marks, reviews, session } = incrementalPrismaContract();

  const arrival = await registerManualAttendance(prisma, {
    assignmentId: 'assignment-manual-lunch',
    arrivalReportedAt: '2026-08-09T08:00',
    ...manualActor
  });
  assert.equal(arrival.attendanceStatus, 'ARRIVAL_REPORTED');
  assert.equal(arrival.validationStatus, 'REVIEW_REQUIRED');
  assert.equal(arrival.workedMinutes, null);
  assert.deepEqual(marks.map((mark) => mark.markType), ['ARRIVAL']);

  const breakStart = await registerManualAttendance(prisma, {
    assignmentId: 'assignment-manual-lunch',
    breakStartAt: '2026-08-09T12:00',
    ...manualActor
  });
  assert.equal(breakStart.attendanceStatus, 'ARRIVAL_REPORTED');
  assert.deepEqual(marks.map((mark) => mark.markType), ['ARRIVAL', 'BREAK_START']);

  const breakEnd = await registerManualAttendance(prisma, {
    assignmentId: 'assignment-manual-lunch',
    breakEndAt: '2026-08-09T13:00',
    ...manualActor
  });
  assert.equal(breakEnd.attendanceStatus, 'ARRIVAL_REPORTED');
  assert.deepEqual(marks.map((mark) => mark.markType), ['ARRIVAL', 'BREAK_START', 'BREAK_END']);

  const departure = await registerManualAttendance(prisma, {
    assignmentId: 'assignment-manual-lunch',
    departureReportedAt: '2026-08-09T16:00',
    ...manualActor
  });
  assert.equal(departure.attendanceStatus, 'COMPLETED');
  assert.equal(departure.validationStatus, 'MANUAL_VALIDATED');
  assert.equal(departure.workedMinutes, 420);
  assert.deepEqual(
    marks.map((mark) => mark.markType),
    ['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE']
  );
  assert.ok(reviews.every((review) => review.action === 'MANUAL_MARK'));
  assert.deepEqual(reviews.at(-1).metadata.addedMarkTypes, ['DEPARTURE']);
  assert.equal(session().arrivalReportedAt.toISOString(), '2026-08-09T13:00:00.000Z');
  assert.equal(session().departureReportedAt.toISOString(), '2026-08-09T21:00:00.000Z');
});

test('permite registrar por separado el fin de almuerzo aunque todavía falte su inicio', async () => {
  const { prisma, marks } = incrementalPrismaContract();

  const result = await registerManualAttendance(prisma, {
    assignmentId: 'assignment-manual-lunch',
    breakEndAt: '2026-08-09T13:00',
    ...manualActor
  });

  assert.equal(result.attendanceStatus, 'PENDING');
  assert.equal(result.validationStatus, 'REVIEW_REQUIRED');
  assert.equal(result.workedMinutes, null);
  assert.deepEqual(marks.map((mark) => mark.markType), ['BREAK_END']);
});

test('no duplica una marcación manual que ya quedó persistida', async () => {
  const { prisma } = incrementalPrismaContract();
  await registerManualAttendance(prisma, {
    assignmentId: 'assignment-manual-lunch',
    arrivalReportedAt: '2026-08-09T08:00',
    ...manualActor
  });

  await assert.rejects(
    registerManualAttendance(prisma, {
      assignmentId: 'assignment-manual-lunch',
      arrivalReportedAt: '2026-08-09T08:05',
      ...manualActor
    }),
    /attendance_manual_mark_exists/
  );
});

test('rechaza un envío manual sin ninguna hora ingresada', async () => {
  const { prisma } = incrementalPrismaContract();
  await assert.rejects(
    registerManualAttendance(prisma, {
      assignmentId: 'assignment-manual-lunch',
      arrivalReportedAt: '',
      breakStartAt: '',
      breakEndAt: '',
      departureReportedAt: '',
      ...manualActor
    }),
    /attendance_manual_mark_required/
  );
});

test('la vista permite diligenciar cualquier subconjunto de las cuatro marcaciones', () => {
  const route = fs.readFileSync(
    new URL('../src/routes/dispatchAttendanceAdmin.js', import.meta.url),
    'utf8'
  );
  const view = fs.readFileSync(
    new URL('../src/views/operacionesAsistencia.ejs', import.meta.url),
    'utf8'
  );
  const manualForm = view.match(/<form class="review-form" method="post" action="\/admin\/operaciones\/asistencia\/assignments\/<%= row\.assignmentId %>\/manual">[\s\S]*?<\/form>/)?.[0] || '';

  assert.match(manualForm, /name="arrivalReportedAt"/);
  assert.match(manualForm, /name="breakStartAt"/);
  assert.match(manualForm, /name="breakEndAt"/);
  assert.match(manualForm, /name="departureReportedAt"/);
  assert.match(manualForm, /Puedes guardar una sola marca/);
  assert.match(manualForm, /Guardar marcaciones ingresadas/);
  assert.doesNotMatch(manualForm, /name="breakTaken"/);
  assert.doesNotMatch(manualForm, /\srequired(?:\s|\/|>)/);
  assert.doesNotMatch(manualForm, /name="reason"/);
  assert.match(view, /hasMissingManualMark/);
  assert.match(view, /row\.manualAttendanceAllowed && !granularCorrectionActive && hasMissingManualMark/);

  assert.match(route, /arrivalReportedAt: req\.body\.arrivalReportedAt/);
  assert.match(route, /breakStartAt: req\.body\.breakStartAt/);
  assert.match(route, /breakEndAt: req\.body\.breakEndAt/);
  assert.match(route, /departureReportedAt: req\.body\.departureReportedAt/);
  assert.doesNotMatch(route, /breakTaken: req\.body\.breakTaken/);
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
