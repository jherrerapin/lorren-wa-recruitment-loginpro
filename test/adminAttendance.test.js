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
    address: 'Dirección de prueba',
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
      documentNumber: 'TEST-0001',
      phone: 'TEST-PHONE'
    },
    serviceRequest: {
      id: 'request-1',
      serviceDate: new Date('2026-07-23T00:00:00.000Z'),
      startTime: '08:00',
      endTime: '17:00',
      clientName: 'Cliente Prueba',
      operationPointName: 'Bodega principal',
      cityName: 'Bogotá',
      address: 'Dirección de prueba',
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

test('el filtro de fechas consulta de forma inclusiva todos los días elegidos', async () => {
  const prisma = contract();
  let receivedWhere = null;
  prisma.dispatchAssignment.findMany = async ({ where }) => {
    receivedWhere = where;
    const candidates = [
      assignment({
        id: 'assignment-before',
        serviceRequest: { ...assignment().serviceRequest, id: 'request-before', serviceDate: new Date('2026-08-07T05:00:00.000Z') }
      }),
      assignment({
        id: 'assignment-from-legacy',
        serviceRequest: { ...assignment().serviceRequest, id: 'request-from-legacy', serviceDate: new Date('2026-08-08T00:00:00.000Z') }
      }),
      assignment({
        id: 'assignment-from-bogota',
        serviceRequest: { ...assignment().serviceRequest, id: 'request-from-bogota', serviceDate: new Date('2026-08-08T05:00:00.000Z') }
      }),
      assignment({
        id: 'assignment-middle',
        serviceRequest: { ...assignment().serviceRequest, id: 'request-middle', serviceDate: new Date('2026-08-09T05:00:00.000Z') }
      }),
      assignment({
        id: 'assignment-to-legacy',
        serviceRequest: { ...assignment().serviceRequest, id: 'request-to-legacy', serviceDate: new Date('2026-08-10T00:00:00.000Z') }
      }),
      assignment({
        id: 'assignment-to-bogota',
        serviceRequest: { ...assignment().serviceRequest, id: 'request-to-bogota', serviceDate: new Date('2026-08-10T05:00:00.000Z') }
      }),
      assignment({
        id: 'assignment-after',
        serviceRequest: { ...assignment().serviceRequest, id: 'request-after', serviceDate: new Date('2026-08-11T00:00:00.000Z') }
      })
    ];
    const { gte, lte } = where.serviceRequest.serviceDate;
    return candidates.filter((item) => item.serviceRequest.serviceDate >= gte && item.serviceRequest.serviceDate <= lte);
  };

  const board = await loadAttendanceAdminBoard(prisma, {
    from: '2026-08-08',
    to: '2026-08-10',
    now: new Date('2026-08-09T15:00:00.000Z')
  });

  assert.equal(receivedWhere.serviceRequest.serviceDate.gte.toISOString(), '2026-08-08T00:00:00.000Z');
  assert.equal(receivedWhere.serviceRequest.serviceDate.lte.toISOString(), '2026-08-10T23:59:59.999Z');
  assert.deepEqual(
    board.rows.map((row) => row.assignmentId),
    ['assignment-from-legacy', 'assignment-from-bogota', 'assignment-middle', 'assignment-to-legacy', 'assignment-to-bogota']
  );
  assert.deepEqual(board.range, { from: '2026-08-08', to: '2026-08-10' });
});

test('el filtro de un solo día usa la fecha operativa y no desplaza registros legacy al día anterior', async () => {
  const prisma = contract();
  let receivedWhere = null;
  prisma.dispatchAssignment.findMany = async ({ where }) => {
    receivedWhere = where;
    return [
      assignment({
        id: 'assignment-previous-legacy',
        serviceRequest: { ...assignment().serviceRequest, id: 'request-previous-legacy', serviceDate: new Date('2026-07-29T00:00:00.000Z') }
      }),
      assignment({
        id: 'assignment-shifted-previous',
        serviceRequest: { ...assignment().serviceRequest, id: 'request-shifted-previous', serviceDate: new Date('2026-07-30T02:00:00.000Z') }
      }),
      assignment({
        id: 'assignment-target-legacy',
        serviceRequest: { ...assignment().serviceRequest, id: 'request-target-legacy', serviceDate: new Date('2026-07-30T00:00:00.000Z') }
      }),
      assignment({
        id: 'assignment-target-bogota',
        serviceRequest: { ...assignment().serviceRequest, id: 'request-target-bogota', serviceDate: new Date('2026-07-30T05:00:00.000Z') }
      }),
      assignment({
        id: 'assignment-next-legacy',
        serviceRequest: { ...assignment().serviceRequest, id: 'request-next-legacy', serviceDate: new Date('2026-07-31T00:00:00.000Z') }
      })
    ];
  };

  const board = await loadAttendanceAdminBoard(prisma, {
    from: '2026-07-30',
    to: '2026-07-30',
    now: new Date('2026-07-30T17:00:00.000Z')
  });

  assert.equal(receivedWhere.serviceRequest.serviceDate.gte.toISOString(), '2026-07-30T00:00:00.000Z');
  assert.equal(receivedWhere.serviceRequest.serviceDate.lte.toISOString(), '2026-07-30T23:59:59.999Z');
  assert.deepEqual(
    board.rows.map((row) => row.assignmentId).sort(),
    ['assignment-target-bogota', 'assignment-target-legacy']
  );
  assert.deepEqual(board.rows.map((row) => row.serviceDateIso), ['2026-07-30', '2026-07-30']);
  board.rows.forEach((row) => {
    assert.match(row.serviceDateLabel, /30.*jul.*2026/i);
    assert.doesNotMatch(row.serviceDateLabel, /29/);
  });
  assert.equal(board.metrics.total, 2);
  assert.deepEqual(board.range, { from: '2026-07-30', to: '2026-07-30' });
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

test('registra una jornada manual completa con entrada, salida, puntualidad y auditoría', async () => {
  const createdMarks = [];
  const createdReviews = [];
  const prisma = contract();
  prisma.dispatchAssignment.findUnique = async () => assignment();
  prisma.dispatchAttendanceSession.create = async ({ data }) => ({ id: 'session-workday-manual', ...data });
  prisma.dispatchAttendanceMark.create = async ({ data }) => {
    createdMarks.push(data);
    return { id: `mark-${createdMarks.length}`, ...data };
  };
  prisma.dispatchAttendanceReview.create = async ({ data }) => {
    createdReviews.push(data);
    return { id: 'review-workday-manual', ...data };
  };

  const session = await registerManualAttendance(prisma, {
    assignmentId: 'assignment-1',
    arrivalReportedAt: '2026-07-23T08:15',
    departureReportedAt: '2026-07-23T16:15',
    reason: 'Registro manual de jornada verificado por coordinación.',
    actorUsername: 'operaciones-prueba',
    actorRole: 'admin',
    now: new Date('2026-07-23T22:00:00.000Z')
  });

  assert.equal(session.attendanceStatus, 'COMPLETED');
  assert.equal(session.validationStatus, 'MANUAL_VALIDATED');
  assert.equal(session.punctualityStatus, 'LATE');
  assert.equal(session.arrivalReportedAt.toISOString(), '2026-07-23T13:15:00.000Z');
  assert.equal(session.departureReportedAt.toISOString(), '2026-07-23T21:15:00.000Z');
  assert.equal(session.workedMinutes, 480);
  assert.deepEqual(createdMarks.map((mark) => mark.markType), ['ARRIVAL', 'DEPARTURE']);
  assert.equal(createdMarks[0].clientCapturedAt.toISOString(), session.arrivalReportedAt.toISOString());
  assert.equal(createdMarks[1].clientCapturedAt.toISOString(), session.departureReportedAt.toISOString());
  assert.equal(createdReviews[0].action, 'MANUAL_WORKDAY');
  assert.equal(createdReviews[0].metadata.workedMinutes, 480);
  assert.equal(createdReviews[0].metadata.punctualityStatus, 'LATE');
});

test('rechaza una jornada manual cuya salida sea anterior a la entrada', async () => {
  const prisma = contract();
  prisma.dispatchAssignment.findUnique = async () => assignment();

  await assert.rejects(
    registerManualAttendance(prisma, {
      assignmentId: 'assignment-1',
      arrivalReportedAt: '2026-07-23T16:00',
      departureReportedAt: '2026-07-23T08:00',
      reason: 'Corrección manual de jornada solicitada por coordinación.',
      actorUsername: 'operaciones-prueba'
    }),
    /attendance_work_departure_before_arrival/
  );
});

test('acepta una jornada manual que cruza medianoche cuando la salida usa el día siguiente', async () => {
  const prisma = contract();
  prisma.dispatchAssignment.findUnique = async () => assignment({
    serviceRequest: {
      ...assignment().serviceRequest,
      startTime: '22:00',
      endTime: '06:00'
    }
  });
  prisma.dispatchAttendanceSession.create = async ({ data }) => ({ id: 'session-overnight-manual', ...data });

  const session = await registerManualAttendance(prisma, {
    assignmentId: 'assignment-1',
    arrivalReportedAt: '2026-07-23T22:00',
    departureReportedAt: '2026-07-24T06:00',
    reason: 'Jornada nocturna registrada manualmente por coordinación.',
    actorUsername: 'operaciones-prueba',
    now: new Date('2026-07-24T12:00:00.000Z')
  });

  assert.equal(session.punctualityStatus, 'ON_TIME');
  assert.equal(session.workedMinutes, 480);
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
