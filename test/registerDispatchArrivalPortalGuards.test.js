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
    now: new Date('2026-07-22T13:30:00.000Z'),
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

test('abre la llegada desde la hora de inicio hasta ocho horas después, inclusive', () => {
  const expectedStartAt = new Date('2026-07-22T13:00:00.000Z');
  const beforeStart = getDispatchArrivalWindowState({ now: new Date('2026-07-22T12:59:59.999Z'), expectedStartAt });
  const atStart = getDispatchArrivalWindowState({ now: new Date('2026-07-22T13:00:00.000Z'), expectedStartAt });
  const atClose = getDispatchArrivalWindowState({ now: new Date('2026-07-22T21:00:00.000Z'), expectedStartAt });
  const afterClose = getDispatchArrivalWindowState({ now: new Date('2026-07-22T21:00:00.001Z'), expectedStartAt });

  assert.equal(beforeStart.open, false);
  assert.equal(beforeStart.expired, false);
  assert.equal(beforeStart.opensAt.toISOString(), '2026-07-22T13:00:00.000Z');
  assert.equal(beforeStart.closesAt.toISOString(), '2026-07-22T21:00:00.000Z');
  assert.equal(atStart.open, true);
  assert.equal(atClose.open, true);
  assert.equal(atClose.expired, false);
  assert.equal(afterClose.open, false);
  assert.equal(afterClose.expired, true);
});

test('rechaza una asignación de otro auxiliar antes de consultar dispositivo', async () => {
  const prisma = successfulPrisma(assignmentFixture({ workerId: 'worker-2' }));
  await assert.rejects(() => registerDispatchArrival(prisma, input()), /attendance_assignment_not_found/);
});

test('rechaza en backend una llegada antes de la hora de inicio', async () => {
  const prisma = successfulPrisma(assignmentFixture());
  const result = await registerDispatchArrival(prisma, input({ now: new Date('2026-07-22T12:59:59.999Z') }));
  assert.equal(result.recorded, false);
  assert.deepEqual(result.validation.riskFlags, ['ARRIVAL_WINDOW_NOT_OPEN']);
});

test('registra la llegada desde la hora exacta de inicio', async () => {
  const prisma = successfulPrisma(assignmentFixture());
  const result = await registerDispatchArrival(prisma, input({ now: new Date('2026-07-22T13:00:00.000Z') }));
  assert.equal(result.recorded, true);
  assert.equal(result.attendanceSession.arrivalReportedAt.toISOString(), '2026-07-22T13:00:00.000Z');
  assert.equal(result.attendanceSession.expectedStartAt.toISOString(), '2026-07-22T13:00:00.000Z');
});

test('rechaza captura offline realizada antes de la hora de inicio', async () => {
  const prisma = successfulPrisma(assignmentFixture());
  const result = await registerDispatchArrival(prisma, input({
    captureMode: 'OFFLINE_WEB',
    clientCapturedAt: new Date('2026-07-22T12:50:00.000Z'),
    now: new Date('2026-07-22T13:10:00.000Z')
  }));
  assert.equal(result.recorded, false);
  assert.deepEqual(result.validation.riskFlags, ['ARRIVAL_WINDOW_NOT_OPEN']);
});

test('permite una llegada tardía hasta ocho horas después del inicio', async () => {
  const prisma = successfulPrisma(assignmentFixture());
  const result = await registerDispatchArrival(prisma, input({ now: new Date('2026-07-22T21:00:00.000Z') }));
  assert.equal(result.recorded, true);
  assert.equal(result.validation.reportedPunctuality, 'LATE');
});

test('rechaza una llegada después de ocho horas desde el inicio', async () => {
  const prisma = successfulPrisma(assignmentFixture());
  const result = await registerDispatchArrival(prisma, input({ now: new Date('2026-07-22T21:00:00.001Z') }));
  assert.equal(result.recorded, false);
  assert.deepEqual(result.validation.riskFlags, ['ARRIVAL_WINDOW_NOT_OPEN']);
});

test('un turno nocturno conserva la llegada disponible en X+1 dentro de las ocho horas', async () => {
  const overnightAssignment = assignmentFixture();
  overnightAssignment.serviceRequest = {
    ...overnightAssignment.serviceRequest,
    serviceDate: new Date('2026-07-22T00:00:00.000Z'),
    startTime: '21:00',
    endTime: '06:00'
  };
  const expected = buildDispatchAttendanceExpectedWindow(overnightAssignment.serviceRequest);
  assert.equal(expected.expectedStartAt.toISOString(), '2026-07-23T02:00:00.000Z');
  assert.equal(expected.expectedEndAt.toISOString(), '2026-07-23T11:00:00.000Z');

  const prisma = successfulPrisma(overnightAssignment);
  const result = await registerDispatchArrival(prisma, input({
    now: new Date('2026-07-23T06:30:00.000Z')
  }));
  assert.equal(result.recorded, true);
  assert.equal(result.validation.reportedPunctuality, 'LATE');
  assert.equal(result.attendanceSession.expectedStartAt.toISOString(), '2026-07-23T02:00:00.000Z');
});
