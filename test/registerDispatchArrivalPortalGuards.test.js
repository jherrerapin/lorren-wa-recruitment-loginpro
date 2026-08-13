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
        attendanceLatitude: 1,
        attendanceLongitude: 1,
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
    idempotencyKey: 'arrival-guard-test',
    now: new Date('2026-07-22T11:30:00.000Z'),
    latitude: 1,
    longitude: 1,
    accuracyMeters: 20,
    installationIdHash: 'installation-test',
    persistentStorageAvailable: true,
    ...overrides
  };
}

test('calcula el horario programado en Bogotá', () => {
  const expected = buildDispatchAttendanceExpectedWindow(assignmentFixture().serviceRequest);
  assert.equal(expected.expectedStartAt.toISOString(), '2026-07-22T13:00:00.000Z');
  assert.equal(expected.expectedEndAt.toISOString(), '2026-07-22T22:00:00.000Z');
});

test('abre la llegada solo durante la fecha operativa en Bogotá', () => {
  const expectedStartAt = new Date('2026-07-22T13:00:00.000Z');
  const beforeDay = getDispatchArrivalWindowState({ now: new Date('2026-07-22T04:59:59.999Z'), expectedStartAt });
  const startOfDay = getDispatchArrivalWindowState({ now: new Date('2026-07-22T05:00:00.000Z'), expectedStartAt });
  const endOfDay = getDispatchArrivalWindowState({ now: new Date('2026-07-23T04:59:59.999Z'), expectedStartAt });
  const nextDay = getDispatchArrivalWindowState({ now: new Date('2026-07-23T05:00:00.000Z'), expectedStartAt });
  assert.equal(beforeDay.open, false);
  assert.equal(beforeDay.expired, false);
  assert.equal(beforeDay.opensAt.toISOString(), '2026-07-22T05:00:00.000Z');
  assert.equal(beforeDay.closesAt.toISOString(), '2026-07-23T05:00:00.000Z');
  assert.equal(startOfDay.open, true);
  assert.equal(endOfDay.open, true);
  assert.equal(nextDay.open, false);
  assert.equal(nextDay.expired, true);
});

test('rechaza una asignación de otro auxiliar antes de consultar dispositivo', async () => {
  const prisma = successfulPrisma(assignmentFixture({ workerId: 'worker-2' }));
  await assert.rejects(() => registerDispatchArrival(prisma, input()), /attendance_assignment_not_found/);
});

test('registra una llegada varias horas antes si ya es el mismo día operativo', async () => {
  const prisma = successfulPrisma(assignmentFixture());
  const result = await registerDispatchArrival(prisma, input({ now: new Date('2026-07-22T05:15:00.000Z') }));
  assert.equal(result.recorded, true);
  assert.equal(result.attendanceSession.arrivalReportedAt.toISOString(), '2026-07-22T05:15:00.000Z');
  assert.equal(result.attendanceSession.expectedStartAt.toISOString(), '2026-07-22T13:00:00.000Z');
});

test('rechaza en backend una llegada del día anterior', async () => {
  const prisma = successfulPrisma(assignmentFixture());
  const result = await registerDispatchArrival(prisma, input({ now: new Date('2026-07-22T04:59:59.999Z') }));
  assert.equal(result.recorded, false);
  assert.deepEqual(result.validation.riskFlags, ['ARRIVAL_WINDOW_NOT_OPEN']);
});

test('rechaza captura offline anterior a la fecha operativa', async () => {
  const prisma = successfulPrisma(assignmentFixture());
  const result = await registerDispatchArrival(prisma, input({
    captureMode: 'OFFLINE_WEB',
    clientCapturedAt: new Date('2026-07-22T04:50:00.000Z'),
    now: new Date('2026-07-22T05:10:00.000Z')
  }));
  assert.equal(result.recorded, false);
  assert.deepEqual(result.validation.riskFlags, ['ARRIVAL_WINDOW_NOT_OPEN']);
});

test('permite una llegada tardía mientras siga siendo el mismo día operativo', async () => {
  const prisma = successfulPrisma(assignmentFixture());
  const result = await registerDispatchArrival(prisma, input({ now: new Date('2026-07-23T04:45:00.000Z') }));
  assert.equal(result.recorded, true);
  assert.equal(result.validation.reportedPunctuality, 'LATE');
});
