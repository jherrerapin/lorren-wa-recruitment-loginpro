import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerManualAttendance } from '../src/modules/dispatch-attendance/application/adminAttendance.js';
import {
  INCOMPLETE_DISPATCH_BREAK_PENALTY_MINUTES,
  resolveIncompleteDispatchBreakPenaltyEndAt
} from '../src/modules/dispatch-attendance/domain/attendanceWorkdayPolicy.js';
import { resolveManualBreakPenaltyEndAt } from '../src/routes/dispatchAttendanceAdmin.js';

function overnightAssignment() {
  return {
    id: 'assignment-overnight-penalty',
    workerId: 'worker-test',
    serviceRequestId: 'request-overnight',
    status: 'CONFIRMED',
    worker: {
      id: 'worker-test',
      fullName: 'Auxiliar Prueba'
    },
    serviceRequest: {
      id: 'request-overnight',
      serviceDate: new Date('2026-08-13T00:00:00.000Z'),
      startTime: '22:00',
      endTime: '06:00',
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
  let session = null;
  const assignment = overnightAssignment();
  const prisma = {
    dispatchAssignment: {
      async findMany() { return []; },
      async findUnique() {
        return {
          ...assignment,
          attendanceSession: session ? { ...session, marks: [...marks] } : null
        };
      }
    },
    dispatchAttendanceSession: {
      async findUnique() { return session ? { ...session } : null; },
      async create({ data }) {
        session = { id: 'session-overnight-penalty', ...data };
        return { ...session };
      },
      async update({ where, data }) {
        assert.equal(where.id, 'session-overnight-penalty');
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
  return { prisma, marks, reviews };
}

test('la autoridad canónica calcula el fin de penalización exactamente 90 minutos después', () => {
  assert.equal(INCOMPLETE_DISPATCH_BREAK_PENALTY_MINUTES, 90);
  assert.equal(
    resolveIncompleteDispatchBreakPenaltyEndAt(new Date('2026-08-14T06:00:00.000Z')).toISOString(),
    '2026-08-14T07:30:00.000Z'
  );
  assert.equal(resolveManualBreakPenaltyEndAt('2026-08-14T01:00'), '2026-08-14T02:30');
  assert.equal(resolveManualBreakPenaltyEndAt('2026-08-13T23:30'), '2026-08-14T01:00');
});

test('coordinación puede materializar 90 minutos de penalización en un turno nocturno del día siguiente', async () => {
  const { prisma, marks, reviews } = prismaContract();
  const breakStartAt = '2026-08-14T01:00';
  const breakEndAt = resolveManualBreakPenaltyEndAt(breakStartAt);

  const result = await registerManualAttendance(prisma, {
    assignmentId: 'assignment-overnight-penalty',
    arrivalReportedAt: '2026-08-13T22:00',
    breakStartAt,
    breakEndAt,
    departureReportedAt: '2026-08-14T06:00',
    reason: 'Penalización administrativa de almuerzo por falta de marcación del auxiliar.',
    notes: 'Coordinación generó automáticamente un intervalo de 90 minutos por falta de marcación de almuerzo.',
    actorUsername: 'coordinacion-prueba',
    actorRole: 'admin',
    now: new Date('2026-08-14T12:00:00.000Z')
  });

  assert.equal(result.attendanceStatus, 'COMPLETED');
  assert.equal(result.validationStatus, 'MANUAL_VALIDATED');
  assert.equal(result.workedMinutes, 390);
  assert.deepEqual(marks.map((mark) => mark.markType), [
    'ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE'
  ]);
  assert.equal(
    marks.find((mark) => mark.markType === 'BREAK_START').clientCapturedAt.toISOString(),
    '2026-08-14T06:00:00.000Z'
  );
  assert.equal(
    marks.find((mark) => mark.markType === 'BREAK_END').clientCapturedAt.toISOString(),
    '2026-08-14T07:30:00.000Z'
  );
  assert.equal(reviews[0].reason, 'Penalización administrativa de almuerzo por falta de marcación del auxiliar.');
  assert.equal(reviews[0].notes, 'Coordinación generó automáticamente un intervalo de 90 minutos por falta de marcación de almuerzo.');
  assert.equal(reviews[0].metadata.workedMinutes, 390);
});

test('la interfaz mantiene el check de penalización y usa los límites continuos sin ampliar la entrada', () => {
  const view = fs.readFileSync(
    new URL('../src/views/operacionesAsistencia.ejs', import.meta.url),
    'utf8'
  );
  const route = fs.readFileSync(
    new URL('../src/routes/dispatchAttendanceAdmin.js', import.meta.url),
    'utf8'
  );
  const form = view.match(/<form class="review-form" method="post" action="\/admin\/operaciones\/asistencia\/assignments\/<%= row\.assignmentId %>\/manual" data-manual-attendance-form>[\s\S]*?<\/form>/)?.[0] || '';

  assert.match(view, /hasOvernightManualDate/);
  assert.match(form, /name="penalizeMissingBreak"/);
  assert.match(form, /data-manual-break-penalty/);
  assert.match(form, /Penalizar no marcación de almuerzo/);
  assert.match(form, /Día siguiente · <%= row\.latestManualDateIso %>/);
  assert.match(form, /data-manual-date="<%= row\.latestManualDateIso %>"/);
  assert.match(form, /name="arrivalReportedAt" min="<%= serviceDateTimeMin %>" max="<%= serviceDateTimeMax %>"/);
  assert.match(form, /name="breakStartAt" min="<%= manualBreakStartMin %>" max="<%= manualBreakStartMax %>"/);
  assert.match(form, /name="departureReportedAt" min="<%= manualDepartureMin %>" max="<%= manualDepartureMax %>"/);
  assert.match(view, /breakEnd\.disabled = active/);
  assert.match(view, /breakEndField\.hidden = active/);
  assert.match(view, /breakStart\.required = active/);

  assert.match(route, /req\.body\.penalizeMissingBreak === 'true'/);
  assert.match(route, /resolveManualBreakPenaltyEndAt\(req\.body\.breakStartAt\)/);
  assert.match(route, /Penalización administrativa de almuerzo por falta de marcación del auxiliar\./);
  assert.match(route, /Coordinación generó automáticamente un intervalo de 90 minutos/);
});
