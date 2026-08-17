import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadCrewAttendancePortalContexts } from '../src/modules/dispatch-attendance/application/crewAttendanceConfig.js';

const ROOT = new URL('../', import.meta.url);

function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

test('el contexto de cuadrilla expone una referencia estable del servicio y conserva al encargado como integrante', async () => {
  const leaderWorkerId = 'TEST-WORKER-LEADER';
  const auxiliaryWorkerId = 'TEST-WORKER-AUX';
  const serviceRequestId = 'TEST-SERVICE-01';
  const operationPointId = 'TEST-OPERATION-01';
  const createdAt = new Date('2026-08-17T12:00:00.000Z');
  const service = {
    id: serviceRequestId,
    operationPointId,
    operationPointName: 'Operación Prueba',
    serviceDate: new Date('2026-08-17T00:00:00.000Z'),
    startTime: '08:00',
    endTime: '17:00',
    createdAt,
    operationPoint: { id: operationPointId, isActive: true, attendanceEnabled: true },
    assignments: [
      {
        id: 'TEST-ASSIGNMENT-LEADER',
        workerId: leaderWorkerId,
        worker: { fullName: 'Persona Prueba Encargada' },
        attendanceSession: null
      },
      {
        id: 'TEST-ASSIGNMENT-AUX',
        workerId: auxiliaryWorkerId,
        worker: { fullName: 'Persona Prueba Auxiliar' },
        attendanceSession: null
      }
    ]
  };
  const prisma = {
    dispatchAssignment: {
      findMany: async () => [{
        id: 'TEST-ASSIGNMENT-LEADER',
        workerId: leaderWorkerId,
        serviceRequest: service
      }]
    },
    devAuditEvent: {
      findMany: async ({ where }) => {
        if (where.entityType === 'DISPATCH_CREW_ATTENDANCE_OPERATION') {
          return [{
            entityId: operationPointId,
            createdAt: new Date(createdAt.getTime() - 60_000),
            metadata: { allowed: true }
          }];
        }
        return [{
          entityId: serviceRequestId,
          createdAt: new Date(createdAt.getTime() + 60_000),
          metadata: { mode: 'CREW', crewLeaderWorkerId: leaderWorkerId }
        }];
      }
    }
  };

  const [context] = await loadCrewAttendancePortalContexts(prisma, { workerId: leaderWorkerId });

  assert.equal(context.serviceRequestId, serviceRequestId);
  assert.equal(context.operationPointName, 'Operación Prueba');
  assert.equal(context.serviceDate, '2026-08-17');
  assert.equal(context.startTime, '08:00');
  assert.equal(context.endTime, '17:00');
  assert.equal(context.isCrewLeader, true);
  assert.equal(context.members[0].workerId, leaderWorkerId);
  assert.equal(context.members[0].isLeader, true);
});

test('la UI Android deja de inventar Cuadrilla 1/2 y etiqueta por operación, fecha y hora', async () => {
  const nativePresence = await read('mobile/android/app/src/main/assets/native-presence.js');

  assert.doesNotMatch(nativePresence, /Cuadrilla \$\{index \+ 1\}/);
  assert.doesNotMatch(nativePresence, /serviceLabel\(context, index\)/);
  assert.match(nativePresence, /function serviceLabel\(context\)/);
  assert.match(nativePresence, /context\?\.operationPointName/);
  assert.match(nativePresence, /displayServiceDate\(context\?\.serviceDate\)/);
  assert.match(nativePresence, /context\?\.startTime/);
  assert.match(nativePresence, /contexts\.forEach\(\(context\) =>/);
  assert.match(nativePresence, /member\.isLeader \? 'Encargado' : 'Auxiliar'/);
});

test('la captura nativa solicita GPS y red habilitados sin duplicar la política de geocerca', async () => {
  const [bridge, policy] = await Promise.all([
    read('mobile/android/app/src/main/java/com/loginpro/lorren/portal/PresenceBridge.java'),
    read('src/modules/dispatch-attendance/domain/attendanceValidationPolicy.js')
  ]);

  assert.match(bridge, /private String\[\] enabledLocationProviders\(\)/);
  assert.match(
    bridge,
    /return new String\[\] \{ LocationManager\.GPS_PROVIDER, LocationManager\.NETWORK_PROVIDER \};/
  );
  assert.match(bridge, /for \(String provider : providers\)/);
  assert.match(bridge, /requestSingleUpdate\(provider, listener, Looper\.getMainLooper\(\)\)/);
  assert.doesNotMatch(bridge, /private String preferredProvider\(\)/);
  assert.match(policy, /accuracyMeters > maxAccuracyMeters/);
  assert.doesNotMatch(bridge, /maxAccuracyMeters|LOW_LOCATION_ACCURACY|OUTSIDE_GEOFENCE/);
});