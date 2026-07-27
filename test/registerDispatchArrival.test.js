import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_DISPATCH_ASSIGNMENT_STATUSES,
  ATTENDANCE_RISK_FLAG,
  registerDispatchArrival
} from '../src/modules/dispatch-attendance/application/registerArrival.js';
import {
  calculateAttendanceDistanceMeters,
  isAttendanceInsideGeofence
} from '../src/modules/dispatch-attendance/domain/attendanceDistance.js';

function createFixture(overrides = {}) {
  const state = {
    transactionCalls: 0,
    sessionCreates: 0,
    sessionUpdates: 0,
    markCreates: 0,
    sessions: new Map(),
    marks: new Map(),
    transactionFailures: [...(overrides.transactionFailures || [])]
  };
  const operationPoint = {
    attendanceEnabled: true,
    attendanceLatitude: 4.711,
    attendanceLongitude: -74.0721,
    geofenceRadiusMeters: 200,
    maxLocationAccuracyMeters: 100,
    attendanceTimezone: 'America/Bogota',
    ...overrides.operationPoint
  };
  const assignment = {
    id: 'assignment-1',
    workerId: 'worker-1',
    status: 'CONFIRMED',
    attendanceSession: null,
    serviceRequest: {
      serviceDate: new Date('2026-07-19T00:00:00.000Z'),
      startTime: '08:00',
      endTime: '17:00',
      operationPoint,
      ...overrides.serviceRequest
    },
    ...overrides.assignment
  };
  const device = overrides.device === undefined
    ? { id: 'device-1', workerId: 'worker-1', installationIdHash: 'installation-1' }
    : overrides.device;

  function currentAssignment() {
    return {
      ...assignment,
      attendanceSession: state.sessions.get(assignment.id) || assignment.attendanceSession || null,
      serviceRequest: {
        ...assignment.serviceRequest,
        operationPoint: assignment.serviceRequest.operationPoint
      }
    };
  }

  const client = {
    dispatchAssignment: {
      async findUnique({ where }) {
        return where.id === assignment.id ? currentAssignment() : null;
      }
    },
    dispatchAttendanceSession: {
      async create({ data }) {
        state.sessionCreates += 1;
        const session = {
          id: `session-${state.sessionCreates}`,
          ...data,
          arrivalReportedAt: null,
          arrivalValidatedAt: null,
          riskScore: 0,
          riskFlags: null
        };
        state.sessions.set(data.assignmentId, session);
        return session;
      },
      async update({ where, data }) {
        state.sessionUpdates += 1;
        const session = [...state.sessions.values()].find((item) => item.id === where.id);
        assert.ok(session, 'session missing');
        Object.assign(session, data);
        return { ...session };
      }
    },
    dispatchAttendanceMark: {
      async findUnique({ where, include }) {
        const mark = state.marks.get(where.idempotencyKey) || null;
        if (!mark) return null;
        return include?.attendanceSession
          ? {
              ...mark,
              attendanceSession: [...state.sessions.values()].find(
                (item) => item.id === mark.attendanceSessionId
              ) || null
            }
          : { ...mark };
      },
      async create({ data }) {
        state.markCreates += 1;
        const mark = { id: `mark-${state.markCreates}`, ...data };
        state.marks.set(data.idempotencyKey, mark);
        return { ...mark };
      }
    },
    dispatchWorkerDevice: {
      async findFirst({ where }) {
        if (!device) return null;
        return device.workerId === where.workerId
          && device.installationIdHash === where.installationIdHash
          ? { ...device }
          : null;
      },
      async count() { return overrides.sharedDeviceCount || 0; }
    }
  };
  client.$transaction = async (callback, options) => {
    assert.deepEqual(options, { isolationLevel: 'Serializable' });
    state.transactionCalls += 1;
    const failure = state.transactionFailures.shift();
    if (failure) {
      const error = new Error(failure);
      error.code = failure;
      throw error;
    }
    return callback(client);
  };
  return { prisma: client, state };
}

function trustedInput(overrides = {}) {
  return {
    assignmentId: 'assignment-1',
    expectedWorkerId: 'worker-1',
    idempotencyKey: 'arrival-1',
    now: new Date('2026-07-19T13:00:00.000Z'),
    clientCapturedAt: new Date('2026-07-19T12:59:58.000Z'),
    latitude: 4.7111,
    longitude: -74.072,
    accuracyMeters: 15,
    installationIdHash: 'installation-1',
    persistentStorageAvailable: true,
    ...overrides
  };
}

test('calcula distancia y geocerca sin depender de Prisma', () => {
  const distance = calculateAttendanceDistanceMeters(
    { latitude: 4.711, longitude: -74.0721 },
    { latitude: 4.7111, longitude: -74.072 }
  );
  assert.ok(distance > 0 && distance < 20);
  assert.equal(isAttendanceInsideGeofence(distance, 200), true);
  assert.equal(calculateAttendanceDistanceMeters({}, {}), null);
});

test('conserva el catálogo de asignaciones activas', () => {
  assert.deepEqual(ACTIVE_DISPATCH_ASSIGNMENT_STATUSES, [
    'ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'
  ]);
});

test('auto-valida una llegada confiable en transacción serializable', async () => {
  const { prisma, state } = createFixture();
  const result = await registerDispatchArrival(prisma, trustedInput());
  assert.equal(result.recorded, true);
  assert.equal(result.validation.validationStatus, 'AUTO_VALIDATED');
  assert.equal(result.validation.attendanceStatus, 'ON_TIME');
  assert.equal(state.sessionCreates, 1);
  assert.equal(state.sessionUpdates, 1);
  assert.equal(state.markCreates, 1);
});

