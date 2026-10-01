import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import express from 'express';
import vm from 'node:vm';
import ejs from 'ejs';
import { workerPortalRouter, WORKER_PORTAL_INSTALLATION_COOKIE_NAME } from '../src/routes/workerPortal.js';
import { WORKER_PORTAL_SESSION_COOKIE_NAME } from '../src/modules/dispatch-attendance/domain/workerPortalSessionPolicy.js';
import {
  loadWorkerPortalAssignmentForMark,
  loadWorkerPortalAssignments
} from '../src/modules/dispatch-attendance/application/workerPortalAssignments.js';
import { registerCrewArrivalForLeader, registerCrewMarkForLeader } from '../src/modules/dispatch-attendance/application/registerCrewArrival.js';

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
  assert.deepEqual(projection.crewMembers, []);
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

test('la PWA solo marca al encargado cuando fue seleccionado, aunque llegue primero y salga último', async () => {
  const arrivalCalls = [];
  const reviewCalls = [];
  const arrivalInput = (selected) => ({
    leaderWorkerId: 'TEST-WORKER-LEADER',
    assignmentId: 'TEST-ASSIGNMENT-LEADER',
    manualAssignmentIds: selected,
    idempotencyKey: `TEST-CREW-ARRIVAL-${selected.join('-')}`,
    now: NOW,
    captureMode: 'ONLINE_WEB',
    latitude: 4.6,
    longitude: -74.1,
    accuracyMeters: 10
  });
  const arrivalOptions = {
    loadCrewContextsFn: loadLeaderContext,
    registerArrivalFn: async (_prisma, input) => {
      arrivalCalls.push(input.assignmentId);
      return {
        recorded: true,
        attendanceSession: { id: `session-${input.assignmentId}`, validationStatus: 'PENDING' },
        validation: { validationStatus: 'PENDING' }
      };
    },
    reviewAttendanceFn: async (_prisma, input) => { reviewCalls.push(input); }
  };
  const leaderArrival = await registerCrewArrivalForLeader(crewMembersPrisma(),
    arrivalInput(['TEST-ASSIGNMENT-LEADER']), arrivalOptions);
  assert.deepEqual(arrivalCalls, ['TEST-ASSIGNMENT-LEADER']);
  assert.equal(leaderArrival.summary.results.length, 1);
  arrivalCalls.length = 0;
  const memberArrival = await registerCrewArrivalForLeader(crewMembersPrisma(),
    arrivalInput(['TEST-ASSIGNMENT-A']), arrivalOptions);
  assert.deepEqual(arrivalCalls, ['TEST-ASSIGNMENT-A']);
  assert.equal(memberArrival.leaderResult, null);
  assert.equal(memberArrival.summary.results.length, 1);
  assert.ok(reviewCalls.every((call) => call.notes.includes('Marcación manual PWA:')));

  const departureCalls = [];
  const departureOptions = {
    loadCrewContextsFn: loadLeaderContext,
    registerDepartureFn: async (_prisma, input) => {
      departureCalls.push(input.assignmentId);
      return recordedMark();
    }
  };
  const departureInput = (selected) => ({
    ...arrivalInput(selected),
    idempotencyKey: `TEST-CREW-DEPARTURE-${selected.join('-')}`,
    markType: 'DEPARTURE'
  });
  await registerCrewMarkForLeader(crewMembersPrisma(), departureInput(['TEST-ASSIGNMENT-A']), departureOptions);
  assert.deepEqual(departureCalls, ['TEST-ASSIGNMENT-A']);
  departureCalls.length = 0;
  await registerCrewMarkForLeader(crewMembersPrisma(), departureInput(['TEST-ASSIGNMENT-LEADER']), departureOptions);
  assert.deepEqual(departureCalls, ['TEST-ASSIGNMENT-LEADER']);
});

