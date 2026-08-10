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

test('la jornada manual no pide motivo al coordinador y conserva auditoría técnica', async () => {
  const { prisma, marks, reviews } = prismaContract();

  const session = await registerManualAttendance(prisma, {
    assignmentId: 'assignment-manual-lunch',
    arrivalReportedAt: '2026-08-09T08:00',
    departureReportedAt: '2026-08-09T16:00',
    actorUsername: 'operaciones-prueba',
    actorRole: 'admin',
    now: new Date('2026-08-09T22:00:00.000Z')
  });

  assert.equal(session.workedMinutes, 480);
  assert.deepEqual(marks.map((mark) => mark.markType), ['ARRIVAL', 'DEPARTURE']);
  assert.equal(reviews[0].reason, 'Jornada manual registrada por coordinación.');
  assert.equal(reviews[0].metadata.breakTaken, false);
});

test('el check de almuerzo registra inicio y fin y descuenta el intervalo real', async () => {
  const { prisma, marks, reviews } = prismaContract();

  const session = await registerManualAttendance(prisma, {
    assignmentId: 'assignment-manual-lunch',
    arrivalReportedAt: '2026-08-09T08:00',
    departureReportedAt: '2026-08-09T16:00',
    breakTaken: 'true',
    breakStartAt: '2026-08-09T12:00',
    breakEndAt: '2026-08-09T13:00',
    actorUsername: 'operaciones-prueba',
    actorRole: 'admin',
    now: new Date('2026-08-09T22:00:00.000Z')
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

test('la vista muestra el almuerzo manual y el runtime solo controla su interacción', () => {
  const runtime = fs.readFileSync(
    new URL('../src/public/attendance-admin-manual-workday.js', import.meta.url),
    'utf8'
  );
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
  const manualForm = view.match(/<form class="review-form" method="post" action="\/admin\/operaciones\/asistencia\/assignments\/<%= row\.assignmentId %>\/manual"[\s\S]*?<\/form>/)?.[0] || '';

  assert.match(manualForm, /data-manual-workday-form="true"/);
  assert.match(manualForm, /name="breakTaken"/);
  assert.match(manualForm, /Tomó almuerzo/);
  assert.match(manualForm, /name="breakStartAt"/);
  assert.match(manualForm, /Inicio de almuerzo/);
  assert.match(manualForm, /name="breakEndAt"/);
  assert.match(manualForm, /Fin de almuerzo/);
  assert.match(manualForm, /data-manual-break-fields hidden/);
  assert.doesNotMatch(manualForm, /name="reason"/);

  assert.match(runtime, /form\.querySelector\('\[data-manual-break-toggle\]'\)/);
  assert.match(runtime, /const breakTaken = checkbox\.checked/);
  assert.match(runtime, /breakFields\.hidden = !breakTaken/);
  assert.match(runtime, /breakFields\.style\.display = breakTaken \? 'grid' : 'none'/);
  assert.match(runtime, /startInput\.required = breakTaken/);
  assert.match(runtime, /endInput\.required = breakTaken/);
  assert.match(runtime, /startInput\.disabled = !breakTaken/);
  assert.match(runtime, /endInput\.disabled = !breakTaken/);
  assert.match(runtime, /startInput\.value = ''/);
  assert.match(runtime, /endInput\.value = ''/);
  assert.match(runtime, /checkbox\.style\.accentColor = '#0d7a6b'/);
  assert.match(runtime, /Tomó almuerzo: sí/);
  assert.match(runtime, /Tomó almuerzo: no/);
  assert.match(runtime, /aria-expanded/);
  assert.doesNotMatch(runtime, /createDateTimeField/);
  assert.doesNotMatch(runtime, /document\.createElement/);

  assert.match(loader, /attendance-admin-manual-workday\.js/);
  assert.match(route, /breakTaken: req\.body\.breakTaken/);
  assert.match(route, /breakStartAt: req\.body\.breakStartAt/);
  assert.match(route, /breakEndAt: req\.body\.breakEndAt/);
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
