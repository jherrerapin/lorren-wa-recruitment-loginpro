import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDispatchAttendanceExpectedWindow,
  getDispatchArrivalWindowState,
  registerDispatchArrival
} from '../src/modules/dispatch-attendance/application/registerArrival.js';

function assignmentFixture(overrides = {}) {
  return {
    id: 'assignment-1',
    workerId: 'worker-1',
    status: 'CONFIRMED',
    attendanceSession: null,
    serviceRequest: {
      serviceDate: new Date('2026-07-22T00:00:00.000Z'),
      startTime: '08:00',
      endTime: '17:00',
      operationPoint: {
        attendanceEnabled: true,
        attendanceLatitude: 4.711,
        attendanceLongitude: -74.072,
        geofenceRadiusMeters: 100,
        maxLocationAccuracyMeters: 50
      }
    },
    ...overrides
  };
}

function successfulPrisma(assignment) {
  let session = null;
  const client = {
    dispatchAssignment: { async findUnique() { return assignment; } },
    dispatchAttendanceSession: {
      async create({ data }) { session = { id: 'session-1', ...data }; return session; },
      async update({ data }) { session = { ...session, ...data }; return session; }
    },
    dispatchAttendanceMark: {
      async findUnique() { return null; },
      async create({ data }) { return { id: 'mark-1', ...data }; }
    },
    dispatchWorkerDevice: {
      async findFirst() { return { id: 'device-1' }; },
      async count() { return 0; }
    }
  };
  client.$transaction = async (callback) => callback(client);
  return client;
}

function input(overrides = {}) {
  return {
    assignmentId: 'assignment-1',
    expectedWorkerId: 'worker-1',
    idempotencyKey: 'arrival_guard_123456',
    now: new Date('2026-07-22T11:30:00.000Z'),
    latitude: 4.711,
    longitude: -74.072,
    accuracyMeters: 20,
    installationIdHash: 'a'.repeat(64),
    persistentStorageAvailable: true,
    ...overrides
  };
}

test('calcula el horario programado en Bogotá', () => {
  const expected = buildDispatchAttendanceExpectedWindow(assignmentFixture().serviceRequest);
  assert.equal(expected.expectedStartAt.toISOString(), '2026-07-22T13:00:00.000Z');
  assert.equal(expected.expectedEndAt.toISOString(), '2026-07-22T22:00:00.000Z');
});

test('la entrada permanece habilitada antes y después del inicio programado', () => {
  const expectedStartAt = new Date('2026-07-22T13:00:00.000Z');
  const before = getDispatchArrivalWindowState({
    now: new Date('2026-07-22T11:00:00.000Z'),
    expectedStartAt
  });
  const late = getDispatchArrivalWindowState({
    now: new Date('2026-07-22T18:00:00.000Z'),
    expectedStartAt
  });
  assert.deepEqual(before, { open: true, opensAt: null, closesAt: null, expired: false });
  assert.deepEqual(late, { open: true, opensAt: null, closesAt: null, expired: false });
});

test('rechaza una asignación de otro auxiliar antes de consultar dispositivo', async () => {
  const prisma = successfulPrisma(assignmentFixture({ workerId: 'worker-2' }));
  await assert.rejects(
    () => registerDispatchArrival(prisma, input()),
    /attendance_assignment_not_found/
  );
});

test('registra la hora real aunque sea anterior al turno', async () => {
  const prisma = successfulPrisma(assignmentFixture());
  const result = await registerDispatchArrival(prisma, input());
  assert.equal(result.recorded, true);
  assert.equal(result.attendanceSession.arrivalReportedAt.toISOString(), '2026-07-22T11:30:00.000Z');
  assert.equal(result.attendanceSession.expectedStartAt.toISOString(), '2026-07-22T13:00:00.000Z');
});
