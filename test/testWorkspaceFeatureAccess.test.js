import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  TEST_WORKSPACE_ACCESS_ACTION,
  TEST_WORKSPACE_ACCESS_ENTITY_TYPE,
  resolveTestWorkspaceFeatureAccess,
  setTestWorkspaceFeatureAccess
} from '../src/services/testWorkspaceFeatureAccess.js';
import {
  DEV_TEST_ATTENDANCE_SOURCE,
  DEV_TEST_REQUEST_SOURCE,
  saveDevTestAttendance
} from '../src/services/dispatchDevPayrollTest.js';

test('DEV tiene acceso automático al entorno de pruebas', async () => {
  const access = await resolveTestWorkspaceFeatureAccess({}, { userRole: 'dev' });
  assert.equal(access.allowed, true);
  assert.equal(access.reason, 'dev');
});

test('un ADMIN necesita el último evento habilitado', async () => {
  const basePrisma = {
    appUser: {
      findUnique: async () => ({ id: 'user-1', role: 'ADMIN', isActive: true })
    },
    devAuditEvent: {
      findFirst: async () => ({ action: TEST_WORKSPACE_ACCESS_ACTION.ENABLED, createdAt: new Date() }),
      create: async () => ({})
    }
  };
  const enabled = await resolveTestWorkspaceFeatureAccess(basePrisma, { userRole: 'admin', userId: 'user-1' });
  assert.equal(enabled.allowed, true);

  basePrisma.devAuditEvent.findFirst = async () => ({ action: TEST_WORKSPACE_ACCESS_ACTION.DISABLED });
  const disabled = await resolveTestWorkspaceFeatureAccess(basePrisma, { userRole: 'admin', userId: 'user-1' });
  assert.equal(disabled.allowed, false);
});

test('solo DEV puede habilitar el permiso y queda auditado', async () => {
  let eventData = null;
  const prisma = {
    appUser: {
      findUnique: async () => ({ id: 'user-1', username: 'reclutador', role: 'ADMIN', isActive: true })
    },
    devAuditEvent: {
      findFirst: async () => ({ action: TEST_WORKSPACE_ACCESS_ACTION.DISABLED }),
      create: async ({ data }) => { eventData = data; return {}; }
    }
  };

  await assert.rejects(() => setTestWorkspaceFeatureAccess(prisma, {
    actorRole: 'admin', targetUserId: 'user-1', enabled: true
  }), /test_workspace_access_dev_required/);

  const result = await setTestWorkspaceFeatureAccess(prisma, {
    actorRole: 'dev', actorUsername: 'devloginpro', targetUserId: 'user-1', enabled: true
  });
  assert.equal(result.enabled, true);
  assert.equal(eventData.entityType, TEST_WORKSPACE_ACCESS_ENTITY_TYPE);
  assert.equal(eventData.action, TEST_WORKSPACE_ACCESS_ACTION.ENABLED);
  assert.equal(eventData.metadata.permission, 'TEST_WORKSPACE');
  assert.equal(eventData.metadata.operationalRecordsChanged, false);
});

test('una jornada sobre auxiliar real solo escribe fuentes DEV_TEST aisladas', async () => {
  const writes = { session: null, marks: null, review: null };
  const assignment = {
    id: 'assignment-test',
    workerId: 'worker-real',
    worker: { id: 'worker-real', fullName: 'Auxiliar real', operationalStatus: 'DISPONIBLE', isTestProfile: false },
    serviceRequest: {
      id: 'request-test', source: DEV_TEST_REQUEST_SOURCE,
      serviceDate: new Date('2026-07-28T05:00:00.000Z'), startTime: '08:00', endTime: '16:00',
      operationPoint: { clientId: 'client-real', client: { id: 'client-real' } }
    }
  };
  const tx = {
    dispatchAttendanceSession: {
      upsert: async (input) => {
        writes.session = input;
        return { id: 'session-test', assignmentId: 'assignment-test' };
      }
    },
    dispatchAttendanceMark: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async ({ data }) => { writes.marks = data; return { count: data.length }; }
    },
    dispatchAttendanceReview: {
      create: async ({ data }) => { writes.review = data; return { id: 'review-test' }; }
    }
  };
  const prisma = {
    dispatchAssignment: { findUnique: async () => assignment },
    $transaction: async (callback) => callback(tx)
  };

  const result = await saveDevTestAttendance(prisma, {
    assignmentId: 'assignment-test',
    arrivalAt: '2026-07-28T08:00',
    breakStartAt: '',
    breakEndAt: '',
    departureAt: '2026-07-28T16:00'
  }, { actorUsername: 'usuario-pruebas', actorRole: 'admin' });

  assert.equal(result.assignment.worker.id, 'worker-real');
  assert.equal(writes.session.create.source, DEV_TEST_ATTENDANCE_SOURCE);
  assert.deepEqual(writes.session.create.riskFlags, ['DEV_TEST_MANUAL']);
  assert.deepEqual(writes.marks.map((mark) => mark.markType), ['ARRIVAL', 'DEPARTURE']);
  assert.ok(writes.marks.every((mark) => mark.riskFlags.includes('DEV_TEST_MANUAL')));
  assert.equal(writes.review.actorRole, 'admin');
  assert.equal(writes.review.metadata.operationalRecordsChanged, false);
  assert.equal(assignment.worker.operationalStatus, 'DISPONIBLE');
  assert.equal(assignment.worker.isTestProfile, false);
});

test('la interfaz de usuarios incluye ambos permisos independientes', async () => {
  const script = await readFile('src/public/payroll-user-access.js', 'utf8');
  assert.match(script, /Nómina y tiempo trabajado/);
  assert.match(script, /Entorno de pruebas de asistencia y nómina/);
  assert.match(script, /\/admin\/operaciones\/pruebas\/api\/users/);
  assert.match(script, /lorren-test-workspace-access-after-create/);
});

test('la ruta de nómina fuerza includeTest para usuarios exclusivos de pruebas y bloquea compensatorios', async () => {
  const route = await readFile('src/routes/dispatchPayrollV2.js', 'utf8');
  assert.match(route, /req\.canAccessTestWorkspace && !req\.canAccessPayroll/);
  assert.match(route, /input\.includeTest = 'true'/);
  assert.match(route, /Los compensatorios no se modifican desde el entorno de pruebas/);
  assert.match(route, /allowTestData: allowTestData\(req\)/);
});
