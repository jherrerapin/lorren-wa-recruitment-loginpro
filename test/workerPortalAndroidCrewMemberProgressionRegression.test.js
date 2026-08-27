import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerCrewArrivalForLeader } from '../src/modules/dispatch-attendance/application/registerCrewArrival.js';

function read(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

function sliceFunctionBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0, `falta ${startMarker}`);
  assert.ok(end > start, `falta cierre para ${startMarker}`);
  return source.slice(start, end);
}

test('replay seudonimizado: auxiliar sin entrada no avanza visualmente a almuerzo', async () => {
  const nativePresence = await read('mobile/android/app/src/main/assets/native-presence.js');

  const normalizeSource = sliceFunctionBlock(
    nativePresence,
    'function normalizeMarkType(value)',
    '\n  function markInfo'
  );
  const projectionSource = sliceFunctionBlock(
    nativePresence,
    'function persistedMarkAt(member, markType)',
    '\n  function formatPersistedMarkTime'
  );
  const helpers = Function(`
    const MARK_TYPES = new Set(['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE']);
    ${normalizeSource}
    ${projectionSource}
    return { memberEligibleForMark, memberPresentationMarkType };
  `)();

  const auxiliaryWithArrival = {
    isLeader: false,
    attendance: {
      arrivalAt: '2026-08-26T23:01:00.000Z',
      breakStartAt: null,
      breakEndAt: null,
      departureAt: null
    }
  };
  const auxiliaryWithoutArrival = {
    isLeader: false,
    attendance: {
      arrivalAt: null,
      breakStartAt: null,
      breakEndAt: null,
      departureAt: null
    }
  };

  assert.equal(helpers.memberPresentationMarkType(auxiliaryWithArrival, 'BREAK_START'), 'BREAK_START');
  assert.equal(helpers.memberEligibleForMark(auxiliaryWithArrival, 'BREAK_START'), true);
  assert.equal(helpers.memberPresentationMarkType(auxiliaryWithoutArrival, 'BREAK_START'), 'ARRIVAL');
  assert.equal(helpers.memberEligibleForMark(auxiliaryWithoutArrival, 'BREAK_START'), false);

  const expectedCountSource = sliceFunctionBlock(
    nativePresence,
    'function expectedAuxiliaryProofCount(context, markType)',
    '\n  function pendingAuxiliaryCount'
  );
  assert.doesNotMatch(expectedCountSource, /memberEligibleForMark/);

  const pendingCountSource = sliceFunctionBlock(
    nativePresence,
    'function pendingAuxiliaryCount(context, markType)',
    '\n  function memberStatusPresentation'
  );
  assert.match(pendingCountSource, /memberEligibleForMark\(member, markType\)/);

  const renderSource = sliceFunctionBlock(
    nativePresence,
    'function renderCrewMembers(panel, context, markType)',
    '\n  function randomToken'
  );
  assert.match(renderSource, /memberPresentationMarkType\(member, normalizedMark\)/);
  assert.match(renderSource, /memberStatus\(context, member, memberMarkType\)/);
  assert.match(renderSource, /memberStatusPresentation\(status, memberMarkType\)/);
  assert.match(renderSource, /memberMarkType === 'ARRIVAL'[\s\S]{0,180}Marcar entrada/);
  assert.match(renderSource, /memberMarkType === 'ARRIVAL'[\s\S]{0,520}Reportar sin teléfono/);
});

