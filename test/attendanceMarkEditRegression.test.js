import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  enrichAttendanceBoardWithWorkday,
  reviewAttendanceWorkdaySession
} from '../src/modules/dispatch-attendance/application/attendanceAdminWorkday.js';

function fixture() {
  const marks = [
    { id: 'mark-arrival', attendanceSessionId: 'session-test', markType: 'ARRIVAL', clientCapturedAt: new Date('2026-08-09T13:00:00.000Z'), serverReceivedAt: new Date('2026-08-09T13:00:05.000Z'), decision: 'MANUAL_VALIDATED', riskScore: 8, riskFlags: ['TEST_SIGNAL'] },
    { id: 'mark-break-start', attendanceSessionId: 'session-test', markType: 'BREAK_START', clientCapturedAt: new Date('2026-08-09T17:00:00.000Z'), serverReceivedAt: new Date('2026-08-09T17:00:05.000Z'), decision: 'MANUAL_VALIDATED' },
    { id: 'mark-break-end', attendanceSessionId: 'session-test', markType: 'BREAK_END', clientCapturedAt: new Date('2026-08-09T18:00:00.000Z'), serverReceivedAt: new Date('2026-08-09T18:00:05.000Z'), decision: 'MANUAL_VALIDATED' },
    { id: 'mark-departure', attendanceSessionId: 'session-test', markType: 'DEPARTURE', clientCapturedAt: new Date('2026-08-09T22:00:00.000Z'), serverReceivedAt: new Date('2026-08-09T22:00:05.000Z'), decision: 'MANUAL_VALIDATED' }
  ];
  const session = {
    id: 'session-test', assignmentId: 'assignment-test', attendanceStatus: 'COMPLETED', validationStatus: 'MANUAL_VALIDATED', punctualityStatus: 'ON_TIME', riskScore: 8, riskFlags: ['TEST_SIGNAL'],
    expectedStartAt: new Date('2026-08-09T13:00:00.000Z'), expectedEndAt: new Date('2026-08-09T22:00:00.000Z'), arrivalReportedAt: new Date('2026-08-09T13:00:00.000Z'), arrivalValidatedAt: new Date('2026-08-09T13:00:06.000Z'), departureReportedAt: new Date('2026-08-09T22:00:00.000Z'), departureValidatedAt: new Date('2026-08-09T22:00:06.000Z'), workedMinutes: 480, marks, reviews: []
  };
  const assignment = {
    id: 'assignment-test', workerId: 'worker-test', serviceRequestId: 'request-test', worker: { id: 'worker-test', fullName: 'Auxiliar Prueba' },
    serviceRequest: { id: 'request-test', serviceDate: new Date('2026-08-09T00:00:00.000Z'), startTime: '08:00', endTime: '17:00' }, attendanceSession: session
  };
  session.assignment = assignment;
  const state = { deletedMarkIds: [], createdMarks: [], updatedMarks: [], reviews: [] };
  const client = {
    dispatchAssignment: { async findMany() { return [assignment]; } },
    dispatchAttendanceSession: { async findUnique() { return session; }, async update({ data }) { Object.assign(session, data); return { ...session }; } },
    dispatchAttendanceMark: {
      async create({ data }) { const created = { id: `created-${state.createdMarks.length + 1}`, ...data }; state.createdMarks.push(created); session.marks.push(created); return created; },
      async update({ where, data }) { const mark = session.marks.find((item) => item.id === where.id); if (!mark) throw new Error('mock_mark_not_found'); Object.assign(mark, data); state.updatedMarks.push({ id: where.id, ...data }); return { ...mark }; },
      async delete({ where }) { const index = session.marks.findIndex((item) => item.id === where.id); if (index < 0) throw new Error('mock_mark_not_found'); const [deleted] = session.marks.splice(index, 1); state.deletedMarkIds.push(deleted.id); return deleted; }
    },
    dispatchAttendanceReview: { async create({ data }) { const review = { id: `review-${state.reviews.length + 1}`, createdAt: new Date(`2026-08-09T23:${String(state.reviews.length).padStart(2, '0')}:00.000Z`), ...data }; state.reviews.push(data); session.reviews.unshift(review); return review; } }
  };
  return { session, state, prisma: { ...client, async $transaction(callback) { return callback(client); } } };
}

