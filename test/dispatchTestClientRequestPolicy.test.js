import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  DISPATCH_SERVICE_REQUEST_EDIT_GRACE_PERIOD_MS,
  buildDispatchServiceRequestPolicy,
  deleteDispatchServiceRequest,
  dispatchServiceRequestStartAt,
  isDispatchServiceRequestEditLocked
} from '../src/services/dispatchServiceRequestPolicy.js';

function requestFixture(overrides = {}) {
  return {
    id: 'request-1',
    serviceDate: new Date('2026-07-25T00:00:00.000Z'),
    startTime: '10:00',
    operationPoint: { client: { id: 'client-1', isTestClient: false } },
    service: null,
    ...overrides
  };
}

function buildDeletePrisma(request) {
  const calls = [];
  const tx = {
    dispatchServiceRequest: {
      findUnique: async () => { calls.push('request.find'); return request; },
      delete: async () => { calls.push('request.delete'); return request; }
    },
    dispatchAssignment: {
      findMany: async () => { calls.push('assignment.findMany'); return [{ id: 'assignment-1' }]; }
    },
    dispatchAttendanceSession: {
      findMany: async () => { calls.push('session.findMany'); return [{ id: 'session-1' }]; },
      deleteMany: async () => { calls.push('session.deleteMany'); return { count: 1 }; }
    },
    dispatchAttendanceReview: {
      deleteMany: async () => { calls.push('review.deleteMany'); return { count: 1 }; }
    },
    dispatchAttendanceMark: {
      deleteMany: async () => { calls.push('mark.deleteMany'); return { count: 1 }; }
    }
  };
  return {
    calls,
    prisma: { $transaction: async (callback) => callback(tx) }
  };
}

test('el límite se calcula desde la hora real del servicio en Colombia', () => {
  const request = requestFixture();
  const start = dispatchServiceRequestStartAt(request);
  assert.equal(start.toISOString(), '2026-07-25T15:00:00.000Z');
  assert.equal(DISPATCH_SERVICE_REQUEST_EDIT_GRACE_PERIOD_MS, 7_200_000);
  assert.equal(isDispatchServiceRequestEditLocked(request, new Date('2026-07-25T16:59:59.999Z')), false);
  assert.equal(isDispatchServiceRequestEditLocked(request, new Date('2026-07-25T17:00:00.000Z')), true);
});

test('una solicitud sin hora de inicio no se bloquea usando medianoche ficticia', () => {
  const request = requestFixture({ startTime: null });
  assert.equal(dispatchServiceRequestStartAt(request), null);
  assert.equal(isDispatchServiceRequestEditLocked(request, new Date('2026-08-01T12:00:00.000Z')), false);
});

test('el cliente de prueba conserva bloqueo de edición pero puede eliminar sin límite', () => {
  const request = requestFixture({ operationPoint: { client: { id: 'client-test', isTestClient: true } } });
  const policy = buildDispatchServiceRequestPolicy(request, new Date('2026-08-01T12:00:00.000Z'));
  assert.deepEqual(policy, {
    editLocked: true,
    isTestClient: true,
    canEdit: false,
    canDelete: true
  });
});

test('una solicitud real vencida se rechaza también en el servidor', async () => {
  const { prisma, calls } = buildDeletePrisma(requestFixture());
  const result = await deleteDispatchServiceRequest(prisma, 'request-1', {
    now: new Date('2026-08-01T12:00:00.000Z')
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'locked');
  assert.deepEqual(calls, ['request.find']);
});

test('una solicitud antigua de prueba elimina dependencias de asistencia y luego la solicitud', async () => {
  const request = requestFixture({ operationPoint: { client: { id: 'client-test', isTestClient: true } } });
  const { prisma, calls } = buildDeletePrisma(request);
  const result = await deleteDispatchServiceRequest(prisma, 'request-1', {
    now: new Date('2027-01-01T12:00:00.000Z')
  });
  assert.equal(result.ok, true);
  assert.equal(result.policy.isTestClient, true);
  assert.deepEqual(calls, [
    'request.find',
    'assignment.findMany',
    'session.findMany',
    'review.deleteMany',
    'mark.deleteMany',
    'session.deleteMany',
    'request.delete'
  ]);
});

test('los contratos conectan la marca, la autoridad del servidor y la excepción visual', () => {
  const schema = fs.readFileSync('prisma/schema.prisma', 'utf8');
  const publicClients = fs.readFileSync('src/routes/publicDispatchClient.js', 'utf8');
  const bridgeCore = fs.readFileSync('src/routes/dispatchBridgeCore.js', 'utf8');
  const extras = fs.readFileSync('src/routes/dispatchOpsExtras.js', 'utf8');
  const metrics = fs.readFileSync('src/routes/dispatchDashboardMetrics.js', 'utf8');
  const clientsView = fs.readFileSync('src/views/operacionesClientes.ejs', 'utf8');
  const summaryView = fs.readFileSync('src/views/operacionesSolicitudesResumen.ejs', 'utf8');
  const expiredModal = fs.readFileSync('src/public/expired-service-request-modal.js', 'utf8');

  assert.match(schema, /isTestClient\s+Boolean\s+@default\(false\)/);
  assert.match(publicClients, /isTestClient:\s*normalizeString\(body\.isTestClient\) === 'true'/);
  assert.match(bridgeCore, /DISPATCH_SERVICE_REQUEST_LOCKED_MESSAGE/);
  assert.match(bridgeCore, /isDispatchServiceRequestEditLocked/);
  assert.match(extras, /deleteDispatchServiceRequest/);
  assert.match(metrics, /canDeleteDispatchServiceRequest/);
  assert.match(clientsView, /name="isTestClient"/);
  assert.match(clientsView, /Cliente de prueba/);
  assert.match(summaryView, /data-expired-delete=/);
  assert.match(summaryView, /Cliente de prueba: eliminación sin límite/);
  assert.match(expiredModal, /isDeleteLocked/);
  assert.match(expiredModal, /dataset\.expiredDelete === 'false'/);
});
