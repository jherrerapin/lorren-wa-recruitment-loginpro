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

test('Web Bluetooth solo actúa como preflight online y no reemplaza GPS, biometría ni contingencia offline', async () => {
  const [loader, flow, route] = await Promise.all([
    readFile(new URL('../src/public/worker-biometric.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/public/worker-portal-biometric-flow.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/workerPortal.js', import.meta.url), 'utf8')
  ]);

  assert.match(loader, /navigator\.bluetooth\.requestDevice/);
  assert.match(loader, /filters:\s*\[\{ services:\s*\[protocol\.serviceUuid\] \}\]/);
  assert.match(loader, /getPrimaryService\(protocol\.serviceUuid\)/);
  assert.match(loader, /getCharacteristic\(protocol\.operationCharacteristicUuid\)/);
  assert.match(loader, /characteristic\.readValue\(\)/);
  assert.match(loader, /new TextDecoder\('utf-8'\)\.decode\(value\)\.trim\(\)/);
  assert.match(loader, /observedOperationPointId !== context\.operationPointId/);
  assert.match(loader, /requestDevice se invoca desde el click original/);
  assert.match(loader, /if \(!button \|\| button\.disabled \|\| !navigator\.onLine\) return;/);
  assert.doesNotMatch(loader, /watchAdvertisements|\brssi\b|\bRSSI\b/);

  assert.match(flow, /navigator\.geolocation\.getCurrentPosition/);
  assert.match(flow, /\/operaciones\/portal\/biometria\/\$\{path\}/);
  assert.match(flow, /form\.set\('captureMode', 'ONLINE_WEB'\)/);
  assert.match(route, /requireStrictAttendanceLocation/);
  assert.match(route, /biometric_verification_required/);
  assert.match(route, /captureMode === OFFLINE_WEB_CAPTURE_MODE/);
  assert.match(route, /requiresReview: captureMode === OFFLINE_WEB_CAPTURE_MODE/);
});
