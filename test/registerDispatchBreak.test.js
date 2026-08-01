import test from 'node:test';
import assert from 'node:assert/strict';
import { registerDispatchBreak } from '../src/modules/dispatch-attendance/application/registerBreak.js';

function createFixture(overrides = {}) {
  const session = {
    id: 'session-1',
    arrivalReportedAt: new Date('2026-07-25T13:00:00.000Z'),
    departureReportedAt: null,
    validationStatus: 'AUTO_VALIDATED',
    riskScore: 0,
    riskFlags: [],
    ...overrides.session
  };
  const assignment = {
    id: 'assignment-1',
    workerId: 'worker-1',
    status: 'CONFIRMED',
    attendanceSession: session,
    serviceRequest: {
      operationPoint: {
        attendanceEnabled: true,
        attendanceLatitude: 4.711,
        attendanceLongitude: -74.072,
        geofenceRadiusMeters: 150,
        maxLocationAccuracyMeters: 50
      }
    },
    ...overrides.assignment
  };
  const marks = [...(overrides.marks || [])];
  const client = {
    dispatchAssignment: {
      async findUnique({ where }) { return where.id === assignment.id ? assignment : null; }
    },
    dispatchAttendanceSession: {
      async update({ where, data }) {
        assert.equal(where.id, session.id);
        Object.assign(session, data);
        return session;
      }
    },
    dispatchAttendanceMark: {
      async findUnique({ where, include }) {
        const mark = marks.find((item) => item.idempotencyKey === where.idempotencyKey) || null;
        return mark && include?.attendanceSession ? { ...mark, attendanceSession: session } : mark;
      },
      async findMany() { return marks.filter((item) => ['BREAK_START', 'BREAK_END'].includes(item.markType)); },
      async create({ data }) {
        const mark = { id: `mark-${marks.length + 1}`, ...data };
        marks.push(mark);
        return mark;
      }
    },
    dispatchWorkerDevice: {
      async findFirst() { return { id: 'device-1' }; }
    }
  };
  const prisma = {
    ...client,
    async $transaction(callback, options) {
      assert.equal(options.isolationLevel, 'Serializable');
      return callback(client);
    }
  };
  return { prisma, marks, session };
}

function input(markType, at, overrides = {}) {
  return {
    assignmentId: 'assignment-1',
    expectedWorkerId: 'worker-1',
    idempotencyKey: `${markType.toLowerCase()}_test_123456789`,
    markType,
    now: new Date(at),
    clientCapturedAt: new Date(at),
    latitude: 4.7111,
    longitude: -74.072,
    accuracyMeters: 15,
    installationIdHash: 'installation-hash',
    persistentStorageAvailable: true,
    ...overrides
  };
}

test('registra el inicio de almuerzo después de la llegada', async () => {
  const { prisma, marks } = createFixture();
  const result = await registerDispatchBreak(
    prisma,
    input('BREAK_START', '2026-07-25T17:00:00.000Z')
  );
  assert.equal(result.recorded, true);
  assert.equal(result.attendanceMark.markType, 'BREAK_START');
  assert.equal(result.attendanceMark.insideGeofence, true);
  assert.ok(result.attendanceMark.distanceToPointMeters < 150);
  assert.equal(marks.length, 1);
});

test('registra el fin de almuerzo después de su inicio', async () => {
  const startAt = new Date('2026-07-25T17:00:00.000Z');
  const { prisma } = createFixture({
    marks: [{
      id: 'break-start-1',
      markType: 'BREAK_START',
      idempotencyKey: 'break_start_original',
      serverReceivedAt: startAt,
      clientCapturedAt: startAt
    }]
  });
  const result = await registerDispatchBreak(
    prisma,
    input('BREAK_END', '2026-07-25T18:00:00.000Z')
  );
  assert.equal(result.attendanceMark.markType, 'BREAK_END');
  assert.equal(result.attendanceMark.insideGeofence, true);
});

