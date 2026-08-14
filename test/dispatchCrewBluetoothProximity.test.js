import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CREW_ATTENDANCE_CONFIG_ACTION,
  CREW_ATTENDANCE_MODE,
  CREW_ATTENDANCE_OPERATION_ENTITY_TYPE,
  CREW_ATTENDANCE_SERVICE_ENTITY_TYPE,
  CREW_BLUETOOTH_OPERATION_CHARACTERISTIC_UUID,
  CREW_BLUETOOTH_SERVICE_UUID,
  loadCrewAttendancePortalContexts
} from '../src/modules/dispatch-attendance/application/crewAttendanceConfig.js';
import { registerCrewArrivalForLeader } from '../src/modules/dispatch-attendance/application/registerCrewArrival.js';

function fixture({
  workerId = 'TEST-WORKER-LEADER',
  leaderWorkerId = 'TEST-WORKER-LEADER',
  mode = CREW_ATTENDANCE_MODE.CREW,
  allowed = true,
  attendanceEnabled = true,
  operationActive = true
} = {}) {
  const assignment = {
    id: 'TEST-ASSIGNMENT-CREW-BT',
    workerId,
    serviceRequest: {
      id: 'TEST-SERVICE-CREW-BT',
      operationPointId: 'TEST-OP-CREW-BT',
      operationPoint: {
        id: 'TEST-OP-CREW-BT',
        isActive: operationActive,
        attendanceEnabled
      }
    }
  };
  const events = [
    {
      id: 'TEST-AUDIT-OP-BT',
      entityType: CREW_ATTENDANCE_OPERATION_ENTITY_TYPE,
      entityId: 'TEST-OP-CREW-BT',
      action: CREW_ATTENDANCE_CONFIG_ACTION,
      metadata: { allowed },
      createdAt: new Date('2026-08-14T12:00:00.000Z')
    },
    {
      id: 'TEST-AUDIT-SERVICE-BT',
      entityType: CREW_ATTENDANCE_SERVICE_ENTITY_TYPE,
      entityId: 'TEST-SERVICE-CREW-BT',
      action: CREW_ATTENDANCE_CONFIG_ACTION,
      metadata: { mode, crewLeaderWorkerId: mode === CREW_ATTENDANCE_MODE.CREW ? leaderWorkerId : null },
      createdAt: new Date('2026-08-14T12:01:00.000Z')
    }
  ];
  const prisma = {
    dispatchAssignment: {
      async findMany({ where }) {
        return where.workerId === workerId ? [{ ...assignment }] : [];
      }
    },
    devAuditEvent: {
      async findMany({ where }) {
        return events
          .filter((event) => event.entityType === where.entityType)
          .filter((event) => where.entityId?.in?.includes(event.entityId))
          .filter((event) => event.action === where.action)
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
      }
    }
  };
  return { prisma, workerId };
}

function crewLeaderContext(overrides = {}) {
  return {
    assignmentId: 'TEST-ASSIGNMENT-LEADER',
    serviceRequestId: 'TEST-SERVICE-GROUP',
    operationPointId: 'TEST-OP-GROUP',
    mode: CREW_ATTENDANCE_MODE.CREW,
    isCrewLeader: true,
    crewAvailable: true,
    proximityRequired: true,
    ...overrides
  };
}

function registeredArrival({ assignmentId, validationStatus = 'REVIEW_REQUIRED', replayed = false } = {}) {
  return {
    recorded: true,
    replayed,
    attendanceSession: {
      id: `TEST-SESSION-${assignmentId}`,
      validationStatus,
      attendanceStatus: validationStatus === 'AUTO_VALIDATED' ? 'ON_TIME' : 'ARRIVAL_REPORTED'
    },
    validation: {
      validationStatus,
      attendanceStatus: validationStatus === 'AUTO_VALIDATED' ? 'ON_TIME' : 'ARRIVAL_REPORTED',
      reportedPunctuality: 'ON_TIME',
      riskFlags: validationStatus === 'AUTO_VALIDATED'
        ? []
        : ['UNAUTHORIZED_DEVICE', 'SHARED_DEVICE_SIGNAL']
    }
  };
}

