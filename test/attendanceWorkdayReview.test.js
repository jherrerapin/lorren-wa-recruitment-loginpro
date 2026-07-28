import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewAttendanceWorkdaySession } from '../src/modules/dispatch-attendance/application/attendanceAdminWorkday.js';

function fixture({ earlyArrival = false, incompleteBreak = false, noBreak = false } = {}) {
  const arrivalReportedAt = new Date(earlyArrival
    ? '2026-07-25T12:30:00.000Z'
    : '2026-07-25T13:00:00.000Z');
  const breakMarks = noBreak
    ? []
    : [
        { id: 'break-start-1', markType: 'BREAK_START', serverReceivedAt: new Date('2026-07-25T17:00:00.000Z') },
        ...(incompleteBreak ? [] : [{ id: 'break-end-1', markType: 'BREAK_END', serverReceivedAt: new Date('2026-07-25T18:00:00.000Z') }])
      ];
  const session = {
    id: 'session-1',
    assignmentId: 'assignment-1',
    attendanceStatus: 'DEPARTURE_REPORTED',
    validationStatus: 'REVIEW_REQUIRED',
    punctualityStatus: 'ON_TIME',
    expectedStartAt: new Date('2026-07-25T13:00:00.000Z'),
    expectedEndAt: new Date('2026-07-25T22:00:00.000Z'),
    arrivalReportedAt,
    arrivalValidatedAt: new Date('2026-07-25T13:00:05.000Z'),
    departureReportedAt: new Date('2026-07-25T22:00:00.000Z'),
    departureValidatedAt: null,
    workedMinutes: 480,
    marks: [
      { id: 'arrival-mark-1', markType: 'ARRIVAL', serverReceivedAt: arrivalReportedAt },
      ...breakMarks,
      { id: 'departure-mark-1', markType: 'DEPARTURE', serverReceivedAt: new Date('2026-07-25T22:00:00.000Z') }
    ],
    assignment: {
      id: 'assignment-1',
      workerId: 'worker-1',
      serviceRequestId: 'request-1',
      worker: { fullName: 'Auxiliar Prueba' },
      serviceRequest: { id: 'request-1' }
    }
  };
  const state = { update: null, markUpdate: null, review: null };
  const client = {
    dispatchAttendanceSession: {
      async findUnique() { return session; },
      async update({ data }) {
        Object.assign(session, data);
        state.update = { ...data };
        return { ...session };
      }
    },
    dispatchAttendanceMark: {
      async update({ data }) {
        state.markUpdate = data;
        return { id: 'departure-mark-1', ...data };
      }
    },
    dispatchAttendanceReview: {
      async create({ data }) {
        state.review = data;
        return { id: 'review-1', ...data };
      }
    }
  };
  const prisma = {
    ...client,
    async $transaction(callback) { return callback(client); }
  };
  return { prisma, session, state };
}

test('valida una jornada y audita horas ordinarias y extras', async () => {
  const { prisma, session, state } = fixture();
  const now = new Date('2026-07-25T22:10:00.000Z');
  const result = await reviewAttendanceWorkdaySession(prisma, {
    sessionId: 'session-1',
    action: 'VALIDATE',
    attendanceStatus: 'LATE',
    reason: 'Llegada tarde por 18 minutos frente a la hora programada.',
    actorUsername: 'dev',
    actorRole: 'dev',
    now
  });
  assert.equal(result.attendanceStatus, 'COMPLETED');
  assert.equal(result.validationStatus, 'MANUAL_VALIDATED');
  assert.equal(result.punctualityStatus, 'LATE');
  assert.equal(result.workedMinutes, 480);
  assert.equal(state.update.departureValidatedAt.toISOString(), now.toISOString());
  assert.equal(state.markUpdate.decision, 'MANUAL_VALIDATED');
  assert.equal(state.review.action, 'WORKDAY_VALIDATE');
  assert.equal(state.review.metadata.unpaidBreakMinutesDeducted, 60);
  assert.equal(state.review.metadata.workedMinutes, 480);
  assert.equal(state.review.metadata.ordinaryWorkedMinutes, 420);
  assert.equal(state.review.metadata.overtimeMinutes, 60);
  assert.equal(session.punctualityStatus, 'LATE');
});