test('usa la hora capturada para validar el orden de un almuerzo sincronizado', async () => {
  const { prisma } = createFixture({
    marks: [{
      id: 'break-start-1',
      markType: 'BREAK_START',
      idempotencyKey: 'break_start_original',
      serverReceivedAt: new Date('2026-07-25T19:00:00.000Z'),
      clientCapturedAt: new Date('2026-07-25T17:00:00.000Z')
    }]
  });
  const result = await registerDispatchBreak(prisma, input(
    'BREAK_END',
    '2026-07-25T18:00:00.000Z',
    {
      captureMode: 'OFFLINE_WEB',
      now: new Date('2026-07-25T19:05:00.000Z'),
      clientCapturedAt: new Date('2026-07-25T18:00:00.000Z')
    }
  ));
  assert.equal(result.recorded, true);
});

test('marca todo almuerzo offline como pendiente de revisión', async () => {
  const { prisma, session } = createFixture();
  const result = await registerDispatchBreak(prisma, input(
    'BREAK_START',
    '2026-07-25T17:00:00.000Z',
    {
      captureMode: 'OFFLINE_WEB',
      now: new Date('2026-07-25T17:12:00.000Z'),
      clientCapturedAt: new Date('2026-07-25T17:00:00.000Z'),
      persistentStorageAvailable: false
    }
  ));

  assert.equal(result.recorded, true);
  assert.equal(result.validation.validationStatus, 'REVIEW_REQUIRED');
  assert.equal(result.attendanceMark.decision, 'REVIEW_REQUIRED');
  assert.ok(result.validation.riskFlags.includes('OFFLINE_WEB_CAPTURE'));
  assert.ok(result.validation.riskFlags.includes('CLIENT_CLOCK_UNTRUSTED'));
  assert.ok(result.validation.riskFlags.includes('PERSISTENT_STORAGE_UNAVAILABLE'));
  assert.ok(result.validation.riskFlags.includes('DELAYED_SYNC'));
  assert.equal(session.validationStatus, 'REVIEW_REQUIRED');
});

test('no permite finalizar el almuerzo sin haberlo iniciado', async () => {
  const { prisma } = createFixture();
  await assert.rejects(
    () => registerDispatchBreak(prisma, input('BREAK_END', '2026-07-25T18:00:00.000Z')),
    /attendance_break_start_required/
  );
});

test('no permite iniciar un segundo almuerzo en la misma jornada', async () => {
  const startAt = new Date('2026-07-25T17:00:00.000Z');
  const { prisma } = createFixture({
    marks: [{
      id: 'break-start-1',
      markType: 'BREAK_START',
      idempotencyKey: 'break_start_original',
      serverReceivedAt: startAt,
      clientCapturedAt: startAt
    }]
  });
  await assert.rejects(
    () => registerDispatchBreak(prisma, input('BREAK_START', '2026-07-25T17:30:00.000Z')),
    /attendance_break_already_started/
  );
});

test('no permite almuerzo antes de la llegada ni después de la salida', async () => {
  const before = createFixture();
  await assert.rejects(
    () => registerDispatchBreak(before.prisma, input('BREAK_START', '2026-07-25T12:30:00.000Z')),
    /attendance_break_before_arrival/
  );

  const after = createFixture({
    session: { departureReportedAt: new Date('2026-07-25T22:00:00.000Z') }
  });
  await assert.rejects(
    () => registerDispatchBreak(after.prisma, input('BREAK_START', '2026-07-25T22:15:00.000Z')),
    /attendance_break_after_departure/
  );
});

test('la misma idempotencia reproduce el resultado sin duplicar', async () => {
  const { prisma, marks } = createFixture();
  const request = input('BREAK_START', '2026-07-25T17:00:00.000Z');
  const first = await registerDispatchBreak(prisma, request);
  const replay = await registerDispatchBreak(prisma, request);
  assert.equal(first.recorded, true);
  assert.equal(replay.replayed, true);
  assert.equal(marks.length, 1);
});
