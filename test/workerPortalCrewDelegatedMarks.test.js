import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  loadWorkerPortalAssignmentForMark,
  loadWorkerPortalAssignments
} from '../src/modules/dispatch-attendance/application/workerPortalAssignments.js';
import { registerCrewMarkForLeader } from '../src/modules/dispatch-attendance/application/registerCrewArrival.js';

const NOW = new Date('2026-08-21T17:00:00.000Z');

function assignmentRecord({ workerId = 'TEST-WORKER-MEMBER', assignmentId = 'TEST-ASSIGNMENT-MEMBER' } = {}) {
  return {
    id: assignmentId,
    workerId,
    status: 'ASSIGNED',
    attendanceSession: {
      arrivalReportedAt: new Date('2026-08-21T13:00:00.000Z'),
      departureReportedAt: null,
      validationStatus: 'AUTO_VALIDATED',
      punctualityStatus: 'ON_TIME',
      workedMinutes: null,
      marks: []
    },
    serviceRequest: {
      id: 'TEST-SERVICE-CREW-MARKS',
      clientName: 'Cliente prueba',
      operationPointName: 'Operación prueba',
      cityName: 'Ciudad prueba',
      address: 'Dirección de prueba',
      serviceDate: new Date('2026-08-21T00:00:00.000Z'),
      startTime: '08:00',
      endTime: '17:00',
      operationPoint: {
        id: 'TEST-OP-CREW-MARKS',
        name: 'Operación prueba',
        cityName: 'Ciudad prueba',
        address: 'Dirección de prueba',
        attendanceEnabled: true,
        attendancePhotoPolicy: 'NEVER'
      }
    }
  };
}

function context({
  assignmentId = 'TEST-ASSIGNMENT-MEMBER',
  isCrewLeader = false,
  crewAvailable = true
} = {}) {
  return {
    assignmentId,
    serviceRequestId: 'TEST-SERVICE-CREW-MARKS',
    mode: 'CREW',
    isCrewLeader,
    crewAvailable
  };
}

function portalPrisma(record) {
  return {
    dispatchAssignment: {
      async findMany() { return [record]; },
      async findFirst() { return record; }
    },
    dispatchWorker: {
      async findUnique() {
        return { fullName: 'Trabajador prueba', documentNumber: 'TEST-DOC' };
      }
    }
  };
}

test('auxiliar CREW disponible no recibe ninguna marcación individual y el POST puntual queda bloqueado', async () => {
  const record = assignmentRecord();
  const prisma = portalPrisma(record);
  const loadCrewContextsFn = async () => [context()];
  const assignments = await loadWorkerPortalAssignments(prisma, {
    workerId: record.workerId,
    now: NOW,
    loadCrewContextsFn
  });

  assert.equal(assignments.length, 1);
  const [projection] = assignments;
  assert.equal(projection.markDelegatedToCrewLeader, true);
  assert.equal(projection.canRegisterArrival, false);
  assert.equal(projection.canStartBreak, false);
  assert.equal(projection.canEndBreak, false);
  assert.equal(projection.canRegisterDeparture, false);
  assert.equal(projection.breakActionType, null);
  assert.equal(projection.actionType, 'BLOCKED');
  assert.equal(projection.actionLabel, 'Las marcaciones las registra el encargado de cuadrilla');

  const direct = await loadWorkerPortalAssignmentForMark(prisma, {
    workerId: record.workerId,
    assignmentId: record.id,
    now: NOW,
    loadCrewContextsFn
  });
  assert.equal(direct, null);
});

test('kill switch de cuadrilla conserva el fallback individual', async () => {
  const record = assignmentRecord();
  const prisma = portalPrisma(record);
  const direct = await loadWorkerPortalAssignmentForMark(prisma, {
    workerId: record.workerId,
    assignmentId: record.id,
    now: NOW,
    loadCrewContextsFn: async () => [context({ crewAvailable: false })]
  });

  assert.ok(direct);
  assert.equal(direct.markDelegatedToCrewLeader, false);
  assert.equal(direct.crewAvailable, false);
});

