import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewAttendanceWorkdaySession } from '../src/modules/dispatch-attendance/application/attendanceAdminWorkday.js';

function fixture() {
  const session = {
    id: 'session-1',
    assignmentId: 'assignment-1',
    attendanceStatus: 'DEPARTURE_REPORTED',
    validationStatus: 'REVIEW_REQUIRED',
    punctualityStatus: 'ON_TIME',
    arrivalReportedAt: new Date('2026-07-25T13:00:00.000Z'),
    arrivalValidatedAt: new Date('2026-07-25T13:00:05.000Z'),
    departureReportedAt: new Date('2026-07-25T22:00:00.000Z'),
    departureValidatedAt: null,
    workedMinutes: 480,
    assignment: {
      id: 'assignment-1', workerId: 'worker-1', serviceRequestId: 'request-1',
      worker: { fullName: 'Auxiliar Prueba' }, serviceRequest: { id: 'request-1' }
    }
  };
  const state = { update: null, markUpdate: null, review: null };
  const client = {
    dispatchAttendanceSession: {
      async findUnique() { return session; },
      async update({ data }) { Object.assign(session, data); state.update = { ...data }; return { ...session }; }
    },
    dispatchAttendanceMark: {
      async findFirst() { return { id: 'departure-mark-1' }; },
      async update({ data }) { state.markUpdate = data; return { id: 'departure-mark-1', ...data }; }
    },
    dispatchAttendanceReview: {
      async create({ data }) { state.review = data; return { id: 'review-1', ...data }; }
    }
  };
  const prisma = {
    ...client,
    async $transaction(callback) { return callback(client); }
  };
  return { prisma, session, state };
}

test('validar una salida conserva COMPLETED y las horas netas', async () => {
  const { prisma, session, state } = fixture();
  const now = new Date('2026-07-25T22:10:00.000Z');
  const result = await reviewAttendanceWorkdaySession(prisma, {
    sessionId: 'session-1', action: 'VALIDATE', attendanceStatus: 'ON_TIME',
    reason: 'Coordinador confirmó la salida y la evidencia.',
    actorUsername: 'dev', actorRole: 'dev', now
  });
  assert.equal(result.attendanceStatus, 'COMPLETED');
  assert.equal(result.validationStatus, 'MANUAL_VALIDATED');
  assert.equal(result.workedMinutes, 480);
  assert.equal(state.update.departureValidatedAt.toISOString(), now.toISOString());
  assert.equal(state.markUpdate.decision, 'MANUAL_VALIDATED');
  assert.equal(state.review.action, 'WORKDAY_VALIDATE');
  assert.equal(state.review.metadata.workedMinutes, 480);
  assert.equal(session.punctualityStatus, 'ON_TIME');
});

test('reabrir una jornada conserva salida y horas, pero exige revisión', async () => {
  const { prisma, session, state } = fixture();
  session.attendanceStatus = 'COMPLETED';
  session.validationStatus = 'AUTO_VALIDATED';
  session.departureValidatedAt = new Date('2026-07-25T22:00:05.000Z');
  const result = await reviewAttendanceWorkdaySession(prisma, {
    sessionId: 'session-1', action: 'REOPEN',
    reason: 'Se debe revisar la hora exacta de salida.',
    actorUsername: 'dev', actorRole: 'dev'
  });
  assert.equal(result.attendanceStatus, 'DEPARTURE_REPORTED');
  assert.equal(result.validationStatus, 'REVIEW_REQUIRED');
  assert.equal(result.departureReportedAt.toISOString(), '2026-07-25T22:00:00.000Z');
  assert.equal(result.workedMinutes, 480);
  assert.equal(state.review.action, 'WORKDAY_REOPEN');
});
