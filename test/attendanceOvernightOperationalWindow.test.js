import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDispatchAttendanceOperationalWindow
} from '../src/modules/dispatch-attendance/application/registerArrival.js';
import { registerDispatchBreak } from '../src/modules/dispatch-attendance/application/registerBreak.js';
import { registerDispatchDeparture } from '../src/modules/dispatch-attendance/application/registerDeparture.js';
import { loadWorkerPortalAssignments } from '../src/modules/dispatch-attendance/application/workerPortalAssignments.js';

const SERVICE_DATE = new Date('2026-08-13T00:00:00.000Z');
const NIGHT_START = new Date('2026-08-14T03:00:00.000Z'); // 13-ago 22:00 Bogotá
const NIGHT_BREAK = new Date('2026-08-14T07:00:00.000Z'); // 14-ago 02:00 Bogotá
const NIGHT_DEPARTURE = new Date('2026-08-14T12:00:00.000Z'); // 14-ago 07:00 Bogotá
const NEXT_NIGHT = new Date('2026-08-15T03:00:00.000Z'); // 14-ago 22:00 Bogotá
const DAY_START = new Date('2026-08-13T11:00:00.000Z'); // 13-ago 06:00 Bogotá
const DAY_ARRIVAL = new Date('2026-08-13T10:56:00.000Z'); // 13-ago 05:56 Bogotá
const DAY_BREAK_AFTER_DERIVED_END = new Date('2026-08-13T19:09:00.000Z'); // 13-ago 14:09 Bogotá

function operationPoint() {
  return {
    attendanceEnabled: true,
    attendanceLatitude: 4.711,
    attendanceLongitude: -74.072,
    geofenceRadiusMeters: 150,
    maxLocationAccuracyMeters: 50,
    attendancePhotoPolicy: 'RISK_ONLY'
  };
}

function overnightAssignment({ marks = [] } = {}) {
  return {
    id: 'assignment-night-test',
    workerId: 'worker-test',
    serviceRequestId: 'request-night-test',
    status: 'CONFIRMED',
    attendanceSession: {
      id: 'session-night-test',
      assignmentId: 'assignment-night-test',
      expectedStartAt: NIGHT_START,
      expectedEndAt: null,
      arrivalReportedAt: NIGHT_START,
      departureReportedAt: null,
      validationStatus: 'AUTO_VALIDATED',
      attendanceStatus: 'ARRIVAL_REPORTED',
      punctualityStatus: 'ON_TIME',
      riskScore: 0,
      riskFlags: [],
      workedMinutes: null,
      marks
    },
    serviceRequest: {
      clientName: 'Cliente Prueba',
      operationPointName: 'Operación Prueba',
      cityName: 'Bogotá',
      address: 'Dirección de prueba',
      serviceDate: SERVICE_DATE,
      startTime: '22:00',
      endTime: null,
      operationPoint: operationPoint()
    }
  };
}

function daytimeAssignment({ endTime = null, marks = [] } = {}) {
  return {
    id: 'assignment-day-test',
    workerId: 'worker-day-test',
    serviceRequestId: 'request-day-test',
    status: 'CONFIRMED',
    attendanceSession: {
      id: 'session-day-test',
      assignmentId: 'assignment-day-test',
      expectedStartAt: DAY_START,
      expectedEndAt: null,
      arrivalReportedAt: DAY_ARRIVAL,
      departureReportedAt: null,
      validationStatus: 'AUTO_VALIDATED',
      attendanceStatus: 'ARRIVAL_REPORTED',
      punctualityStatus: 'ON_TIME',
      riskScore: 0,
      riskFlags: [],
      workedMinutes: null,
      marks
    },
    serviceRequest: {
      clientName: 'Cliente Prueba',
      operationPointName: 'Operación Prueba',
      cityName: 'Bogotá',
      address: 'Dirección de prueba',
      serviceDate: SERVICE_DATE,
      startTime: '06:00',
      endTime,
      operationPoint: operationPoint()
    }
  };
}

