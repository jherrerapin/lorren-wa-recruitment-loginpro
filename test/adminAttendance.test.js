import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadAttendanceAdminBoard,
  registerManualAttendance,
  reviewAttendanceSession
} from '../src/modules/dispatch-attendance/application/adminAttendance.js';

function operationPoint(overrides = {}) {
  return {
    id: 'point-1',
    name: 'Bodega principal',
    cityName: 'Bogotá',
    address: 'Calle 25 Sur #51F-35',
    attendanceEnabled: true,
    attendanceLatitude: 4.5951,
    attendanceLongitude: -74.1324,
    geofenceRadiusMeters: 100,
    absenceGraceMinutes: 15,
    manualAttendanceAllowed: true,
    ...overrides
  };
}

function assignment(overrides = {}) {
  return {
    id: 'assignment-1',
    workerId: 'worker-1',
    serviceRequestId: 'request-1',
    status: 'CONFIRMED',
    worker: {
      id: 'worker-1',
      fullName: 'Auxiliar Prueba',
      documentType: 'CC',
      documentNumber: '10000001',
      phone: '3000000000'
    },
    serviceRequest: {
      id: 'request-1',
      serviceDate: new Date('2026-07-23T00:00:00.000Z'),
      startTime: '08:00',
      endTime: '17:00',
      clientName: 'Cliente Prueba',
      operationPointName: 'Bodega principal',
      cityName: 'Bogotá',
      address: 'Calle 25 Sur #51F-35',
      operationPoint: operationPoint()
    },
    attendanceSession: null,
    ...overrides
  };
}

function contract(overrides = {}) {
  const prisma = {
    dispatchAssignment: {
      async findMany() { return []; },
      async findUnique() { return null; }
    },
    dispatchAttendanceSession: {
      async findUnique() { return null; },
      async create({ data }) { return { id: 'session-created', ...data }; },
      async update({ where, data }) { return { id: where.id, ...data }; }
    },
    dispatchAttendanceMark: {
      async findFirst() { return null; },
      async create({ data }) { return { id: 'mark-created', ...data }; },
      async update({ where, data }) { return { id: where.id, ...data }; }
    },
    dispatchAttendanceReview: {
      async create({ data }) { return { id: 'review-created', ...data }; }
    }
  };
  Object.assign(prisma, overrides);
  prisma.$transaction = overrides.$transaction || (async (callback) => callback(prisma));
  return prisma;
}

test('clasifica una llegada riesgosa como pendiente de revisión y expone señales operativas', async () => {
  const prisma = contract();
  prisma.dispatchAssignment.findMany = async () => [assignment({
    attendanceSession: {
      id: 'session-1',
      attendanceStatus: 'ARRIVAL_REPORTED',
      validationStatus: 'REVIEW_REQUIRED',
      punctualityStatus: 'ON_TIME',
      riskScore: 55,
      riskFlags: ['OUTSIDE_GEOFENCE'],
      arrivalReportedAt: new Date('2026-07-23T12:55:00.000Z'),
      marks: [{
        id: 'mark-1',
        serverReceivedAt: new Date('2026-07-23T12:55:00.000Z'),
        latitude: 4.60,
        longitude: -74.14,
        accuracyMeters: 18,
        distanceToPointMeters: 650,
        insideGeofence: false,
        evidenceStorageKey: 'attendance/worker-1/assignment-1/arrival/photo.jpg',
        riskScore: 55,
        riskFlags: ['OUTSIDE_GEOFENCE']
      }],
      reviews: []
    }
  })];

  const board = await loadAttendanceAdminBoard(prisma, {
    from: '2026-07-23',
    to: '2026-07-23',
    now: new Date('2026-07-23T13:00:00.000Z')
  });

  assert.equal(board.rows.length, 1);
  assert.equal(board.rows[0].status, 'REVIEW_REQUIRED');
  assert.equal(board.rows[0].insideGeofence, false);
  assert.equal(board.rows[0].evidenceAvailable, true);
  assert.equal(board.metrics.pendingReview, 1);
});

test('clasifica como no asistencia cuando vence la tolerancia sin llegada', async () => {
  const prisma = contract();
  prisma.dispatchAssignment.findMany = async () => [assignment()];

  const board = await loadAttendanceAdminBoard(prisma, {
    from: '2026-07-23',
    to: '2026-07-23',
    now: new Date('2026-07-23T13:30:00.000Z')
  });

  assert.equal(board.rows[0].status, 'NO_SHOW');
  assert.equal(board.metrics.noShow, 1);
});

