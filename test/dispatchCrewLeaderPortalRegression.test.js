import test from 'node:test';
import assert from 'node:assert/strict';
import { registerDispatchBreak } from '../src/modules/dispatch-attendance/application/registerBreak.js';

function fixture() {
  const now = new Date('2026-08-14T17:00:00.000Z');
  const session = {
    id: 'TEST-SESSION-LEADER',
    arrivalReportedAt: new Date('2026-08-14T12:00:00.000Z'),
    departureReportedAt: null,
    validationStatus: 'AUTO_VALIDATED',
    riskScore: 0,
    riskFlags: []
  };
  const assignment = {
    id: 'TEST-ASSIGNMENT-LEADER',
    workerId: 'TEST-WORKER-LEADER',
    status: 'CREW_LEADER',
    attendanceSession: session,
    serviceRequest: {
      operationPoint: {
        attendanceEnabled: true,
        attendanceLatitude: 4.711,
        attendanceLongitude: -74.0721,
        geofenceRadiusMeters: 200,
        maxLocationAccuracyMeters: 100
      }
    }
  };
  const client = {
    dispatchAssignment: {
      async findUnique({ where }) { return where.id === assignment.id ? assignment : null; }
    },
    dispatchAttendanceSession: {
      async update({ data }) { Object.assign(session, data); return session; }
    },
    dispatchAttendanceMark: {
      async findUnique() { return null; },
      async findMany() { return []; },
      async create({ data }) { return { id: 'TEST-MARK-BREAK', ...data }; }
    },
    dispatchWorkerDevice: {
      async findFirst() { return { id: 'TEST-DEVICE-LEADER' }; }
    }
  };
  client.$transaction = async (callback, options) => {
    assert.deepEqual(options, { isolationLevel: 'Serializable' });
    return callback(client);
  };
  return { prisma: client, now };
}

test('el encargado CREW_LEADER puede marcar su propio almuerzo desde el portal', async () => {
  const { prisma, now } = fixture();
  const result = await registerDispatchBreak(prisma, {
    assignmentId: 'TEST-ASSIGNMENT-LEADER',
    expectedWorkerId: 'TEST-WORKER-LEADER',
    idempotencyKey: 'TEST-LEADER-BREAK-START',
    markType: 'BREAK_START',
    now,
    latitude: 4.7111,
    longitude: -74.072,
    accuracyMeters: 10,
    installationIdHash: 'TEST-INSTALLATION-LEADER',
    persistentStorageAvailable: true
  });

  assert.equal(result.recorded, true);
  assert.equal(result.attendanceMark.markType, 'BREAK_START');
  assert.equal(result.attendanceMark.workerDeviceId, 'TEST-DEVICE-LEADER');
});
