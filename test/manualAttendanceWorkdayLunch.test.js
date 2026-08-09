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

test('el runtime quita el motivo y muestra el check que habilita horas de almuerzo', () => {
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

  assert.match(runtime, /form\.querySelector\('input\[name="reason"\]'\)\?\.remove\(\)/);
  assert.match(runtime, /checkbox\.name = 'breakTaken'/);
  assert.match(runtime, /Tomó almuerzo/);
  assert.match(runtime, /createDateTimeField\('breakStartAt', 'Inicio de almuerzo'\)/);
  assert.match(runtime, /createDateTimeField\('breakEndAt', 'Fin de almuerzo'\)/);
  assert.match(loader, /attendance-admin-manual-workday\.js/);
  assert.match(route, /breakTaken: req\.body\.breakTaken/);
  assert.match(route, /breakStartAt: req\.body\.breakStartAt/);
  assert.match(route, /breakEndAt: req\.body\.breakEndAt/);
});