test('valida un almuerzo iniciado sin fin aplicando la penalización de noventa minutos', async () => {
  const { prisma, state } = fixture({ incompleteBreak: true });
  await reviewAttendanceWorkdaySession(prisma, {
    sessionId: 'session-1',
    action: 'VALIDATE',
    attendanceStatus: 'ON_TIME',
    reason: 'Validación con penalización automática de almuerzo.',
    actorUsername: 'coordinador'
  });
  assert.equal(state.update.workedMinutes, 450);
  assert.equal(state.review.metadata.breakStatus, 'INCOMPLETE');
  assert.equal(state.review.metadata.breakPenaltyMinutes, 90);
  assert.equal(state.review.metadata.overtimeMinutes, 30);
});

test('sin almuerzo conserva todo el tiempo y registra dos horas extra en esta jornada', async () => {
  const { prisma, state } = fixture({ noBreak: true });
  await reviewAttendanceWorkdaySession(prisma, {
    sessionId: 'session-1',
    action: 'VALIDATE',
    attendanceStatus: 'ON_TIME',
    reason: 'El auxiliar no tomó almuerzo.',
    actorUsername: 'coordinador'
  });
  assert.equal(state.update.workedMinutes, 540);
  assert.equal(state.review.metadata.shortBreakMinutesCredited, 60);
  assert.equal(state.review.metadata.overtimeMinutes, 120);
});

test('la validación normal excluye la llegada anticipada', async () => {
  const { prisma, state } = fixture({ earlyArrival: true });
  await reviewAttendanceWorkdaySession(prisma, {
    sessionId: 'session-1',
    action: 'VALIDATE',
    attendanceStatus: 'ON_TIME',
    reason: 'Validación de llegada a tiempo.',
    actorUsername: 'coordinador'
  });
  assert.equal(state.update.workedMinutes, 480);
  assert.equal(state.review.metadata.earlyMinutesExcluded, 30);
  assert.equal(state.review.metadata.recognizeEarlyArrival, false);
});

test('el coordinador puede reconocer la llegada anticipada con auditoría', async () => {
  const { prisma, state } = fixture({ earlyArrival: true });
  await reviewAttendanceWorkdaySession(prisma, {
    sessionId: 'session-1',
    action: 'VALIDATE',
    attendanceStatus: 'ON_TIME',
    recognizeEarlyArrival: true,
    reason: 'Tiempo anticipado autorizado por necesidad operativa.',
    actorUsername: 'coordinador'
  });
  assert.equal(state.update.workedMinutes, 510);
  assert.equal(state.review.metadata.earlyMinutesExcluded, 0);
  assert.equal(state.review.metadata.recognizeEarlyArrival, true);
  assert.equal(state.review.metadata.overtimeMinutes, 90);
});

test('rechaza una puntualidad inválida al validar una jornada cerrada', async () => {
  const { prisma } = fixture();
  await assert.rejects(
    reviewAttendanceWorkdaySession(prisma, {
      sessionId: 'session-1',
      action: 'VALIDATE',
      attendanceStatus: 'UNKNOWN',
      reason: 'Intento de validación con estado inválido.',
      actorUsername: 'dev'
    }),
    /attendance_review_status_invalid/
  );
});

test('reabrir una jornada conserva salida y horas, pero exige revisión', async () => {
  const { prisma, session, state } = fixture();
  session.attendanceStatus = 'COMPLETED';
  session.validationStatus = 'AUTO_VALIDATED';
  session.departureValidatedAt = new Date('2026-07-25T22:00:05.000Z');
  const result = await reviewAttendanceWorkdaySession(prisma, {
    sessionId: 'session-1',
    action: 'REOPEN',
    reason: 'Se debe revisar la hora exacta de salida.',
    actorUsername: 'dev',
    actorRole: 'dev'
  });
  assert.equal(result.attendanceStatus, 'DEPARTURE_REPORTED');
  assert.equal(result.validationStatus, 'REVIEW_REQUIRED');
  assert.equal(result.departureReportedAt.toISOString(), '2026-07-25T22:00:00.000Z');
  assert.equal(result.workedMinutes, 480);
  assert.equal(state.review.action, 'WORKDAY_REOPEN');
});