test('llegada tardía dirigida procesa solo encargado y auxiliar faltante sin atribuirle el dispositivo del encargado', async () => {
  const arrivalCalls = [];
  const reviewCalls = [];
  const prisma = {
    dispatchAssignment: {
      async findMany() {
        return [
          {
            id: 'TEST-ASSIGNMENT-LEADER',
            workerId: 'TEST-WORKER-LEADER',
            attendanceSession: { arrivalReportedAt: new Date('2026-08-26T23:01:00.000Z') }
          },
          {
            id: 'TEST-ASSIGNMENT-A',
            workerId: 'TEST-WORKER-A',
            attendanceSession: { arrivalReportedAt: new Date('2026-08-26T23:01:20.000Z') }
          },
          {
            id: 'TEST-ASSIGNMENT-B',
            workerId: 'TEST-WORKER-B',
            attendanceSession: null
          }
        ];
      }
    }
  };

  const result = await registerCrewArrivalForLeader(prisma, {
    leaderWorkerId: 'TEST-WORKER-LEADER',
    assignmentId: 'TEST-ASSIGNMENT-LEADER',
    manualTargetAssignmentId: 'TEST-ASSIGNMENT-B',
    idempotencyKey: 'TEST-MANUAL-ARRIVAL-001',
    now: new Date('2026-08-26T23:07:00.000Z'),
    captureMode: 'ONLINE_WEB',
    clientCapturedAt: '2026-08-26T23:06:58.000Z',
    latitude: 4.6,
    longitude: -74.1,
    accuracyMeters: 18,
    installationIdHash: 'TEST-LEADER-INSTALLATION',
    persistentStorageAvailable: true,
    presenceValidated: false,
    forceMajeure: false
  }, {
    loadCrewContextsFn: async () => [{
      assignmentId: 'TEST-ASSIGNMENT-LEADER',
      serviceRequestId: 'TEST-SERVICE-CREW',
      mode: 'CREW',
      isCrewLeader: true,
      crewAvailable: true
    }],
    registerArrivalFn: async (_client, input) => {
      arrivalCalls.push(input);
      if (input.assignmentId === 'TEST-ASSIGNMENT-LEADER') {
        return {
          recorded: false,
          replayed: false,
          validation: {
            validationStatus: 'REJECTED',
            riskFlags: ['DUPLICATE_ARRIVAL']
          }
        };
      }
      if (input.assignmentId !== 'TEST-ASSIGNMENT-B') {
        throw new Error('TEST-UNEXPECTED-AUXILIARY');
      }
      return {
        recorded: true,
        replayed: false,
        attendanceSession: {
          id: 'TEST-SESSION-B',
          validationStatus: 'REVIEW_REQUIRED'
        },
        validation: {
          validationStatus: 'REVIEW_REQUIRED',
          reportedPunctuality: 'LATE',
          riskFlags: ['UNAUTHORIZED_DEVICE']
        }
      };
    },
    reviewAttendanceFn: async (_client, input) => {
      reviewCalls.push(input);
      return { reviewed: true };
    }
  });

  assert.deepEqual(arrivalCalls.map((call) => call.assignmentId), [
    'TEST-ASSIGNMENT-LEADER',
    'TEST-ASSIGNMENT-B'
  ]);
  assert.equal(arrivalCalls.some((call) => call.assignmentId === 'TEST-ASSIGNMENT-A'), false);
  assert.equal(arrivalCalls[0].installationIdHash, 'TEST-LEADER-INSTALLATION');
  assert.equal(arrivalCalls[1].installationIdHash, null);
  assert.equal(reviewCalls.length, 1);
  assert.match(reviewCalls[0].reason, /Llegada tardía delegada/);
  assert.equal(result.summary.manualTargetAssignmentId, 'TEST-ASSIGNMENT-B');
  assert.deepEqual(result.summary.results.map((item) => [item.assignmentId, item.status]), [
    ['TEST-ASSIGNMENT-LEADER', 'ALREADY_RECORDED'],
    ['TEST-ASSIGNMENT-B', 'RECORDED']
  ]);
});

test('llegada tardía no se habilita si el encargado todavía no tiene entrada persistida', async () => {
  const prisma = {
    dispatchAssignment: {
      async findMany() {
        return [
          {
            id: 'TEST-ASSIGNMENT-LEADER',
            workerId: 'TEST-WORKER-LEADER',
            attendanceSession: null
          },
          {
            id: 'TEST-ASSIGNMENT-B',
            workerId: 'TEST-WORKER-B',
            attendanceSession: null
          }
        ];
      }
    }
  };

  await assert.rejects(
    () => registerCrewArrivalForLeader(prisma, {
      leaderWorkerId: 'TEST-WORKER-LEADER',
      assignmentId: 'TEST-ASSIGNMENT-LEADER',
      manualTargetAssignmentId: 'TEST-ASSIGNMENT-B',
      idempotencyKey: 'TEST-MANUAL-ARRIVAL-002',
      now: new Date('2026-08-26T23:07:00.000Z'),
      captureMode: 'ONLINE_WEB',
      latitude: 4.6,
      longitude: -74.1,
      accuracyMeters: 18,
      presenceValidated: false
    }, {
      loadCrewContextsFn: async () => [{
        assignmentId: 'TEST-ASSIGNMENT-LEADER',
        serviceRequestId: 'TEST-SERVICE-CREW',
        mode: 'CREW',
        isCrewLeader: true,
        crewAvailable: true
      }]
    }),
    /crew_group_arrival_manual_leader_arrival_required/
  );
});

test('entrada manual reutiliza ubicación nativa existente y no inicia un scan Bluetooth nuevo', async () => {
  const [nativePresence, route, bridge] = await Promise.all([
    read('mobile/android/app/src/main/assets/native-presence.js'),
    read('src/routes/workerPortal.js'),
    read('mobile/android/app/src/main/java/com/loginpro/lorren/portal/PresenceBridge.java')
  ]);

  const manualSource = sliceFunctionBlock(
    nativePresence,
    'async function startManualArrival(member)',
    '\n  function publicNativeError'
  );
  assert.match(manualSource, /bridgeCall\('requestAttendanceLocation'/);
  assert.match(manualSource, /MANUAL_ARRIVAL_PATH/);
  assert.doesNotMatch(manualSource, /startCrewScan/);

  assert.match(bridge, /requestAttendanceLocation\(String inputJson\)/);
  assert.match(bridge, /"attendance_location_ready"/);

  const routeSource = sliceFunctionBlock(
    route,
    "router.post('/cuadrillas/presencia/entrada-manual'",
    "\n  router.post('/cuadrillas/presencia/sincronizar'"
  );
  assert.match(routeSource, /requireNativeAttendanceLocation/);
  assert.match(routeSource, /requireStrictAttendanceLocation/);
  assert.match(routeSource, /allowCrossOperation: false/);
  assert.match(routeSource, /manualTargetAssignmentId: targetAssignmentId/);
  assert.match(routeSource, /installationIdHash: null/);
  assert.match(routeSource, /registerCrewPresenceArrivalFn/);
  assert.doesNotMatch(routeSource, /registerDispatchArrival/);
});
