import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAttendanceAdminBoard } from '../src/modules/dispatch-attendance/application/adminAttendance.js';

function adminPrismaWithAssignments(assignments, capture) {
  return {
    dispatchAssignment: {
      findMany: async (args) => {
        capture.where = args.where;
        return assignments;
      },
      findUnique: async () => null
    },
    dispatchAttendanceSession: {
      findUnique: async () => null,
      create: async () => null,
      update: async () => null
    },
    dispatchAttendanceMark: {
      findFirst: async () => null,
      create: async () => null,
      update: async () => null
    },
    dispatchAttendanceReview: {
      create: async () => null
    },
    $transaction: async (callback) => callback?.({})
  };
}

test('Asistencia operativa conserva una sesión histórica aunque la asignación ya no esté activa', async () => {
  const capture = {};
  const historicalAssignment = {
    id: 'assignment-pseudo-history',
    status: 'CANCELLED',
    worker: {
      fullName: 'Auxiliar Histórico',
      documentType: 'DOC',
      documentNumber: 'PSEUDO-001',
      phone: null,
      operationalStatus: 'DISABLED'
    },
    serviceRequest: {
      serviceDate: new Date('2026-08-20T00:00:00.000Z'),
      startTime: null,
      endTime: null,
      clientName: 'Cliente de prueba',
      operationPointName: 'Operación de prueba',
      cityName: 'Ciudad de prueba',
      address: null,
      operationPoint: {}
    },
    attendanceSession: {
      id: 'session-pseudo-history',
      expectedStartAt: null,
      expectedEndAt: null,
      arrivalReportedAt: new Date('2026-08-20T10:00:00.000Z'),
      attendanceStatus: 'COMPLETED',
      validationStatus: 'MANUAL_VALIDATED',
      punctualityStatus: 'ON_TIME',
      riskScore: 0,
      riskFlags: [],
      marks: [],
      reviews: []
    }
  };

  const board = await loadAttendanceAdminBoard(
    adminPrismaWithAssignments([historicalAssignment], capture),
    {
      from: '2026-08-20',
      to: '2026-08-20',
      q: 'Auxiliar Histórico',
      now: new Date('2026-08-27T14:00:00.000Z')
    }
  );

  assert.deepEqual(capture.where.OR, [
    { status: { in: ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'] } },
    { attendanceSession: { isNot: null } }
  ]);
  assert.deepEqual(capture.where.serviceRequest, {
    serviceDate: {
      gte: new Date('2026-08-20T00:00:00.000Z'),
      lte: new Date('2026-08-20T23:59:59.999Z')
    }
  });

  assert.equal(board.rows.length, 1);
  assert.equal(board.rows[0].workerName, 'Auxiliar Histórico');
  assert.equal(board.rows[0].sessionId, 'session-pseudo-history');
  assert.equal(board.rows[0].validationStatus, 'MANUAL_VALIDATED');
  assert.equal(board.metrics.total, 1);
});