test('valida manualmente una llegada y conserva auditoría antes/después', async () => {
  const updates = [];
  const reviews = [];
  const prisma = contract();
  prisma.dispatchAttendanceSession.findUnique = async () => ({
    id: 'session-1',
    assignmentId: 'assignment-1',
    attendanceStatus: 'ARRIVAL_REPORTED',
    validationStatus: 'REVIEW_REQUIRED',
    punctualityStatus: 'ON_TIME',
    arrivalReportedAt: new Date('2026-07-23T12:55:00.000Z'),
    assignment: assignment()
  });
  prisma.dispatchAttendanceSession.update = async ({ where, data }) => {
    updates.push({ where, data });
    return { id: where.id, ...data };
  };
  prisma.dispatchAttendanceMark.findFirst = async () => ({ id: 'mark-1' });
  prisma.dispatchAttendanceMark.update = async ({ where, data }) => ({ id: where.id, ...data });
  prisma.dispatchAttendanceReview.create = async ({ data }) => {
    reviews.push(data);
    return { id: 'review-1', ...data };
  };

  await reviewAttendanceSession(prisma, {
    sessionId: 'session-1',
    action: 'VALIDATE',
    attendanceStatus: 'LATE',
    reason: 'El coordinador confirmó la hora real de ingreso.',
    actorUsername: 'dev',
    actorRole: 'dev',
    now: new Date('2026-07-23T13:10:00.000Z')
  });

  assert.equal(updates[0].data.validationStatus, 'MANUAL_VALIDATED');
  assert.equal(updates[0].data.attendanceStatus, 'LATE');
  assert.equal(reviews[0].previousValidationStatus, 'REVIEW_REQUIRED');
  assert.equal(reviews[0].newValidationStatus, 'MANUAL_VALIDATED');
  assert.equal(reviews[0].actorUsername, 'dev');
});

test('rechaza decisiones sin motivo suficiente', async () => {
  const prisma = contract();
  await assert.rejects(
    reviewAttendanceSession(prisma, {
      sessionId: 'session-1',
      action: 'REJECT',
      reason: 'no',
      actorUsername: 'dev'
    }),
    /attendance_review_reason_too_short/
  );
});

test('registra asistencia manual solo cuando el punto lo permite y crea marca y revisión', async () => {
  const createdMarks = [];
  const createdReviews = [];
  const prisma = contract();
  prisma.dispatchAssignment.findUnique = async () => assignment();
  prisma.dispatchAttendanceSession.create = async ({ data }) => ({ id: 'session-manual', ...data });
  prisma.dispatchAttendanceMark.create = async ({ data }) => {
    createdMarks.push(data);
    return { id: 'mark-manual', ...data };
  };
  prisma.dispatchAttendanceReview.create = async ({ data }) => {
    createdReviews.push(data);
    return { id: 'review-manual', ...data };
  };

  const session = await registerManualAttendance(prisma, {
    assignmentId: 'assignment-1',
    attendanceStatus: 'ON_TIME',
    reason: 'El coordinador verificó presencialmente el ingreso.',
    actorUsername: 'dev',
    actorRole: 'dev',
    now: new Date('2026-07-23T13:00:00.000Z')
  });

  assert.equal(session.validationStatus, 'MANUAL_VALIDATED');
  assert.equal(createdMarks[0].decision, 'MANUAL_VALIDATED');
  assert.match(createdMarks[0].idempotencyKey, /^manual-/);
  assert.equal(createdReviews[0].action, 'MANUAL_MARK');
});

test('bloquea marcación manual cuando la política del punto la deshabilita', async () => {
  const prisma = contract();
  prisma.dispatchAssignment.findUnique = async () => assignment({
    serviceRequest: {
      ...assignment().serviceRequest,
      operationPoint: operationPoint({ manualAttendanceAllowed: false })
    }
  });

  await assert.rejects(
    registerManualAttendance(prisma, {
      assignmentId: 'assignment-1',
      attendanceStatus: 'ON_TIME',
      reason: 'Verificación presencial por coordinador.',
      actorUsername: 'dev'
    }),
    /attendance_manual_not_allowed/
  );
});