test('el responsable de una cuadrilla disponible requiere preflight Bluetooth', async () => {
  const { prisma, workerId } = fixture();
  const contexts = await loadCrewAttendancePortalContexts(prisma, { workerId });

  assert.equal(contexts.length, 1);
  assert.deepEqual(contexts[0], {
    assignmentId: 'TEST-ASSIGNMENT-CREW-BT',
    serviceRequestId: 'TEST-SERVICE-CREW-BT',
    operationPointId: 'TEST-OP-CREW-BT',
    mode: CREW_ATTENDANCE_MODE.CREW,
    isCrewLeader: true,
    crewAvailable: true,
    proximityRequired: true
  });
  assert.match(CREW_BLUETOOTH_SERVICE_UUID, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.match(CREW_BLUETOOTH_OPERATION_CHARACTERISTIC_UUID, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.notEqual(CREW_BLUETOOTH_SERVICE_UUID, CREW_BLUETOOTH_OPERATION_CHARACTERISTIC_UUID);
});

test('un auxiliar de la misma cuadrilla que no es responsable conserva el flujo individual vigente', async () => {
  const { prisma, workerId } = fixture({
    workerId: 'TEST-WORKER-MEMBER',
    leaderWorkerId: 'TEST-WORKER-LEADER'
  });
  const [context] = await loadCrewAttendancePortalContexts(prisma, { workerId });

  assert.equal(context.mode, CREW_ATTENDANCE_MODE.CREW);
  assert.equal(context.isCrewLeader, false);
  assert.equal(context.crewAvailable, true);
  assert.equal(context.proximityRequired, false);
});

test('el kill switch de la operación elimina el requisito Bluetooth sin borrar el modo histórico', async () => {
  const { prisma, workerId } = fixture({ allowed: false });
  const [context] = await loadCrewAttendancePortalContexts(prisma, { workerId });

  assert.equal(context.mode, CREW_ATTENDANCE_MODE.CREW);
  assert.equal(context.isCrewLeader, true);
  assert.equal(context.crewAvailable, false);
  assert.equal(context.proximityRequired, false);
});

test('un servicio Individual nunca exige Bluetooth aunque el trabajador hubiera sido líder', async () => {
  const { prisma, workerId } = fixture({ mode: CREW_ATTENDANCE_MODE.INDIVIDUAL });
  const [context] = await loadCrewAttendancePortalContexts(prisma, { workerId });

  assert.equal(context.mode, CREW_ATTENDANCE_MODE.INDIVIDUAL);
  assert.equal(context.isCrewLeader, false);
  assert.equal(context.proximityRequired, false);
});

test('el contexto del portal deriva el trabajador de la sesión y expone solo el protocolo necesario', async () => {
  const route = await readFile(new URL('../src/routes/workerPortal.js', import.meta.url), 'utf8');

  assert.match(route, /\/cuadrillas\/proximidad\/contexto/);
  assert.match(route, /loadCrewPortalContextsFn\(\{ workerId: portalSession\.workerId \}\)/);
  assert.doesNotMatch(route, /loadCrewPortalContextsFn\(\{ workerId: req\.body/);
  assert.match(route, /serviceUuid: CREW_BLUETOOTH_SERVICE_UUID/);
  assert.match(route, /operationCharacteristicUuid: CREW_BLUETOOTH_OPERATION_CHARACTERISTIC_UUID/);
});

test('la llegada grupal deriva los integrantes del servicio y conserva el dispositivo del responsable como evidencia', async () => {
  const registerCalls = [];
  const reviews = [];
  const members = [
    { id: 'TEST-ASSIGNMENT-LEADER', workerId: 'TEST-WORKER-LEADER' },
    { id: 'TEST-ASSIGNMENT-MEMBER-A', workerId: 'TEST-WORKER-A' },
    { id: 'TEST-ASSIGNMENT-MEMBER-B', workerId: 'TEST-WORKER-B' }
  ];
  const prisma = {
    dispatchAssignment: {
      async findMany({ where }) {
        assert.equal(where.serviceRequestId, 'TEST-SERVICE-GROUP');
        return members;
      }
    }
  };

  const result = await registerCrewArrivalForLeader(prisma, {
    leaderWorkerId: 'TEST-WORKER-LEADER',
    assignmentId: 'TEST-ASSIGNMENT-LEADER',
    idempotencyKey: 'TEST-GROUP-IDEMPOTENCY-0001',
    now: new Date('2026-08-14T13:00:00.000Z'),
    captureMode: 'ONLINE_WEB',
    clientCapturedAt: new Date('2026-08-14T13:00:00.000Z'),
    latitude: 4.6,
    longitude: -74.1,
    accuracyMeters: 12,
    installationIdHash: 'TEST-INSTALLATION-HASH',
    ipAddress: 'TEST-IP',
    userAgent: 'TEST-UA',
    forceMajeure: true
  }, {
    loadCrewContextsFn: async (_client, input) => {
      assert.equal(input.workerId, 'TEST-WORKER-LEADER');
      return [crewLeaderContext()];
    },
    registerArrivalFn: async (_client, input) => {
      registerCalls.push(input);
      return registeredArrival({
        assignmentId: input.assignmentId,
        validationStatus: input.assignmentId === 'TEST-ASSIGNMENT-LEADER'
          ? 'AUTO_VALIDATED'
          : 'REVIEW_REQUIRED'
      });
    },
    reviewAttendanceFn: async (_client, input) => {
      reviews.push(input);
      return { validationStatus: 'MANUAL_VALIDATED' };
    }
  });

  assert.equal(result.applied, true);
  assert.equal(result.summary.totalMembers, 3);
  assert.equal(result.summary.newlyRecordedCount, 3);
  assert.equal(result.summary.delegatedCount, 2);
  assert.equal(result.summary.reviewPendingCount, 0);
  assert.equal(result.summary.forceMajeure, true);

  assert.equal(registerCalls.length, 3);
  assert.deepEqual(registerCalls.map((call) => call.expectedWorkerId), [
    'TEST-WORKER-LEADER',
    'TEST-WORKER-A',
    'TEST-WORKER-B'
  ]);
  assert.ok(registerCalls.every((call) => call.installationIdHash === 'TEST-INSTALLATION-HASH'));
  assert.ok(registerCalls.every((call) => call.hasFreshPhoto === false));
  assert.ok(registerCalls.every((call) => call.evidenceStorageKey === null && call.evidenceMimeType === null));
  assert.equal(registerCalls[0].idempotencyKey, 'TEST-GROUP-IDEMPOTENCY-0001');
  assert.match(registerCalls[1].idempotencyKey, /^crew_[0-9a-f]{48}$/);
  assert.match(registerCalls[2].idempotencyKey, /^crew_[0-9a-f]{48}$/);
  assert.notEqual(registerCalls[1].idempotencyKey, registerCalls[2].idempotencyKey);

  assert.equal(reviews.length, 2);
  assert.ok(reviews.every((review) => review.actorUsername === 'worker-portal:TEST-WORKER-LEADER'));
  assert.ok(reviews.every((review) => review.actorRole === 'crew-leader'));
  assert.ok(reviews.every((review) => /Fuerza mayor/i.test(review.reason)));
  assert.ok(reviews.every((review) => /No se solicitó reconocimiento facial/i.test(review.notes)));
  assert.ok(reviews.every((review) => /lectura Bluetooth consistente/i.test(review.notes)));
});

test('un integrante que no es responsable no puede activar el fan-out de llegada', async () => {
  let assignmentsRead = 0;
  let arrivalsWritten = 0;
  const prisma = {
    dispatchAssignment: {
      async findMany() {
        assignmentsRead += 1;
        return [];
      }
    }
  };

  const result = await registerCrewArrivalForLeader(prisma, {
    leaderWorkerId: 'TEST-WORKER-MEMBER',
    assignmentId: 'TEST-ASSIGNMENT-MEMBER',
    idempotencyKey: 'TEST-GROUP-IDEMPOTENCY-0002',
    now: new Date('2026-08-14T13:00:00.000Z'),
    captureMode: 'ONLINE_WEB'
  }, {
    loadCrewContextsFn: async () => [crewLeaderContext({
      assignmentId: 'TEST-ASSIGNMENT-MEMBER',
      isCrewLeader: false,
      proximityRequired: false
    })],
    registerArrivalFn: async () => {
      arrivalsWritten += 1;
      return registeredArrival({ assignmentId: 'TEST-ASSIGNMENT-MEMBER' });
    },
    reviewAttendanceFn: async () => ({})
  });

  assert.deepEqual(result, { applied: false });
  assert.equal(assignmentsRead, 0);
  assert.equal(arrivalsWritten, 0);
});

test('un dispositivo del responsable pendiente de revisión detiene la marcación del resto de la cuadrilla', async () => {
  const registerCalls = [];
  const members = [
    { id: 'TEST-ASSIGNMENT-LEADER', workerId: 'TEST-WORKER-LEADER' },
    { id: 'TEST-ASSIGNMENT-MEMBER-A', workerId: 'TEST-WORKER-A' }
  ];
  const prisma = {
    dispatchAssignment: {
      async findMany() { return members; }
    }
  };

  const result = await registerCrewArrivalForLeader(prisma, {
    leaderWorkerId: 'TEST-WORKER-LEADER',
    assignmentId: 'TEST-ASSIGNMENT-LEADER',
    idempotencyKey: 'TEST-GROUP-IDEMPOTENCY-DEVICE',
    now: new Date('2026-08-14T13:00:00.000Z'),
    captureMode: 'ONLINE_WEB',
    installationIdHash: 'TEST-UNAUTHORIZED-INSTALLATION'
  }, {
    loadCrewContextsFn: async () => [crewLeaderContext()],
    registerArrivalFn: async (_client, input) => {
      registerCalls.push(input);
      return registeredArrival({ assignmentId: input.assignmentId, validationStatus: 'REVIEW_REQUIRED' });
    },
    reviewAttendanceFn: async () => {
      throw new Error('TEST-REVIEW-SHOULD-NOT-RUN');
    }
  });

  assert.equal(result.applied, true);
  assert.equal(result.summary, null);
  assert.equal(result.leaderResult.validation.validationStatus, 'REVIEW_REQUIRED');
  assert.equal(registerCalls.length, 1);
  assert.equal(registerCalls[0].expectedWorkerId, 'TEST-WORKER-LEADER');
});

test('una llegada histórica distinta del responsable no autoriza una nueva marcación grupal', async () => {
  const registerCalls = [];
  const members = [
    { id: 'TEST-ASSIGNMENT-LEADER', workerId: 'TEST-WORKER-LEADER' },
    { id: 'TEST-ASSIGNMENT-MEMBER-A', workerId: 'TEST-WORKER-A' }
  ];
  const prisma = {
    dispatchAssignment: {
      async findMany() { return members; }
    }
  };

  const result = await registerCrewArrivalForLeader(prisma, {
    leaderWorkerId: 'TEST-WORKER-LEADER',
    assignmentId: 'TEST-ASSIGNMENT-LEADER',
    idempotencyKey: 'TEST-GROUP-IDEMPOTENCY-NEW',
    now: new Date('2026-08-14T13:00:00.000Z'),
    captureMode: 'ONLINE_WEB',
    installationIdHash: 'TEST-INSTALLATION-HASH'
  }, {
    loadCrewContextsFn: async () => [crewLeaderContext()],
    registerArrivalFn: async (_client, input) => {
      registerCalls.push(input);
      return {
        recorded: false,
        replayed: false,
        attendanceSession: {
          id: 'TEST-SESSION-HISTORICAL',
          validationStatus: 'AUTO_VALIDATED',
          attendanceStatus: 'ON_TIME'
        },
        validation: {
          validationStatus: 'REJECTED',
          reportedPunctuality: 'ON_TIME',
          riskFlags: ['DUPLICATE_ARRIVAL']
        }
      };
    },
    reviewAttendanceFn: async () => {
      throw new Error('TEST-REVIEW-SHOULD-NOT-RUN');
    }
  });

  assert.equal(result.applied, true);
  assert.equal(result.summary, null);
  assert.equal(result.leaderResult.recorded, false);
  assert.equal(registerCalls.length, 1);
});

test('una falla de revisión no borra una llegada delegada ya registrada', async () => {
  const members = [
    { id: 'TEST-ASSIGNMENT-LEADER', workerId: 'TEST-WORKER-LEADER' },
    { id: 'TEST-ASSIGNMENT-MEMBER-A', workerId: 'TEST-WORKER-A' }
  ];
  const prisma = {
    dispatchAssignment: {
      async findMany() { return members; }
    }
  };

  const result = await registerCrewArrivalForLeader(prisma, {
    leaderWorkerId: 'TEST-WORKER-LEADER',
    assignmentId: 'TEST-ASSIGNMENT-LEADER',
    idempotencyKey: 'TEST-GROUP-IDEMPOTENCY-0003',
    now: new Date('2026-08-14T13:00:00.000Z'),
    captureMode: 'ONLINE_WEB',
    installationIdHash: 'TEST-INSTALLATION-HASH'
  }, {
    loadCrewContextsFn: async () => [crewLeaderContext()],
    registerArrivalFn: async (_client, input) => registeredArrival({
      assignmentId: input.assignmentId,
      validationStatus: input.assignmentId === 'TEST-ASSIGNMENT-LEADER'
        ? 'AUTO_VALIDATED'
        : 'REVIEW_REQUIRED'
    }),
    reviewAttendanceFn: async () => { throw new Error('TEST-REVIEW-FAILURE'); }
  });

  assert.equal(result.summary.newlyRecordedCount, 2);
  assert.equal(result.summary.failedCount, 0);
  assert.equal(result.summary.reviewPendingCount, 1);
  const delegated = result.summary.results.find((item) => item.assignmentId === 'TEST-ASSIGNMENT-MEMBER-A');
  assert.equal(delegated.status, 'RECORDED');
  assert.equal(delegated.pendingReview, true);
});

test('la llegada grupal usa Bluetooth y GPS sin abrir reconocimiento facial, mientras la llegada individual conserva biometría', async () => {
  const [loader, flow, route, core] = await Promise.all([
    readFile(new URL('../src/public/worker-biometric.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/public/worker-portal-biometric-flow.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/workerPortal.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/workerPortalCore.js', import.meta.url), 'utf8')
  ]);

  assert.match(loader, /navigator\.bluetooth\.requestDevice/);
  assert.match(loader, /filters:\s*\[\{ services:\s*\[protocol\.serviceUuid\] \}\]/);
  assert.match(loader, /getPrimaryService\(protocol\.serviceUuid\)/);
  assert.match(loader, /getCharacteristic\(protocol\.operationCharacteristicUuid\)/);
  assert.match(loader, /characteristic\.readValue\(\)/);
  assert.match(loader, /observedOperationPointId !== context\.operationPointId/);
  assert.match(loader, /Marcar llegada de toda la cuadrilla/);
  assert.match(loader, /Completar llegada de la cuadrilla/);
  assert.match(loader, /Marcar cuadrilla sin rostro/);
  assert.match(loader, /Fuerza mayor: uno o más auxiliares están sin celular/);
  assert.match(loader, /const CREW_IDEMPOTENCY_PREFIX = 'lorren-crew-arrival:'/);
  assert.match(loader, /const CREW_FORCE_MAJEURE_PREFIX = 'lorren-crew-force-majeure:'/);
  assert.match(loader, /window\.sessionStorage\.setItem\(crewStorageKey\(assignmentId\), created\)/);
  assert.match(loader, /window\.sessionStorage\.setItem\(crewForceMajeureStorageKey\(assignmentId\), value \? 'true' : 'false'\)/);
  assert.match(loader, /storedCrewForceMajeure\(assignmentId\)/);
  assert.match(loader, /clearCrewAttempt\(context\.assignmentId\)/);
  assert.match(loader, /payload\.requiresReview === true/);
  assert.match(loader, /arrival_already_registered/);
  assert.match(loader, /button\.dataset\.crewBusy = 'true'/);
  assert.match(loader, /button\.dataset\.crewBusy === 'true'/);
  assert.match(loader, /requestCrewLocation/);
  assert.match(loader, /X-Lorren-Crew-Group': 'true'/);
  assert.match(loader, /X-Lorren-Crew-Operation-Point-Id': observedOperationPointId/);
  assert.match(loader, /La llegada grupal no requiere reconocimiento facial/);
  const groupSubmit = loader.slice(
    loader.indexOf('async function submitCrewGroupArrival'),
    loader.indexOf("document.addEventListener('click'", loader.indexOf('async function submitCrewGroupArrival'))
  );
  assert.doesNotMatch(groupSubmit, /selfie|photoConsent|biometria\/verificar/);

  assert.match(route, /requestedCrewGroup/);
  assert.match(route, /crewContext\.isCrewLeader !== true/);
  assert.match(route, /observedOperationPointId !== crewContext\.operationPointId/);
  assert.match(route, /captureMode === ONLINE_WEB_CAPTURE_MODE && !requestedCrewGroup/);
  assert.match(route, /req\.lorrenCrewGroup = true/);
  assert.match(route, /requireStrictAttendanceLocation/);

  assert.match(core, /const isCrewGroupArrival = isArrival && req\.lorrenCrewGroup === true/);
  assert.match(core, /!isCrewGroupArrival && assignment\.photoRequired/);
  assert.match(core, /crew_group_selfie_not_allowed/);
  assert.match(core, /forceMajeure: req\.lorrenCrewForceMajeure === true/);
  assert.match(core, /crew_group_not_available/);

  assert.match(flow, /navigator\.geolocation\.getCurrentPosition/);
  assert.match(flow, /\/operaciones\/portal\/biometria\/\$\{path\}/);
  assert.match(flow, /form\.set\('captureMode', 'ONLINE_WEB'\)/);
  assert.match(route, /biometric_verification_required/);
  assert.match(route, /captureMode === OFFLINE_WEB_CAPTURE_MODE/);
  assert.match(route, /requiresReview: captureMode === OFFLINE_WEB_CAPTURE_MODE/);
});
