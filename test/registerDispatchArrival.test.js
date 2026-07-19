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
    transactionOptions: [],
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
    lateToleranceMinutes: 10,
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
    ? {
        id: 'device-1',
        workerId: 'worker-1',
        installationIdHash: 'installation-1',
        status: 'ACTIVE',
        authorizedFrom: new Date('2026-01-01T00:00:00.000Z'),
        authorizedUntil: null,
        revokedAt: null
      }
    : overrides.device;

  function cloneAssignment() {
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
        return where.id === assignment.id ? cloneAssignment() : null;
      }
    },
    dispatchAttendanceSession: {
      async create({ data }) {
        state.sessionCreates += 1;
        if (state.sessions.has(data.assignmentId)) {
          const error = new Error('unique');
          error.code = 'P2002';
          throw error;
        }
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
        if (state.marks.has(data.idempotencyKey)) {
          const error = new Error('unique');
          error.code = 'P2002';
          throw error;
        }
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
      async count() {
        return overrides.sharedDeviceCount || 0;
      }
    }
  };

  client.$transaction = async (callback, options) => {
    state.transactionCalls += 1;
    state.transactionOptions.push(options);
    const failure = state.transactionFailures.shift();
    if (failure) {
      if (typeof failure.beforeThrow === 'function') failure.beforeThrow({ state, client });
      const error = new Error(failure.code);
      error.code = failure.code;
      throw error;
    }
    return callback(client);
  };

  return { prisma: client, state };
}

function trustedInput(overrides = {}) {
  return {
    assignmentId: 'assignment-1',
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

test('auto-valida una llegada confiable y persiste todo en una transacción serializable', async () => {
  const { prisma, state } = createFixture();
  const result = await registerDispatchArrival(prisma, trustedInput());

  assert.equal(result.recorded, true);
  assert.equal(result.replayed, false);
  assert.equal(result.validation.validationStatus, 'AUTO_VALIDATED');
  assert.equal(result.validation.attendanceStatus, 'ON_TIME');
  assert.equal(result.attendanceSession.arrivalValidatedAt.toISOString(), '2026-07-19T13:00:00.000Z');
  assert.equal(state.sessionCreates, 1);
  assert.equal(state.sessionUpdates, 1);
  assert.equal(state.markCreates, 1);
  assert.equal(state.transactionCalls, 1);
  assert.deepEqual(state.transactionOptions[0], { isolationLevel: 'Serializable' });
});

test('un dispositivo nuevo registra llegada provisional y exige revisión', async () => {
  const { prisma, state } = createFixture({ device: null });
  const result = await registerDispatchArrival(prisma, trustedInput());

  assert.equal(result.recorded, true);
  assert.equal(result.validation.validationStatus, 'REVIEW_REQUIRED');
  assert.equal(result.validation.attendanceStatus, 'ARRIVAL_REPORTED');
  assert.ok(result.validation.riskFlags.includes(ATTENDANCE_RISK_FLAG.UNAUTHORIZED_DEVICE));
  assert.equal(result.attendanceSession.arrivalValidatedAt, null);
  assert.equal(state.markCreates, 1);
});

test('repetir la misma idempotencyKey devuelve el resultado existente sin nuevas escrituras', async () => {
  const { prisma, state } = createFixture();
  await registerDispatchArrival(prisma, trustedInput());
  const replay = await registerDispatchArrival(prisma, trustedInput());

  assert.equal(replay.recorded, true);
  assert.equal(replay.replayed, true);
  assert.equal(state.sessionCreates, 1);
  assert.equal(state.sessionUpdates, 1);
  assert.equal(state.markCreates, 1);
});

test('una segunda clave después de la llegada no crea otra marcación', async () => {
  const { prisma, state } = createFixture();
  await registerDispatchArrival(prisma, trustedInput());
  const duplicate = await registerDispatchArrival(
    prisma,
    trustedInput({ idempotencyKey: 'arrival-2' })
  );

  assert.equal(duplicate.recorded, false);
  assert.equal(duplicate.validation.validationStatus, 'REJECTED');
  assert.deepEqual(duplicate.validation.riskFlags, [ATTENDANCE_RISK_FLAG.DUPLICATE_ARRIVAL]);
  assert.equal(state.markCreates, 1);
  assert.equal(state.sessionUpdates, 1);
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
  assert.equal(state.sessionCreates, 0);
  assert.equal(state.markCreates, 0);
});

test('reintenta conflictos P2034 con un límite y luego registra', async () => {
  const { prisma, state } = createFixture({ transactionFailures: [{ code: 'P2034' }] });
  const result = await registerDispatchArrival(prisma, trustedInput());

  assert.equal(result.recorded, true);
  assert.equal(state.transactionCalls, 2);
  assert.equal(state.markCreates, 1);
});

test('recupera el ganador concurrente cuando termina en P2002 de idempotencia', async () => {
  const fixture = createFixture({
    transactionFailures: [
      { code: 'P2002' },
      { code: 'P2002' },
      {
        code: 'P2002',
        beforeThrow({ state }) {
          const session = {
            id: 'session-winner',
            assignmentId: 'assignment-1',
            expectedStartAt: new Date('2026-07-19T13:00:00.000Z'),
            attendanceStatus: 'ON_TIME',
            validationStatus: 'AUTO_VALIDATED',
            punctualityStatus: 'ON_TIME',
            riskScore: 0,
            riskFlags: []
          };
          state.sessions.set('assignment-1', session);
          state.marks.set('arrival-1', {
            id: 'mark-winner',
            attendanceSessionId: session.id,
            idempotencyKey: 'arrival-1',
            decision: 'AUTO_VALIDATED',
            riskScore: 0,
            riskFlags: []
          });
        }
      }
    ]
  });

  const result = await registerDispatchArrival(fixture.prisma, trustedInput());
  assert.equal(result.replayed, true);
  assert.equal(result.attendanceMark.id, 'mark-winner');
  assert.equal(fixture.state.transactionCalls, 3);
});

test('documenta los estados activos vigentes del tablero de asignaciones', () => {
  assert.deepEqual(ACTIVE_DISPATCH_ASSIGNMENT_STATUSES, [
    'ASSIGNED',
    'CONFIRMATION_PENDING',
    'CONFIRMED'
  ]);
});
