import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ATTENDANCE_RISK_FLAG,
  ATTENDANCE_VALIDATION_STATUS,
  evaluateArrivalValidation
} from '../src/modules/dispatch-attendance/domain/attendanceValidationPolicy.js';
import { registerDispatchDeparture } from '../src/modules/dispatch-attendance/application/registerDeparture.js';
import { registerDispatchBreak } from '../src/modules/dispatch-attendance/application/registerBreak.js';

const NOW = new Date('2026-07-31T13:00:00.000Z');
const ARRIVAL_AT = new Date('2026-07-31T12:00:00.000Z');

function validPolicyInput(overrides = {}) {
  return {
    assignmentActive: true,
    attendanceEnabled: true,
    duplicateMark: false,
    arrivalWindowOpen: true,
    hasConfiguredGeofence: true,
    withinGeofence: true,
    accuracyMeters: 12,
    maxAccuracyMeters: 50,
    authorizedDevice: true,
    sharedDeviceSignal: false,
    persistentStorageAvailable: true,
    hasFreshPhoto: true,
    minutesLate: 0,
    toleranceMinutes: 0,
    captureMode: 'ONLINE_WEB',
    syncDelayMinutes: 0,
    ...overrides
  };
}

function assignment() {
  return {
    id: 'assignment-1',
    workerId: 'worker-1',
    status: 'CONFIRMED',
    attendanceSession: {
      id: 'session-1',
      arrivalReportedAt: ARRIVAL_AT,
      departureReportedAt: null,
      expectedStartAt: ARRIVAL_AT,
      expectedEndAt: new Date('2026-07-31T20:00:00.000Z'),
      attendanceStatus: 'ON_TIME',
      validationStatus: 'AUTO_VALIDATED',
      riskScore: 0,
      riskFlags: []
    },
    serviceRequest: {
      operationPoint: {
        attendanceEnabled: true,
        attendanceLatitude: 4.7111,
        attendanceLongitude: -74.0721,
        geofenceRadiusMeters: 100,
        maxLocationAccuracyMeters: 50
      }
    }
  };
}

function fakePrisma() {
  const writes = { marks: 0, sessions: 0 };
  const client = {
    dispatchAssignment: {
      async findUnique() { return assignment(); }
    },
    dispatchAttendanceSession: {
      async update() {
        writes.sessions += 1;
        throw new Error('unexpected_session_write');
      }
    },
    dispatchAttendanceMark: {
      async findUnique() { return null; },
      async findMany() { return []; },
      async create() {
        writes.marks += 1;
        throw new Error('unexpected_mark_write');
      }
    },
    dispatchWorkerDevice: {
      async findFirst() { return { id: 'device-1' }; },
      async count() { return 0; }
    }
  };
  return {
    writes,
    ...client,
    async $transaction(callback) { return callback(client); }
  };
}

function outsideInput(markType) {
  return {
    assignmentId: 'assignment-1',
    expectedWorkerId: 'worker-1',
    idempotencyKey: `${markType.toLowerCase()}-outside-123456`,
    markType,
    now: NOW,
    captureMode: 'ONLINE_WEB',
    latitude: 6.2442,
    longitude: -75.5812,
    accuracyMeters: 12,
    installationIdHash: 'installation-hash',
    persistentStorageAvailable: true,
    hasFreshPhoto: true,
    evidenceStorageKey: 'attendance/test.jpg',
    evidenceMimeType: 'image/jpeg'
  };
}

test('la autoridad rechaza geocerca ausente, ubicación externa y precisión insuficiente', () => {
  const cases = [
    [validPolicyInput({ hasConfiguredGeofence: false }), ATTENDANCE_RISK_FLAG.GEOFENCE_NOT_CONFIGURED],
    [validPolicyInput({ withinGeofence: null }), ATTENDANCE_RISK_FLAG.LOCATION_NOT_AVAILABLE],
    [validPolicyInput({ withinGeofence: false }), ATTENDANCE_RISK_FLAG.OUTSIDE_GEOFENCE],
    [validPolicyInput({ accuracyMeters: 80 }), ATTENDANCE_RISK_FLAG.LOW_LOCATION_ACCURACY]
  ];

  for (const [input, expectedFlag] of cases) {
    const result = evaluateArrivalValidation(input);
    assert.equal(result.canRecordArrival, false);
    assert.equal(result.validationStatus, ATTENDANCE_VALIDATION_STATUS.REJECTED);
    assert.deepEqual(result.riskFlags, [expectedFlag]);
  }
});

test('la llegada consulta la política antes de crear la sesión o la marca', () => {
  const source = fs.readFileSync('src/modules/dispatch-attendance/application/registerArrival.js', 'utf8');
  const validationPosition = source.indexOf('const validation = evaluateArrivalValidation');
  const rejectionPosition = source.indexOf('if (!validation.canRecordArrival)');
  const createPosition = source.indexOf('dispatchAttendanceSession.create');

  assert.ok(validationPosition >= 0);
  assert.ok(rejectionPosition > validationPosition);
  assert.ok(createPosition > rejectionPosition);
});

test('la salida fuera del radio no crea marca ni actualiza la jornada', async () => {
  const prisma = fakePrisma();
  await assert.rejects(
    () => registerDispatchDeparture(prisma, outsideInput('DEPARTURE')),
    /attendance_outside_operation_range/
  );
  assert.deepEqual(prisma.writes, { marks: 0, sessions: 0 });
});

test('el inicio de almuerzo fuera del radio no crea ninguna marca', async () => {
  const prisma = fakePrisma();
  await assert.rejects(
    () => registerDispatchBreak(prisma, outsideInput('BREAK_START')),
    /attendance_outside_operation_range/
  );
  assert.deepEqual(prisma.writes, { marks: 0, sessions: 0 });
});

test('Prisma ya no modifica asignaciones ni radios según perfiles de prueba', () => {
  const source = fs.readFileSync('src/lib/prisma.js', 'utf8');
  assert.doesNotMatch(source, /dispatchTestGeofenceBypass/);
  assert.doesNotMatch(source, /isTestClient/);
  assert.doesNotMatch(source, /isTestProfile/);
  assert.doesNotMatch(source, /99_999|100_000/);
  assert.doesNotMatch(source, /\.\$use\(/);
});
