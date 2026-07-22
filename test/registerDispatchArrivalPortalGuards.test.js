import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTENDANCE_RISK_FLAG,
  buildDispatchAttendanceExpectedWindow,
  getDispatchArrivalWindowState,
  registerDispatchArrival
} from '../src/modules/dispatch-attendance/application/registerArrival.js';
import { evaluateArrivalValidation } from '../src/modules/dispatch-attendance/domain/attendanceValidationPolicy.js';

function minimalPrisma(assignment) {
  const client = {
    dispatchAssignment: {
      async findUnique() {
        return assignment;
      }
    },
    dispatchAttendanceSession: {
      async create() {
        throw new Error('must_not_create');
      },
      async update() {
        throw new Error('must_not_update');
      }
    },
    dispatchAttendanceMark: {
      async findUnique() {
        return null;
      },
      async create() {
        throw new Error('must_not_create');
      }
    },
    dispatchWorkerDevice: {
      async findFirst() {
        throw new Error('must_not_read_device');
      },
      async count() {
        throw new Error('must_not_count_device');
      }
    }
  };
  client.$transaction = async (callback) => callback(client);
  return client;
}

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
        earlyArrivalWindowMinutes: 60,
        lateToleranceMinutes: 10
      }
    },
    ...overrides
  };
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
    persistentStorageAvailable: true,
    ...overrides
  };
}

test('calcula la hora esperada y la apertura de la ventana en Bogotá', () => {
  const expected = buildDispatchAttendanceExpectedWindow(assignmentFixture().serviceRequest);
  assert.equal(expected.expectedStartAt.toISOString(), '2026-07-22T13:00:00.000Z');
  assert.equal(expected.expectedEndAt.toISOString(), '2026-07-22T22:00:00.000Z');

  const before = getDispatchArrivalWindowState({
    now: new Date('2026-07-22T11:59:59.000Z'),
    expectedStartAt: expected.expectedStartAt,
    earlyArrivalWindowMinutes: 60
  });
  const open = getDispatchArrivalWindowState({
    now: new Date('2026-07-22T12:00:00.000Z'),
    expectedStartAt: expected.expectedStartAt,
    earlyArrivalWindowMinutes: 60
  });
  assert.equal(before.open, false);
  assert.equal(open.open, true);
  assert.equal(open.opensAt.toISOString(), '2026-07-22T12:00:00.000Z');
});

test('la política rechaza una llegada antes de la ventana sin convertirla en revisión', () => {
  const result = evaluateArrivalValidation({
    assignmentActive: true,
    attendanceEnabled: true,
    duplicateMark: false,
    arrivalWindowOpen: false
  });
  assert.equal(result.canRecordArrival, false);
  assert.equal(result.validationStatus, 'REJECTED');
  assert.deepEqual(result.riskFlags, [ATTENDANCE_RISK_FLAG.ARRIVAL_WINDOW_NOT_OPEN]);
});

test('la autoridad rechaza una asignación de otro auxiliar antes de consultar dispositivo', async () => {
  const prisma = minimalPrisma(assignmentFixture({ workerId: 'worker-2' }));
  await assert.rejects(
    () => registerDispatchArrival(prisma, input()),
    /attendance_assignment_not_found/
  );
});

test('la autoridad no crea sesión ni consulta dispositivo antes de la ventana', async () => {
  const prisma = minimalPrisma(assignmentFixture());
  const result = await registerDispatchArrival(prisma, input());
  assert.equal(result.recorded, false);
  assert.equal(result.validation.validationStatus, 'REJECTED');
  assert.deepEqual(result.validation.riskFlags, [ATTENDANCE_RISK_FLAG.ARRIVAL_WINDOW_NOT_OPEN]);
});
