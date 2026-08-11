import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  DISPATCH_SERVICE_REQUEST_EDIT_GRACE_MS,
  deleteDispatchServiceRequestWithPolicy,
  resolveDispatchServiceRequestPolicy
} from '../src/services/dispatchServiceRequestPolicy.js';

function requestAt({ isTestClient = false, serviceDate = '2026-07-25', startTime = '10:00' } = {}) {
  return {
    id: 'request-1',
    serviceDate: new Date(`${serviceDate}T00:00:00-05:00`),
    startTime,
    operationPoint: {
      client: { id: 'client-1', name: 'Cliente', isTestClient }
    }
  };
}

test('cliente real conserva edición y eliminación hasta el instante exacto de dos horas', () => {
  const request = requestAt();
  const start = new Date('2026-07-25T10:00:00-05:00');
  const before = resolveDispatchServiceRequestPolicy(request, new Date(start.getTime() + DISPATCH_SERVICE_REQUEST_EDIT_GRACE_MS - 1));
  const boundary = resolveDispatchServiceRequestPolicy(request, new Date(start.getTime() + DISPATCH_SERVICE_REQUEST_EDIT_GRACE_MS));
  const after = resolveDispatchServiceRequestPolicy(request, new Date(start.getTime() + DISPATCH_SERVICE_REQUEST_EDIT_GRACE_MS + 1));

  assert.equal(before.canEdit, true);
  assert.equal(before.canDelete, true);
  assert.equal(boundary.canEdit, true);
  assert.equal(boundary.canDelete, true);
  assert.equal(after.canEdit, false);
  assert.equal(after.canDelete, false);
});

test('cliente de prueba puede eliminar una solicitud antigua pero no editarla', () => {
  const request = requestAt({ isTestClient: true });
  const policy = resolveDispatchServiceRequestPolicy(request, new Date('2027-07-25T10:00:00-05:00'));
  assert.equal(policy.isTestClient, true);
  assert.equal(policy.canEdit, false);
  assert.equal(policy.canDelete, true);
});

test('una solicitud sin fecha utilizable no queda bloqueada por tiempo', () => {
  const policy = resolveDispatchServiceRequestPolicy({ operationPoint: { client: { isTestClient: false } } }, new Date('2027-01-01T00:00:00Z'));
  assert.equal(policy.editLockAt, null);
  assert.equal(policy.canEdit, true);
  assert.equal(policy.canDelete, true);
});

test('la eliminación de prueba retira asistencia antes de borrar y limpia evidencias después del commit', async () => {
  const calls = [];
  const deletedEvidence = [];
  let committed = false;
  const tx = {
    dispatchServiceRequest: {
      findUnique: async () => requestAt({ isTestClient: true }),
      delete: async () => { calls.push('request'); }
    },
    dispatchAttendanceSession: {
      findMany: async () => [{ id: 'session-1', marks: [{ evidenceStorageKey: 'attendance/key-1.jpg' }, { evidenceStorageKey: 'attendance/key-1.jpg' }] }],
      deleteMany: async () => { calls.push('sessions'); }
    },
    dispatchAttendanceReview: {
      deleteMany: async () => { calls.push('reviews'); }
    },
    dispatchAttendanceMark: {
      deleteMany: async () => { calls.push('marks'); }
    }
  };
  const prisma = {
    $transaction: async (callback) => {
      const result = await callback(tx);
      committed = true;
      return result;
    }
  };

  const result = await deleteDispatchServiceRequestWithPolicy(prisma, 'request-1', {
    now: new Date('2027-01-01T00:00:00-05:00'),
    deleteEvidence: async (key) => {
      assert.equal(committed, true);
      deletedEvidence.push(key);
    }
  });

  assert.equal(result.status, 'DELETED');
  assert.deepEqual(calls, ['reviews', 'marks', 'sessions', 'request']);
  assert.deepEqual(deletedEvidence, ['attendance/key-1.jpg']);
});

