import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PAYROLL_ACCESS_ACTION,
  PAYROLL_ACCESS_ENTITY_TYPE,
  resolvePayrollFeatureAccess,
  setPayrollFeatureAccess
} from '../src/services/payrollFeatureAccess.js';

function prismaMock({ latestAction = null } = {}) {
  const calls = { events: [] };
  const prisma = {
    appUser: {
      async findUnique({ where }) {
        return {
          id: where.id || 'user-1',
          username: where.username || 'reclutador-prueba',
          role: 'ADMIN',
          isActive: true
        };
      }
    },
    devAuditEvent: {
      async findFirst() {
        return latestAction ? { action: latestAction, createdAt: new Date('2026-07-28T12:00:00Z') } : null;
      },
      async create(input) {
        calls.events.push(input);
        return input;
      }
    }
  };
  return { prisma, calls };
}

test('DEV siempre puede abrir Nómina sin consultar permisos de usuario', async () => {
  const access = await resolvePayrollFeatureAccess(null, { userRole: 'dev' });
  assert.equal(access.allowed, true);
  assert.equal(access.reason, 'dev');
});

test('un usuario administrador no recibe Nómina por defecto', async () => {
  const { prisma } = prismaMock();
  const access = await resolvePayrollFeatureAccess(prisma, {
    userRole: 'admin',
    userId: 'user-1',
    username: 'reclutador-prueba'
  });
  assert.equal(access.allowed, false);
  assert.equal(access.reason, 'user_permission_disabled');
});

test('solo DEV puede conceder el permiso', async () => {
  const { prisma } = prismaMock();
  await assert.rejects(() => setPayrollFeatureAccess(prisma, {
    targetUserId: 'user-1',
    enabled: true,
    actorRole: 'admin'
  }), /payroll_access_dev_required/);
});

test('conceder Nómina no modifica Operaciones ni Asistencia', async () => {
  const { prisma, calls } = prismaMock();
  const result = await setPayrollFeatureAccess(prisma, {
    targetUserId: 'user-1',
    enabled: true,
    actorRole: 'dev',
    actorUsername: 'devloginpro'
  });

  assert.equal(result.enabled, true);
  assert.equal(result.independentPermission, true);
  assert.equal(result.parentPermissionsChanged, false);
  assert.equal(calls.events[0].data.entityType, PAYROLL_ACCESS_ENTITY_TYPE);
  assert.equal(calls.events[0].data.action, PAYROLL_ACCESS_ACTION.ENABLED);
  assert.equal(calls.events[0].data.metadata.independentPermission, true);
  assert.equal(calls.events[0].data.metadata.parentPermissionsChanged, false);
});

test('retirar Nómina conserva los demás permisos', async () => {
  const { prisma, calls } = prismaMock({ latestAction: PAYROLL_ACCESS_ACTION.ENABLED });
  const result = await setPayrollFeatureAccess(prisma, {
    targetUserId: 'user-1',
    enabled: false,
    actorRole: 'dev',
    actorUsername: 'devloginpro'
  });

  assert.equal(result.enabled, false);
  assert.equal(result.parentPermissionsChanged, false);
  assert.equal(calls.events[0].data.action, PAYROLL_ACCESS_ACTION.DISABLED);
  assert.deepEqual(calls.events[0].data.fromValue, { enabled: true });
});

test('el último evento auditado determina el acceso del usuario', async () => {
  const { prisma } = prismaMock({ latestAction: PAYROLL_ACCESS_ACTION.ENABLED });
  const access = await resolvePayrollFeatureAccess(prisma, {
    userRole: 'admin',
    userId: 'user-1'
  });
  assert.equal(access.allowed, true);
});