test('encargado CREW ve almuerzo y salida como acciones de toda la cuadrilla', async () => {
  const record = assignmentRecord({
    workerId: 'TEST-WORKER-LEADER',
    assignmentId: 'TEST-ASSIGNMENT-LEADER'
  });
  const prisma = portalPrisma(record);
  const [projection] = await loadWorkerPortalAssignments(prisma, {
    workerId: record.workerId,
    now: NOW,
    loadCrewContextsFn: async () => [context({
      assignmentId: record.id,
      isCrewLeader: true
    })]
  });

  assert.equal(projection.isCrewLeader, true);
  assert.equal(projection.crewAvailable, true);
  assert.equal(projection.markDelegatedToCrewLeader, false);
  assert.equal(projection.breakActionType, 'BREAK_START');
  assert.equal(projection.breakActionLabel, 'Iniciar almuerzo de la cuadrilla');
  assert.equal(projection.actionType, 'DEPARTURE');
  assert.equal(projection.actionLabel, 'Registrar salida de la cuadrilla');
});

function crewMembersPrisma() {
  return {
    dispatchAssignment: {
      async findMany({ where }) {
        assert.equal(where.serviceRequestId, 'TEST-SERVICE-CREW-MARKS');
        return [
          { id: 'TEST-ASSIGNMENT-LEADER', workerId: 'TEST-WORKER-LEADER' },
          { id: 'TEST-ASSIGNMENT-A', workerId: 'TEST-WORKER-A' },
          { id: 'TEST-ASSIGNMENT-B', workerId: 'TEST-WORKER-B' }
        ];
      }
    }
  };
}

function recordedMark(validationStatus = 'AUTO_VALIDATED') {
  return {
    recorded: true,
    replayed: false,
    attendanceSession: { validationStatus },
    validation: { validationStatus }
  };
}

const loadLeaderContext = async () => [context({
  assignmentId: 'TEST-ASSIGNMENT-LEADER',
  isCrewLeader: true
})];

test('fan-out procesa primero al encargado, deriva idempotencia y una falla auxiliar no bloquea a los demás', async () => {
  const calls = [];
  const result = await registerCrewMarkForLeader(crewMembersPrisma(), {
    leaderWorkerId: 'TEST-WORKER-LEADER',
    assignmentId: 'TEST-ASSIGNMENT-LEADER',
    idempotencyKey: 'TEST-CREW-MARK-0000001',
    markType: 'BREAK_START',
    now: NOW,
    captureMode: 'ONLINE_WEB',
    clientCapturedAt: NOW,
    latitude: 4.6,
    longitude: -74.1,
    accuracyMeters: 10,
    installationIdHash: 'TEST-LEADER-INSTALLATION',
    persistentStorageAvailable: true
  }, {
    loadCrewContextsFn: loadLeaderContext,
    registerBreakFn: async (_prisma, input) => {
      calls.push(input);
      if (input.assignmentId === 'TEST-ASSIGNMENT-B') {
        throw new Error('attendance_break_arrival_required');
      }
      return recordedMark();
    },
    registerDepartureFn: async () => {
      throw new Error('TEST-DEPARTURE-SHOULD-NOT-RUN');
    }
  });

  assert.equal(result.applied, true);
  assert.equal(result.summary.markType, 'BREAK_START');
  assert.equal(result.summary.totalMembers, 3);
  assert.equal(result.summary.processedCount, 2);
  assert.equal(result.summary.delegatedCount, 1);
  assert.equal(result.summary.failedCount, 1);
  assert.deepEqual(calls.map((call) => call.expectedWorkerId), [
    'TEST-WORKER-LEADER',
    'TEST-WORKER-A',
    'TEST-WORKER-B'
  ]);
  assert.equal(calls[0].idempotencyKey, 'TEST-CREW-MARK-0000001');
  assert.match(calls[1].idempotencyKey, /^crew_[0-9a-f]{48}$/);
  assert.match(calls[2].idempotencyKey, /^crew_[0-9a-f]{48}$/);
  assert.notEqual(calls[1].idempotencyKey, calls[2].idempotencyKey);
  assert.equal(calls[0].installationIdHash, 'TEST-LEADER-INSTALLATION');
  assert.equal(calls[1].installationIdHash, null);
  assert.equal(calls[2].installationIdHash, null);
});

