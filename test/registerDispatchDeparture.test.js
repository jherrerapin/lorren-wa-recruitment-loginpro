import test from 'node:test';
import assert from 'node:assert/strict';
import { registerDispatchDeparture } from '../src/modules/dispatch-attendance/application/registerDeparture.js';

function createFixture(overrides = {}) {
  const session = {
    id: 'session-1',
    assignmentId: 'assignment-1',
    expectedStartAt: new Date('2026-07-25T13:00:00.000Z'),
    expectedEndAt: new Date('2026-07-25T22:00:00.000Z'),
    attendanceStatus: 'ON_TIME',
    validationStatus: 'AUTO_VALIDATED',
    punctualityStatus: 'ON_TIME',
    arrivalReportedAt: new Date('2026-07-25T13:00:00.000Z'),
    departureReportedAt: null,
    riskScore: 0,
    riskFlags: [],
    workedMinutes: null,
    ...overrides.session
  };
  const assignment = {
    id: 'assignment-1',
    workerId: 'worker-1',
    serviceRequestId: 'request-1',
    status: 'CONFIRMED',
    attendanceSession: session,
    serviceRequest: {
      serviceDate: new Date('2026-07-25T00:00:00.000Z'),
      startTime: '08:00',
      endTime: '17:00',
      operationPoint: {
        attendanceEnabled: true,
        attendanceLatitude: 4.711,
        attendanceLongitude: -74.072,
        geofenceRadiusMeters: 150,
        maxLocationAccuracyMeters: 50
      },
      ...overrides.serviceRequest
    }
  };
  const existingBreakMarks = overrides.breakMarks === undefined
    ? [
        { markType: 'BREAK_START', clientCapturedAt: new Date('2026-07-25T17:00:00.000Z'), serverReceivedAt: new Date('2026-07-25T17:00:00.000Z') },
        { markType: 'BREAK_END', clientCapturedAt: new Date('2026-07-25T18:00:00.000Z'), serverReceivedAt: new Date('2026-07-25T18:00:00.000Z') }
      ]
    : overrides.breakMarks;
  const marks = new Map();
  const state = { updated: null, createdMark: null };
  const client = {
    dispatchAssignment: {
      async findUnique({ where }) { return where.id === assignment.id ? assignment : null; }
    },
    dispatchAttendanceSession: {
      async update({ data }) {
        Object.assign(session, data);
        state.updated = { ...session };
        return { ...session };
      }
    },
    dispatchAttendanceMark: {
      async findUnique({ where, include }) {
        const mark = marks.get(where.idempotencyKey) || null;
        return mark && include?.attendanceSession ? { ...mark, attendanceSession: session } : mark;
      },
      async findMany() { return existingBreakMarks; },
      async create({ data }) {
        const mark = { id: 'departure-mark-1', ...data };
        marks.set(data.idempotencyKey, mark);
        state.createdMark = mark;
        return mark;
      }
    },
    dispatchWorkerDevice: {
      async findFirst() { return { id: 'device-1' }; },
      async count() { return 0; }
    }
  };
  const prisma = {
    ...client,
    async $transaction(callback, options) {
      assert.equal(options.isolationLevel, 'Serializable');
      return callback(client);
    }
  };
  return { prisma, session, state };
}

function validInput(overrides = {}) {
  return {
    assignmentId: 'assignment-1',
    expectedWorkerId: 'worker-1',
    idempotencyKey: 'departure_test_123456789',
    now: new Date('2026-07-25T22:00:00.000Z'),
    clientCapturedAt: new Date('2026-07-25T22:00:00.000Z'),
    latitude: 4.7111,
    longitude: -74.0721,
    accuracyMeters: 12,
    installationIdHash: 'installation-hash',
    persistentStorageAvailable: true,
    hasFreshPhoto: true,
    evidenceStorageKey: 'attendance/worker-1/assignment-1/departure/departure_test_123456789.jpg',
    evidenceMimeType: 'image/jpeg',
    ...overrides
  };
}

test('registra salida y descuenta solo el almuerzo realmente marcado', async () => {
  const { prisma, state } = createFixture();
  const result = await registerDispatchDeparture(prisma, validInput());
  assert.equal(result.recorded, true);
  assert.equal(result.validation.workedMinutes, 480);
  assert.equal(result.validation.grossWorkedMinutes, 540);
  assert.equal(result.validation.unpaidBreakMinutesDeducted, 60);
  assert.equal(state.updated.departureReportedAt.toISOString(), '2026-07-25T22:00:00.000Z');
  assert.equal(state.updated.workedMinutes, 480);
  assert.equal(state.updated.attendanceStatus, 'COMPLETED');
  assert.equal(state.createdMark.markType, 'DEPARTURE');
});

test('sin almuerzo marcado contabiliza todo el tiempo efectivo', async () => {
  const { prisma } = createFixture({ breakMarks: [] });
  const result = await registerDispatchDeparture(prisma, validInput());
  assert.equal(result.validation.unpaidBreakMinutesDeducted, 0);
  assert.equal(result.validation.workedMinutes, 540);
});

test('permite una salida antes del final programado', async () => {
  const { prisma } = createFixture({ breakMarks: [] });
  const result = await registerDispatchDeparture(prisma, validInput({
    now: new Date('2026-07-25T20:00:00.000Z'),
    clientCapturedAt: new Date('2026-07-25T20:00:00.000Z')
  }));
  assert.equal(result.recorded, true);
  assert.equal(result.validation.workedMinutes, 420);
});

test('una salida offline conserva horas pero exige revisión', async () => {
  const { prisma } = createFixture();
  const result = await registerDispatchDeparture(prisma, validInput({
    captureMode: 'OFFLINE_WEB',
    now: new Date('2026-07-25T22:30:00.000Z'),
    clientCapturedAt: new Date('2026-07-25T22:00:00.000Z')
  }));
  assert.equal(result.validation.validationStatus, 'REVIEW_REQUIRED');
  assert.ok(result.validation.riskFlags.includes('OFFLINE_WEB_CAPTURE'));
  assert.equal(result.validation.workedMinutes, 480);
});

test('rechaza salida cuando no existe llegada', async () => {
  const { prisma } = createFixture({ session: { arrivalReportedAt: null } });
  await assert.rejects(
    () => registerDispatchDeparture(prisma, validInput()),
    /attendance_departure_arrival_required/
  );
});

test('exige finalizar un almuerzo abierto antes de salir', async () => {
  const { prisma } = createFixture({
    breakMarks: [{
      markType: 'BREAK_START',
      clientCapturedAt: new Date('2026-07-25T17:00:00.000Z'),
      serverReceivedAt: new Date('2026-07-25T17:00:00.000Z')
    }]
  });
  await assert.rejects(
    () => registerDispatchDeparture(prisma, validInput()),
    /attendance_departure_break_end_required/
  );
});

test('rechaza una segunda salida', async () => {
  const { prisma } = createFixture({
    session: { departureReportedAt: new Date('2026-07-25T22:00:00.000Z') }
  });
  await assert.rejects(
    () => registerDispatchDeparture(prisma, validInput()),
    /attendance_departure_already_registered/
  );
});

test('reproduce el resultado de la misma idempotencia sin duplicar', async () => {
  const { prisma, state } = createFixture();
  const input = validInput();
  const first = await registerDispatchDeparture(prisma, input);
  const second = await registerDispatchDeparture(prisma, input);
  assert.equal(first.recorded, true);
  assert.equal(second.replayed, true);
  assert.equal(state.createdMark.idempotencyKey, input.idempotencyKey);
});
