import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DISPATCH_TEST_GEOFENCE_BYPASS_ACTION,
  DISPATCH_TEST_GEOFENCE_BYPASS_RADIUS_SENTINEL_METERS,
  applyDispatchTestGeofenceBypassToAssignment,
  getDispatchTestGeofenceBypassStatus,
  isDispatchTestGeofenceBypassEnabled,
  setDispatchTestGeofenceBypass
} from '../src/services/dispatchTestGeofenceBypass.js';

function fakePrisma({ clientIsTest = true, latestAction = null } = {}) {
  const events = [];
  if (latestAction) events.push({ action: latestAction });
  return {
    events,
    dispatchOperationPoint: {
      async findFirst() {
        return {
          id: 'operation-test',
          name: 'Operación de prueba',
          client: { id: 'client-test', isTestClient: clientIsTest }
        };
      }
    },
    devAuditEvent: {
      async findFirst() { return events.at(-1) || null; },
      async create({ data }) {
        events.push(data);
        return data;
      }
    }
  };
}

function testAssignment({ workerIsTest = true, clientIsTest = true } = {}) {
  return {
    id: 'assignment-test',
    workerId: 'worker-test',
    worker: { isTestProfile: workerIsTest },
    serviceRequest: {
      operationPoint: {
        id: 'operation-test',
        clientId: 'client-test',
        geofenceRadiusMeters: 100,
        maxLocationAccuracyMeters: 50,
        client: { isTestClient: clientIsTest }
      }
    }
  };
}


test('un cliente real no puede habilitar la excepción de ubicación', async () => {
  const prisma = fakePrisma({ clientIsTest: false });
  const status = await getDispatchTestGeofenceBypassStatus(prisma, {
    clientId: 'client-real',
    operationPointId: 'operation-real'
  });
  assert.equal(status.eligible, false);
  await assert.rejects(() => setDispatchTestGeofenceBypass(prisma, {
    clientId: 'client-real',
    operationPointId: 'operation-real',
    enabled: true,
    actorUsername: 'dev'
  }), /dispatch_test_geofence_bypass_not_allowed/);
});


test('DEV puede habilitar y deshabilitar la excepción auditada en una operación de prueba', async () => {
  const prisma = fakePrisma();
  const enabled = await setDispatchTestGeofenceBypass(prisma, {
    clientId: 'client-test',
    operationPointId: 'operation-test',
    enabled: true,
    actorUsername: 'dev',
    actorRole: 'dev'
  });
  assert.equal(enabled.enabled, true);
  assert.equal(prisma.events.at(-1).action, DISPATCH_TEST_GEOFENCE_BYPASS_ACTION.ENABLED);

  const disabled = await setDispatchTestGeofenceBypass(prisma, {
    clientId: 'client-test',
    operationPointId: 'operation-test',
    enabled: false,
    actorUsername: 'dev',
    actorRole: 'dev'
  });
  assert.equal(disabled.enabled, false);
  assert.equal(prisma.events.at(-1).action, DISPATCH_TEST_GEOFENCE_BYPASS_ACTION.DISABLED);
});


test('la excepción efectiva exige simultáneamente cliente y auxiliar de prueba', async () => {
  const prisma = fakePrisma({ latestAction: DISPATCH_TEST_GEOFENCE_BYPASS_ACTION.ENABLED });
  assert.equal(await isDispatchTestGeofenceBypassEnabled(prisma, {
    operationPointId: 'operation-test', clientIsTest: true, workerIsTest: true
  }), true);
  assert.equal(await isDispatchTestGeofenceBypassEnabled(prisma, {
    operationPointId: 'operation-test', clientIsTest: false, workerIsTest: true
  }), false);
  assert.equal(await isDispatchTestGeofenceBypassEnabled(prisma, {
    operationPointId: 'operation-test', clientIsTest: true, workerIsTest: false
  }), false);
});


test('solo la triple condición reemplaza temporalmente la geocerca', async () => {
  const prisma = fakePrisma({ latestAction: DISPATCH_TEST_GEOFENCE_BYPASS_ACTION.ENABLED });
  const applied = await applyDispatchTestGeofenceBypassToAssignment(prisma, testAssignment());
  assert.equal(applied.serviceRequest.operationPoint.geofenceRadiusMeters, DISPATCH_TEST_GEOFENCE_BYPASS_RADIUS_SENTINEL_METERS);
  assert.equal(applied.serviceRequest.operationPoint.maxLocationAccuracyMeters, 100_000);
  assert.equal(applied.serviceRequest.operationPoint.testGeofenceBypassEnabled, true);

  const realWorker = await applyDispatchTestGeofenceBypassToAssignment(prisma, testAssignment({ workerIsTest: false }));
  assert.equal(realWorker.serviceRequest.operationPoint.geofenceRadiusMeters, 100);
  const realClient = await applyDispatchTestGeofenceBypassToAssignment(prisma, testAssignment({ clientIsTest: false }));
  assert.equal(realClient.serviceRequest.operationPoint.geofenceRadiusMeters, 100);
});


test('rutas, interfaz y Prisma mantienen la excepción fuera del celular del auxiliar', () => {
  const route = fs.readFileSync('src/routes/dispatchAttendancePointConfig.js', 'utf8');
  const ui = fs.readFileSync('src/public/attendance-test-geofence-bypass.js', 'utf8');
  const loader = fs.readFileSync('src/public/attendance-admin-runtime.js', 'utf8');
  const prisma = fs.readFileSync('src/lib/prisma.js', 'utf8');
  const distance = fs.readFileSync('src/modules/dispatch-attendance/domain/attendanceDistance.js', 'utf8');

  assert.match(route, /currentRole\(req\) === 'dev'/);
  assert.match(route, /x-requested-with/);
  assert.match(route, /prueba-geocerca/);
  assert.match(ui, /Solo aplica al cliente, operación y auxiliar marcados como prueba/);
  assert.match(loader, /attendance-test-geofence-bypass\.js/);
  assert.match(prisma, /isTestProfile/);
  assert.match(prisma, /isTestClient/);
  assert.match(prisma, /isDispatchTestGeofenceBypassEnabled/);
  assert.match(distance, /ATTENDANCE_TEST_GEOFENCE_BYPASS_RADIUS_SENTINEL_METERS/);
});