test('al eliminar la entrada el tablero no reutiliza el id de otra marcación ni deja un botón fantasma', async () => {
  const { prisma, session } = fixture();
  await reviewAttendanceWorkdaySession(prisma, { sessionId: session.id, action: 'DELETE_MARK', markType: 'ARRIVAL', markId: 'mark-arrival', actorUsername: 'coordinacion-prueba', actorRole: 'admin', now: new Date('2026-08-09T23:10:00.000Z') });
  const board = await enrichAttendanceBoardWithWorkday(prisma, { rows: [{ assignmentId: 'assignment-test', markId: 'mark-departure', expectedStartAt: '2026-08-09T13:00:00.000Z' }] });
  const [row] = board.rows;
  assert.equal(row.arrivalMarkId, null);
  assert.equal(row.departureMarkId, 'mark-departure');
  assert.deepEqual(row.pendingCorrectionMarkTypes, ['ARRIVAL']);
});

test('coordinación puede editar una marcación existente con justificación y conservar las demás', async () => {
  const { prisma, session, state } = fixture();
  const updated = await reviewAttendanceWorkdaySession(prisma, { sessionId: session.id, action: 'ADD_MARK', markType: 'ARRIVAL', markId: 'mark-arrival', reportedAt: '2026-08-09T08:15', reason: 'Corrección validada contra el reporte operativo.', actorUsername: 'coordinacion-prueba', actorRole: 'admin', now: new Date('2026-08-09T23:15:00.000Z') });
  assert.equal(session.marks.length, 4);
  assert.deepEqual(session.marks.map((mark) => mark.id), ['mark-arrival', 'mark-break-start', 'mark-break-end', 'mark-departure']);
  assert.equal(state.deletedMarkIds.length, 0);
  assert.equal(state.createdMarks.length, 0);
  assert.equal(state.updatedMarks.length, 1);
  assert.equal(session.marks[0].clientCapturedAt.toISOString(), '2026-08-09T13:15:00.000Z');
  assert.equal(session.marks[0].riskScore, 8);
  assert.deepEqual(session.marks[0].riskFlags, ['TEST_SIGNAL']);
  assert.equal(updated.punctualityStatus, 'LATE');
  assert.equal(updated.workedMinutes, 465);
  const review = state.reviews.at(-1);
  assert.equal(review.action, 'WORKDAY_EDIT_MARK');
  assert.equal(review.reason, 'Corrección validada contra el reporte operativo.');
  assert.equal(review.metadata.previousCapturedAt, '2026-08-09T13:00:00.000Z');
  assert.equal(review.metadata.newCapturedAt, '2026-08-09T13:15:00.000Z');
});

test('el backend rechaza una edición de marcación sin justificación', async () => {
  const { prisma, session, state } = fixture();
  await assert.rejects(reviewAttendanceWorkdaySession(prisma, { sessionId: session.id, action: 'ADD_MARK', markType: 'ARRIVAL', markId: 'mark-arrival', reportedAt: '2026-08-09T08:15', actorUsername: 'coordinacion-prueba', actorRole: 'admin', now: new Date('2026-08-09T23:15:00.000Z') }), /attendance_review_reason_required/);
  assert.equal(session.marks[0].clientCapturedAt.toISOString(), '2026-08-09T13:00:00.000Z');
  assert.equal(state.updatedMarks.length, 0);
  assert.equal(state.reviews.length, 0);
});

test('la interfaz ofrece edición con justificación y la proyección no recupera ids genéricos', () => {
  const ui = readFileSync(new URL('../src/public/attendance-admin-clear-marks.js', import.meta.url), 'utf8');
  const workday = readFileSync(new URL('../src/modules/dispatch-attendance/application/attendanceAdminWorkday.js', import.meta.url), 'utf8');
  assert.match(ui, /function editMarkDetails\(/);
  assert.match(ui, /Justificación de la edición/);
  assert.match(ui, /reasonInput\.required = true/);
  assert.match(ui, /reasonInput\.minLength = 5/);
  assert.match(workday, /action: 'WORKDAY_EDIT_MARK'/);
  assert.match(workday, /arrivalMarkId: arrivalMark\?\.id \|\| null/);
  assert.doesNotMatch(workday, /arrivalMark\?\.id \|\| row\.markId/);
});