test('registra una entrada anticipada con su hora real', async () => {
  const { prisma } = createFixture();
  const arrivalAt = new Date('2026-07-19T12:15:00.000Z');
  const result = await registerDispatchArrival(prisma, trustedInput({
    now: arrivalAt,
    clientCapturedAt: arrivalAt
  }));
  assert.equal(result.recorded, true);
  assert.equal(result.attendanceSession.arrivalReportedAt.toISOString(), arrivalAt.toISOString());
  assert.equal(result.attendanceSession.expectedStartAt.toISOString(), '2026-07-19T13:00:00.000Z');
});

test('registra una llegada tarde sin bloquearla', async () => {
  const { prisma } = createFixture();
  const lateAt = new Date('2026-07-19T15:00:00.000Z');
  const result = await registerDispatchArrival(prisma, trustedInput({
    now: lateAt,
    clientCapturedAt: lateAt
  }));
  assert.equal(result.recorded, true);
  assert.equal(result.validation.reportedPunctuality, 'LATE');
});

test('sincroniza una llegada offline tardía y la deja en revisión', async () => {
  const { prisma } = createFixture();
  const capturedAt = new Date('2026-07-19T15:00:00.000Z');
  const receivedAt = new Date('2026-07-19T16:00:00.000Z');
  const result = await registerDispatchArrival(prisma, trustedInput({
    idempotencyKey: 'offline-arrival-1',
    captureMode: 'OFFLINE_WEB',
    clientCapturedAt: capturedAt,
    now: receivedAt
  }));
  assert.equal(result.recorded, true);
  assert.equal(result.validation.validationStatus, 'REVIEW_REQUIRED');
  assert.equal(result.validation.reportedPunctuality, 'LATE');
  assert.ok(result.validation.riskFlags.includes(ATTENDANCE_RISK_FLAG.OFFLINE_WEB_CAPTURE));
  assert.equal(result.attendanceSession.arrivalReportedAt.toISOString(), capturedAt.toISOString());
});

test('rechaza una captura offline de más de 72 horas', async () => {
  const { prisma } = createFixture();
  await assert.rejects(
    registerDispatchArrival(prisma, trustedInput({
      captureMode: 'OFFLINE_WEB',
      clientCapturedAt: new Date('2026-07-19T13:00:00.000Z'),
      now: new Date('2026-07-22T13:00:01.000Z')
    })),
    /attendance_offline_capture_expired/
  );
});

test('un dispositivo nuevo registra llegada provisional y exige revisión', async () => {
  const { prisma } = createFixture({ device: null });
  const result = await registerDispatchArrival(prisma, trustedInput());
  assert.equal(result.recorded, true);
  assert.equal(result.validation.validationStatus, 'REVIEW_REQUIRED');
  assert.ok(result.validation.riskFlags.includes(ATTENDANCE_RISK_FLAG.UNAUTHORIZED_DEVICE));
});

test('repetir la misma idempotencia no duplica la llegada', async () => {
  const { prisma, state } = createFixture();
  await registerDispatchArrival(prisma, trustedInput());
  const replay = await registerDispatchArrival(prisma, trustedInput());
  assert.equal(replay.replayed, true);
  assert.equal(state.markCreates, 1);
});

test('una segunda clave después de la llegada queda rechazada', async () => {
  const { prisma, state } = createFixture();
  await registerDispatchArrival(prisma, trustedInput());
  const duplicate = await registerDispatchArrival(
    prisma,
    trustedInput({ idempotencyKey: 'arrival-2' })
  );
  assert.equal(duplicate.recorded, false);
  assert.deepEqual(duplicate.validation.riskFlags, [ATTENDANCE_RISK_FLAG.DUPLICATE_ARRIVAL]);
  assert.equal(state.markCreates, 1);
});

test('un punto deshabilitado no crea sesión ni marcación', async () => {
  const { prisma, state } = createFixture({ operationPoint: { attendanceEnabled: false } });
  const result = await registerDispatchArrival(prisma, trustedInput());
  assert.equal(result.recorded, false);
  assert.deepEqual(result.validation.riskFlags, [ATTENDANCE_RISK_FLAG.ATTENDANCE_NOT_ENABLED]);
  assert.equal(state.sessionCreates, 0);
  assert.equal(state.markCreates, 0);
});

test('una asignación inactiva no crea efectos secundarios', async () => {
  const { prisma, state } = createFixture({ assignment: { status: 'CANCELLED' } });
  const result = await registerDispatchArrival(prisma, trustedInput());
  assert.equal(result.recorded, false);
  assert.deepEqual(result.validation.riskFlags, [ATTENDANCE_RISK_FLAG.ASSIGNMENT_NOT_ACTIVE]);
  assert.equal(state.markCreates, 0);
});

test('rechaza una asignación perteneciente a otro auxiliar', async () => {
  const { prisma } = createFixture({ assignment: { workerId: 'worker-2' } });
  await assert.rejects(
    () => registerDispatchArrival(prisma, trustedInput()),
    /attendance_assignment_not_found/
  );
});

test('reintenta un conflicto serializable antes de registrar', async () => {
  const { prisma, state } = createFixture({ transactionFailures: ['P2034'] });
  const result = await registerDispatchArrival(prisma, trustedInput());
  assert.equal(result.recorded, true);
  assert.equal(state.transactionCalls, 2);
});