test('si falla la marcación del encargado no se intenta fan-out', async () => {
  let calls = 0;
  await assert.rejects(
    registerCrewMarkForLeader(crewMembersPrisma(), {
      leaderWorkerId: 'TEST-WORKER-LEADER',
      assignmentId: 'TEST-ASSIGNMENT-LEADER',
      idempotencyKey: 'TEST-CREW-MARK-0000002',
      markType: 'BREAK_END',
      now: NOW,
      captureMode: 'ONLINE_WEB',
      latitude: 4.6,
      longitude: -74.1,
      accuracyMeters: 10
    }, {
      loadCrewContextsFn: loadLeaderContext,
      registerBreakFn: async () => {
        calls += 1;
        throw new Error('attendance_break_start_required');
      },
      registerDepartureFn: async () => recordedMark()
    }),
    /attendance_break_start_required/
  );
  assert.equal(calls, 1);
});

test('salida offline usa writer canónico de salida, conserva hora original y evidencia solo en encargado', async () => {
  const departures = [];
  const capturedAt = new Date('2026-08-21T22:00:00.000Z');
  const result = await registerCrewMarkForLeader(crewMembersPrisma(), {
    leaderWorkerId: 'TEST-WORKER-LEADER',
    assignmentId: 'TEST-ASSIGNMENT-LEADER',
    idempotencyKey: 'TEST-CREW-MARK-0000003',
    markType: 'DEPARTURE',
    now: new Date('2026-08-21T22:10:00.000Z'),
    captureMode: 'OFFLINE_WEB',
    clientCapturedAt: capturedAt,
    latitude: 4.6,
    longitude: -74.1,
    accuracyMeters: 10,
    installationIdHash: 'TEST-LEADER-INSTALLATION',
    persistentStorageAvailable: true,
    hasFreshPhoto: true,
    evidenceStorageKey: 'TEST-EVIDENCE',
    evidenceMimeType: 'image/jpeg'
  }, {
    loadCrewContextsFn: loadLeaderContext,
    registerBreakFn: async () => {
      throw new Error('TEST-BREAK-SHOULD-NOT-RUN');
    },
    registerDepartureFn: async (_prisma, input) => {
      departures.push(input);
      return recordedMark('REVIEW_REQUIRED');
    }
  });

  assert.equal(result.summary.processedCount, 3);
  assert.equal(result.summary.reviewPendingCount, 3);
  assert.ok(departures.every((call) => call.captureMode === 'OFFLINE_WEB'));
  assert.ok(departures.every((call) => call.clientCapturedAt === capturedAt));
  assert.equal(departures[0].evidenceStorageKey, 'TEST-EVIDENCE');
  assert.equal(departures[1].evidenceStorageKey, null);
  assert.equal(departures[2].evidenceStorageKey, null);
});

test('router deriva fan-out desde la asignación CREW del encargado y no desde un header cliente', async () => {
  const source = await readFile(new URL('../src/routes/workerPortalCore.js', import.meta.url), 'utf8');

  assert.match(source, /registerCrewMarkForLeader/);
  assert.match(source, /assignment\.crewAvailable === true[\s\S]{0,120}assignment\.isCrewLeader === true/);
  assert.match(source, /registerCrewMarkFn\(prisma,[\s\S]{0,260}leaderWorkerId: portalSession\.workerId/);
  assert.doesNotMatch(source, /x-lorren-crew-(?:mark|break|departure)/i);
  assert.match(source, /crewMarkPublicResult\(crewResult, markType\)/);
});