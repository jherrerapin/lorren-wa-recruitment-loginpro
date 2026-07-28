import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DISPATCH_TEST_RESET_ONCE_KEY,
  inspectDispatchTestEnvironment,
  resetDispatchTestEnvironment,
  resetDispatchTestEnvironmentOnce
} from '../src/services/dispatchTestEnvironmentReset.js';

function deleteModel(name, calls, count = 1) {
  return {
    async deleteMany(args) {
      calls.push({ name, args });
      return { count };
    }
  };
}

function buildPrisma({ marker = null } = {}) {
  const calls = [];
  const prisma = {
    dispatchWorker: {
      async findMany() { return [{ id: 'worker-test', fullName: 'Sujeto de prueba' }]; }
    },
    dispatchClient: {
      async findMany() {
        return [{
          id: 'client-test',
          name: 'Operación de prueba',
          operationPoints: [{ id: 'point-test' }],
          services: [{ id: 'service-test' }]
        }];
      }
    },
    dispatchServiceRequest: {
      async findMany() { return [{ id: 'request-test' }]; },
      ...deleteModel('serviceRequests', calls)
    },
    dispatchAssignment: {
      async findMany() {
        return [
          { id: 'assignment-test', workerId: 'worker-test', serviceRequestId: 'request-test' },
          { id: 'assignment-real-request', workerId: 'worker-test', serviceRequestId: 'request-real' }
        ];
      },
      ...deleteModel('assignments', calls, 2)
    },
    dispatchAttendanceSession: {
      async findMany() {
        return [{
          id: 'attendance-test',
          marks: [{
            id: 'mark-test',
            idempotencyKey: 'mark_key_test_123456',
            evidenceStorageKey: 'attendance/worker-test/assignment-test/arrival/photo.jpg'
          }]
        }];
      },
      ...deleteModel('attendanceSessions', calls)
    },
    dispatchWorkerDevice: {
      async findMany() { return [{ id: 'device-test' }]; },
      ...deleteModel('devices', calls)
    },
    dispatchWorkerActivation: {
      async findMany() { return [{ id: 'activation-test' }]; },
      ...deleteModel('activations', calls)
    },
    dispatchWorkerPortalSession: {
      async findMany() { return [{ id: 'portal-session-test' }]; },
      ...deleteModel('portalSessions', calls)
    },
    devAuditEvent: deleteModel('auditEvents', calls, 3),
    dispatchAttendanceReview: deleteModel('attendanceReviews', calls),
    dispatchAttendanceMark: deleteModel('attendanceMarks', calls),
    dispatchWhatsappConfirmation: deleteModel('whatsappConfirmations', calls),
    dispatchIncident: deleteModel('incidents', calls),
    botKnowledge: {
      async findUnique() { return marker ? { value: marker } : null; },
      async upsert(args) { calls.push({ name: 'resetMarker', args }); return args.create; }
    },
    async $transaction(callback) { return callback(prisma); }
  };
  return { prisma, calls };
}

test('inspecciona el sujeto y cliente de prueba sin incluir sus registros maestros para borrado', async () => {
  const { prisma } = buildPrisma();
  const snapshot = await inspectDispatchTestEnvironment(prisma);
  assert.deepEqual(snapshot.workerIds, ['worker-test']);
  assert.deepEqual(snapshot.clientIds, ['client-test']);
  assert.deepEqual(snapshot.serviceRequestIds, ['request-test']);
  assert.deepEqual(snapshot.assignmentIds, ['assignment-test', 'assignment-real-request']);
  assert.deepEqual(snapshot.survivingAffectedServiceRequestIds, ['request-real']);
  assert.deepEqual(snapshot.evidenceStorageKeys, ['attendance/worker-test/assignment-test/arrival/photo.jpg']);
});

test('el reinicio elimina actividad, biometría, portal y evidencia pero conserva sujeto y cliente', async () => {
  const { prisma, calls } = buildPrisma();
  const deletedEvidence = [];
  const recalculated = [];
  const result = await resetDispatchTestEnvironment(prisma, {
    deleteEvidence: async (key) => { deletedEvidence.push(key); },
    recalculateStatus: async (id) => { recalculated.push(id); }
  });

  assert.deepEqual(deletedEvidence, ['attendance/worker-test/assignment-test/arrival/photo.jpg']);
  assert.deepEqual(recalculated, ['request-real']);
  assert.equal(result.assignments, 2);
  assert.equal(result.serviceRequests, 1);
  assert.equal(result.attendanceMarks, 1);
  assert.equal(result.portalSessions, 1);
  assert.equal(result.auditEvents, 3);
  assert.equal(result.workersPreserved, 1);
  assert.equal(result.clientsPreserved, 1);
  assert.equal(calls.some((call) => call.name === 'workers'), false);
  assert.equal(calls.some((call) => call.name === 'clients'), false);

  const order = calls.map((call) => call.name);
  assert.ok(order.indexOf('attendanceMarks') < order.indexOf('attendanceSessions'));
  assert.ok(order.indexOf('portalSessions') < order.indexOf('activations'));
  assert.ok(order.indexOf('activations') < order.indexOf('devices'));
  assert.ok(order.indexOf('attendanceSessions') < order.indexOf('assignments'));
  assert.ok(order.indexOf('assignments') < order.indexOf('serviceRequests'));
});

test('la limpieza automática se ejecuta una sola vez y deja marcador', async () => {
  const first = buildPrisma();
  const result = await resetDispatchTestEnvironmentOnce(first.prisma, {
    deleteEvidence: async () => {},
    recalculateStatus: async () => {}
  });
  assert.equal(result.skipped, false);
  const markerCall = first.calls.find((call) => call.name === 'resetMarker');
  assert.equal(markerCall.args.where.key, DISPATCH_TEST_RESET_ONCE_KEY);

  const second = buildPrisma({ marker: '{"completed":true}' });
  const skipped = await resetDispatchTestEnvironmentOnce(second.prisma);
  assert.equal(skipped.skipped, true);
  assert.equal(second.calls.length, 0);
});

test('la vista de personal ofrece reinicio solo a DEV con confirmación escrita', () => {
  const route = fs.readFileSync('src/routes/dispatchWorkerStats.js', 'utf8');
  assert.match(route, /router\.get\('\/personal', requireOps/);
  assert.match(route, /resetDispatchTestEnvironmentOnce\(prisma\)/);
  assert.match(route, /router\.post\([\s\S]*'\/pruebas\/reiniciar'/);
  assert.match(route, /requireDev/);
  assert.match(route, /Reiniciar entorno de prueba/);
  assert.match(route, /DISPATCH_TEST_RESET_CONFIRMATION/);
  assert.match(route, /rostro registrado/);
});