function attendancePrisma(assignment) {
  const marks = assignment.attendanceSession.marks;
  const markByIdempotency = new Map();
  const client = {
    dispatchAssignment: {
      async findUnique({ where }) { return where.id === assignment.id ? assignment : null; }
    },
    dispatchAttendanceSession: {
      async update({ data }) {
        Object.assign(assignment.attendanceSession, data);
        return assignment.attendanceSession;
      }
    },
    dispatchAttendanceMark: {
      async findUnique({ where, include }) {
        const mark = markByIdempotency.get(where.idempotencyKey) || null;
        return mark && include?.attendanceSession
          ? { ...mark, attendanceSession: assignment.attendanceSession }
          : mark;
      },
      async findMany() {
        return marks.filter((mark) => ['BREAK_START', 'BREAK_END'].includes(mark.markType));
      },
      async create({ data }) {
        const mark = { id: `mark-${marks.length + 1}`, ...data };
        marks.push(mark);
        markByIdempotency.set(mark.idempotencyKey, mark);
        return mark;
      }
    },
    dispatchWorkerDevice: {
      async findFirst() { return { id: 'device-test' }; },
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
  return prisma;
}

function portalPrisma(assignment) {
  return {
    dispatchAssignment: {
      async findMany() { return [assignment]; }
    },
    dispatchWorker: {
      async findUnique() {
        return { fullName: 'Auxiliar Prueba', documentNumber: 'DOC-TEST-001' };
      }
    }
  };
}

function markInput(at, overrides = {}) {
  return {
    assignmentId: 'assignment-night-test',
    expectedWorkerId: 'worker-test',
    idempotencyKey: `mark_${at.toISOString()}_${overrides.markType || 'departure'}`,
    now: at,
    clientCapturedAt: at,
    latitude: 4.7111,
    longitude: -74.072,
    accuracyMeters: 10,
    installationIdHash: 'installation-test',
    persistentStorageAvailable: true,
    hasFreshPhoto: true,
    evidenceStorageKey: 'attendance/worker-test/assignment-night-test/departure/test.jpg',
    evidenceMimeType: 'image/jpeg',
    ...overrides
  };
}

test('la autoridad deriva 22:00→06:00 para continuidad cuando no existe endTime, sin persistir un fin ficticio', () => {
  const assignment = overnightAssignment();
  const window = resolveDispatchAttendanceOperationalWindow(
    assignment.serviceRequest,
    assignment.attendanceSession
  );

  assert.equal(window.expectedStartAt.toISOString(), NIGHT_START.toISOString());
  assert.equal(window.expectedEndAt, null);
  assert.equal(window.operationalEndAt.toISOString(), '2026-08-14T11:00:00.000Z');
  assert.equal(window.continuityClosesAt.toISOString(), '2026-08-14T19:00:00.000Z');
  assert.equal(window.overnight, true);
  assert.equal(window.derivedOperationalEnd, true);
});

test('un expectedEndAt legado corto no anula un horario programado 22:00→06:00', () => {
  const assignment = overnightAssignment();
  assignment.attendanceSession.expectedEndAt = new Date('2026-08-14T04:00:00.000Z'); // 13-ago 23:00
  assignment.serviceRequest.endTime = '06:00';
  const window = resolveDispatchAttendanceOperationalWindow(
    assignment.serviceRequest,
    assignment.attendanceSession
  );

  assert.equal(window.expectedEndAt.toISOString(), '2026-08-14T04:00:00.000Z');
  assert.equal(window.operationalEndAt.toISOString(), '2026-08-14T11:00:00.000Z');
  assert.equal(window.overnight, true);
});

test('un turno diurno sin endTime termina en la misma fecha operativa y no obtiene X+1', () => {
  const request = {
    serviceDate: SERVICE_DATE,
    startTime: '08:00',
    endTime: null
  };
  const session = {
    expectedStartAt: new Date('2026-08-13T13:00:00.000Z'),
    expectedEndAt: null
  };
  const window = resolveDispatchAttendanceOperationalWindow(request, session);

  assert.equal(window.operationalEndAt.toISOString(), '2026-08-13T21:00:00.000Z');
  assert.equal(window.continuityClosesAt.toISOString(), '2026-08-14T05:00:00.000Z');
  assert.equal(window.overnight, false);
});

test('un turno diurno sin endTime mantiene inicio de almuerzo después de las 8 horas derivadas mientras la jornada sigue abierta', async () => {
  const assignment = daytimeAssignment();
  const window = resolveDispatchAttendanceOperationalWindow(
    assignment.serviceRequest,
    assignment.attendanceSession
  );

  assert.equal(window.derivedOperationalEnd, true);
  assert.equal(window.operationalEndAt.toISOString(), '2026-08-13T19:00:00.000Z');
  assert.equal(window.continuityClosesAt.toISOString(), '2026-08-14T05:00:00.000Z');
  assert.ok(DAY_BREAK_AFTER_DERIVED_END > window.operationalEndAt);
  assert.ok(DAY_BREAK_AFTER_DERIVED_END < window.continuityClosesAt);

  const [projection] = await loadWorkerPortalAssignments(portalPrisma(assignment), {
    workerId: assignment.workerId,
    now: DAY_BREAK_AFTER_DERIVED_END
  });
  assert.equal(projection.canStartBreak, true);
  assert.equal(projection.breakActionType, 'BREAK_START');
  assert.equal(projection.canRegisterDeparture, true);

  const result = await registerDispatchBreak(attendancePrisma(assignment), markInput(DAY_BREAK_AFTER_DERIVED_END, {
    assignmentId: assignment.id,
    expectedWorkerId: assignment.workerId,
    markType: 'BREAK_START',
    evidenceStorageKey: null,
    evidenceMimeType: null
  }));
  assert.equal(result.recorded, true);
  assert.equal(result.attendanceMark.markType, 'BREAK_START');
});

test('un fin explícito conserva el cierre de inicio de almuerzo', async () => {
  const assignment = daytimeAssignment({ endTime: '14:00' });
  const window = resolveDispatchAttendanceOperationalWindow(
    assignment.serviceRequest,
    assignment.attendanceSession
  );

  assert.equal(window.derivedOperationalEnd, false);
  assert.equal(window.operationalEndAt.toISOString(), '2026-08-13T19:00:00.000Z');

  const [projection] = await loadWorkerPortalAssignments(portalPrisma(assignment), {
    workerId: assignment.workerId,
    now: DAY_BREAK_AFTER_DERIVED_END
  });
  assert.equal(projection.canStartBreak, false);
  assert.equal(projection.breakActionType, null);

  await assert.rejects(
    () => registerDispatchBreak(attendancePrisma(assignment), markInput(DAY_BREAK_AFTER_DERIVED_END, {
      assignmentId: assignment.id,
      expectedWorkerId: assignment.workerId,
      markType: 'BREAK_START',
      evidenceStorageKey: null,
      evidenceMimeType: null
    })),
    /attendance_break_operational_window_invalid/
  );
});

test('el auxiliar puede iniciar almuerzo a las 02:00 de X+1 en una jornada de las 22:00', async () => {
  const assignment = overnightAssignment();
  const prisma = attendancePrisma(assignment);
  const result = await registerDispatchBreak(prisma, markInput(NIGHT_BREAK, {
    markType: 'BREAK_START',
    evidenceStorageKey: null,
    evidenceMimeType: null
  }));

  assert.equal(result.recorded, true);
  assert.equal(result.attendanceMark.markType, 'BREAK_START');
  assert.equal(result.attendanceMark.clientCapturedAt.toISOString(), NIGHT_BREAK.toISOString());
});

test('el auxiliar no puede iniciar almuerzo a las 22:00 de la noche siguiente en la misma jornada', async () => {
  const assignment = overnightAssignment();
  const prisma = attendancePrisma(assignment);

  await assert.rejects(
    () => registerDispatchBreak(prisma, markInput(NEXT_NIGHT, {
      markType: 'BREAK_START',
      evidenceStorageKey: null,
      evidenceMimeType: null
    })),
    /attendance_break_operational_window_invalid/
  );
});

test('una salida de madrugada conserva horas extra dentro de la misma jornada nocturna', async () => {
  const assignment = overnightAssignment();
  const prisma = attendancePrisma(assignment);
  const result = await registerDispatchDeparture(prisma, markInput(NIGHT_DEPARTURE));

  assert.equal(result.recorded, true);
  assert.equal(result.validation.workedMinutes, 540);
  assert.equal(result.validation.overtimeMinutes, 120);
  assert.equal(result.attendanceSession.departureReportedAt.toISOString(), NIGHT_DEPARTURE.toISOString());
});

test('la salida a las 22:00 de la noche siguiente no puede cerrar la jornada anterior', async () => {
  const assignment = overnightAssignment();
  const prisma = attendancePrisma(assignment);

  await assert.rejects(
    () => registerDispatchDeparture(prisma, markInput(NEXT_NIGHT)),
    /attendance_departure_operational_window_invalid/
  );
});

test('el portal mantiene accionable la madrugada y bloquea la noche siguiente para la misma sesión', async () => {
  const assignment = overnightAssignment();
  const prisma = portalPrisma(assignment);

  const [duringShift] = await loadWorkerPortalAssignments(prisma, {
    workerId: 'worker-test',
    now: NIGHT_BREAK
  });
  assert.equal(duringShift.canStartBreak, true);
  assert.equal(duringShift.canRegisterDeparture, true);
  assert.equal(duringShift.actionType, 'DEPARTURE');

  const [nextNight] = await loadWorkerPortalAssignments(prisma, {
    workerId: 'worker-test',
    now: NEXT_NIGHT
  });
  assert.equal(nextNight.canStartBreak, false);
  assert.equal(nextNight.canRegisterDeparture, false);
  assert.equal(nextNight.actionType, 'BLOCKED');
  assert.match(nextNight.actionLabel, /requiere coordinación/i);
});