test('la eliminación directa de cliente real vencido se bloquea en la transacción', async () => {
  let deleted = false;
  const tx = {
    dispatchServiceRequest: {
      findUnique: async () => requestAt({ isTestClient: false }),
      delete: async () => { deleted = true; }
    },
    dispatchAttendanceSession: { findMany: async () => [] },
    dispatchAttendanceReview: { deleteMany: async () => null },
    dispatchAttendanceMark: { deleteMany: async () => null }
  };
  const prisma = { $transaction: async (callback) => callback(tx) };

  const result = await deleteDispatchServiceRequestWithPolicy(prisma, 'request-1', {
    now: new Date('2027-01-01T00:00:00-05:00'),
    deleteEvidence: async () => null
  });

  assert.equal(result.status, 'BLOCKED');
  assert.equal(deleted, false);
});

test('contratos del repositorio conectan la marca y la autoridad server-side', () => {
  const schema = fs.readFileSync('prisma/schema.prisma', 'utf8');
  const migration = fs.readFileSync('prisma/migrations/20260725060000_add_dispatch_test_client/migration.sql', 'utf8');
  const bridgeCore = fs.readFileSync('src/routes/dispatchBridgeCore.js', 'utf8');
  const opsExtras = fs.readFileSync('src/routes/dispatchOpsExtras.js', 'utf8');
  const publicClient = fs.readFileSync('src/routes/publicDispatchClient.js', 'utf8');
  const dashboardMetrics = fs.readFileSync('src/routes/dispatchDashboardMetrics.js', 'utf8');
  const clientsView = fs.readFileSync('src/views/operacionesClientes.ejs', 'utf8');
  const summaryView = fs.readFileSync('src/views/operacionesSolicitudesResumen.ejs', 'utf8');
  const legacyAssignmentView = fs.readFileSync('src/views/operacionesAsignaciones.ejs', 'utf8');
  const assignmentView = fs.readFileSync('src/views/operacionesAsignacionesConfirmacion.ejs', 'utf8');
  const browserPolicy = fs.readFileSync('src/public/expired-service-request-modal.js', 'utf8');

  assert.match(schema, /isTestClient\s+Boolean\s+@default\(false\)/);
  assert.match(migration, /ADD COLUMN "isTestClient" BOOLEAN NOT NULL DEFAULT false/);
  assert.match(bridgeCore, /resolveDispatchServiceRequestPolicy/);
  assert.match(bridgeCore, /isTestClient/);
  assert.match(opsExtras, /deleteDispatchServiceRequestWithPolicy/);
  assert.match(opsExtras, /res\.render\('operacionesAsignacionesConfirmacion'/);
  assert.match(publicClient, /deleteDispatchServiceRequestWithPolicy/);
  assert.match(publicClient, /isTestClient/);
  assert.match(dashboardMetrics, /resolveDispatchServiceRequestPolicy/);
  assert.match(clientsView, /name="isTestClient"/);
  assert.match(clientsView, /Cliente de prueba/);
  assert.match(summaryView, /policy\.canDelete/);
  assert.match(summaryView, /policy\.canEdit/);
  assert.match(legacyAssignmentView, /include\('operacionesAsignacionesConfirmacion'/);
  assert.match(assignmentView, /\/admin\/operaciones\/asignaciones/);
  assert.doesNotMatch(browserPolicy, /TWO_HOURS_MS/);
  assert.match(browserPolicy, /editLockAt/);
});

test('el tablero de asignaciones carga la relación necesaria para reconocer clientes de prueba', () => {
  const bridgeCore = fs.readFileSync('src/routes/dispatchBridgeCore.js', 'utf8');
  assert.match(
    bridgeCore,
    /prisma\.dispatchServiceRequest\.findMany\(\{ include: \{ service: true, \.\.\.DISPATCH_SERVICE_REQUEST_POLICY_INCLUDE, assignments:/
  );
  const policyIncludes = bridgeCore.match(/\.\.\.DISPATCH_SERVICE_REQUEST_POLICY_INCLUDE/g) || [];
  assert.ok(policyIncludes.length >= 3);
});