test('la ruta PWA admite seleccionar al encargado y rechaza una asignación ajena', async () => {
  const operationPoint = {
    id: 'TEST-OP-CREW-MARKS',
    attendanceEnabled: true,
    attendanceLatitude: 4.6,
    attendanceLongitude: -74.08,
    geofenceRadiusMeters: 100,
    maxLocationAccuracyMeters: 50
  };
  const calls = [];
  const app = express();
  app.use('/operaciones/portal', workerPortalRouter({ devAuditEvent: { create: async () => ({}) } }, {
    repository: {},
    nowFn: () => NOW,
    resolveSessionFn: async () => ({ workerId: 'TEST-WORKER-LEADER', deviceId: 'TEST-DEVICE', sessionId: 'TEST-SESSION', expiresAt: new Date(NOW.getTime() + 60_000) }),
    loadAssignmentsFn: async () => [],
    loadBiometricAssignmentFn: async () => ({
      id: 'TEST-ASSIGNMENT-LEADER',
      serviceRequest: { id: 'TEST-SERVICE-CREW-MARKS', operationPoint }
    }),
    loadCrewPortalContextsFn: async () => [{
      ...context({ assignmentId: 'TEST-ASSIGNMENT-LEADER', isCrewLeader: true }),
      operationPointId: operationPoint.id,
      members: [
        { assignmentId: 'TEST-ASSIGNMENT-LEADER' },
        { assignmentId: 'TEST-ASSIGNMENT-A' }
      ]
    }],
    registerCrewPresenceArrivalFn: async (input) => {
      calls.push(input);
      return { applied: true, summary: { newlyRecordedCount: 1, results: [{ assignmentId: input.manualAssignmentIds[0], status: 'RECORDED' }] } };
    }
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const request = (selectedAssignmentIds, latitude = 4.6) => fetch(`${origin}/operaciones/portal/cuadrillas/marcacion-manual`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'worker-portal',
        Cookie: `${WORKER_PORTAL_SESSION_COOKIE_NAME}=${'B'.repeat(43)}; ${WORKER_PORTAL_INSTALLATION_COOKIE_NAME}=123e4567-e89b-42d3-a456-426614174000`
      },
      body: JSON.stringify({
        assignmentId: 'TEST-ASSIGNMENT-LEADER',
        selectedAssignmentIds,
        markType: 'ARRIVAL',
        idempotencyKey: 'TEST-LEADER-ARRIVAL-001',
        latitude,
        longitude: -74.08,
        accuracyMeters: 10
      })
    });
    const own = await request(['TEST-ASSIGNMENT-LEADER']);
    assert.equal(own.status, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].manualAssignmentIds, ['TEST-ASSIGNMENT-LEADER']);
    const foreign = await request(['TEST-ASSIGNMENT-FOREIGN']);
    assert.equal(foreign.status, 409);
    assert.equal(calls.length, 1);
    const outside = await request(['TEST-ASSIGNMENT-LEADER'], 5.6);
    assert.equal(outside.status, 409);
    assert.equal(calls.length, 1);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('la PWA muestra la lista autorizada y acciones secuenciales sin pedir cargar auxiliares', async () => {
  const record = assignmentRecord({ workerId: 'TEST-WORKER-LEADER', assignmentId: 'TEST-ASSIGNMENT-LEADER' });
  const [projection] = await loadWorkerPortalAssignments(portalPrisma(record), {
    workerId: record.workerId,
    now: NOW,
    loadCrewContextsFn: async () => [{
      ...context({ assignmentId: record.id, isCrewLeader: true }),
      members: [
        { assignmentId: record.id, displayName: 'Encargado Prueba', isLeader: true, attendance: {} },
        { assignmentId: 'TEST-ASSIGNMENT-A', displayName: 'Auxiliar Prueba A', isLeader: false, attendance: {} },
        { assignmentId: 'TEST-ASSIGNMENT-B', displayName: 'Auxiliar Prueba B', isLeader: false, attendance: { arrivalAt: NOW.toISOString() } }
      ]
    }]
  });
  assert.equal(projection.crewMembers.length, 3);
  const template = await readFile(new URL('../src/views/workerPortal.ejs', import.meta.url), 'utf8');
  const html = ejs.render(template, { mode: 'active', nonce: 'test', assignments: [projection], expiresAt: null });
  assert.match(html, /Encargado Prueba/);
  assert.match(html, /Tú · Encargado/);
  assert.match(html, /value="TEST-ASSIGNMENT-LEADER" data-crew-member/);
  assert.match(html, /Auxiliar Prueba A/);
  assert.match(html, /Auxiliar Prueba B/);
  assert.match(html, /Pendiente de entrada/);
  assert.match(html, /Entrada registrada/);
  assert.match(html, /data-crew-action="BREAK_START"/);
  assert.match(html, /data-crew-action="DEPARTURE"/);
  assert.doesNotMatch(html, /data-crew-load|data-crew-mark-type|Fuerza mayor/);
});

test('la selección PWA ofrece salida sin exigir almuerzo y respeta cada etapa', async () => {
  const member = (attendance = {}) => ({
    dataset: { arrival: '', breakStart: '', breakEnd: '', departure: '', ...attendance },
    checked: false,
    disabled: false,
    addEventListener(_name, callback) { this.onChange = callback; },
    closest() { return { querySelector: () => ({ replaceChildren() {} }) }; }
  });
  const pending = member();
  const arrived = member({ arrival: NOW.toISOString() });
  const buttons = ['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE'].map((mark) => ({
    dataset: { crewAction: mark }, hidden: true, addEventListener() {}
  }));
  const actions = { hidden: true };
  const status = { textContent: '' };
  const selectAll = { checked: false, addEventListener(_name, callback) { this.onChange = callback; } };
  const panel = {
    dataset: { crewManual: 'TEST-ASSIGNMENT-LEADER' },
    closest: () => ({ querySelector: () => ({ setAttribute() {} }) }),
    querySelector(selector) {
      return ({ '[data-crew-status]': status, '[data-crew-all]': selectAll, '[data-crew-actions]': actions })[selector];
    },
    querySelectorAll(selector) {
      return selector === '[data-crew-member]' ? [pending, arrived] : buttons;
    }
  };
  const source = await readFile(new URL('../src/public/worker-portal-crew-manual.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    document: { querySelectorAll: () => [panel] },
    navigator: { userAgent: 'PWA' },
    window: {}
  });
  const visible = () => buttons.filter((button) => !button.hidden).map((button) => button.dataset.crewAction);
  pending.checked = true;
  pending.onChange();
  assert.deepEqual(visible(), ['ARRIVAL']);
  arrived.checked = true;
  arrived.onChange();
  assert.deepEqual(visible(), []);
  pending.checked = false;
  pending.onChange();
  assert.deepEqual(visible(), ['BREAK_START', 'DEPARTURE']);
  arrived.dataset.breakStart = NOW.toISOString();
  arrived.onChange();
  assert.deepEqual(visible(), ['BREAK_END']);
  arrived.dataset.breakEnd = NOW.toISOString();
  arrived.onChange();
  assert.deepEqual(visible(), ['DEPARTURE']);
  selectAll.checked = true;
  selectAll.onChange();
  assert.equal(pending.checked, true);
  assert.equal(arrived.checked, true);
});
