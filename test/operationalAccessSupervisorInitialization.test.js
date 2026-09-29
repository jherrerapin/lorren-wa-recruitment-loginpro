import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getOperationalAccessForUser,
  OPERATIONAL_ACCESS_ACTION,
  OPERATIONAL_ACCESS_ENTITY_TYPE,
  OPERATIONAL_CAPABILITY,
  resolveOperationalAccess,
  setOperationalAccess
} from '../src/services/operationalAccess.js';

function createPrisma() {
  const users = new Map([
    ['SUP', {
      id: 'SUP',
      username: 'supervisor-prueba',
      displayName: 'Supervisor Prueba',
      role: 'ADMIN',
      isActive: true
    }],
    ['NEW', {
      id: 'NEW',
      username: 'usuario-sin-configurar',
      displayName: 'Usuario Sin Configurar',
      role: 'ADMIN',
      isActive: true
    }]
  ]);
  const events = [];
  return {
    users,
    events,
    appUser: {
      findUnique: async ({ where }) => {
        if (where?.id) return users.get(where.id) || null;
        if (where?.username) return [...users.values()].find((user) => user.username === where.username) || null;
        return null;
      }
    },
    devAuditEvent: {
      findFirst: async ({ where }) => [...events].reverse().find((event) => (
        event.entityType === where.entityType
        && event.entityId === where.entityId
        && event.action === where.action
      )) || null,
      create: async ({ data }) => {
        const event = { id: `EVENT-${events.length + 1}`, ...data };
        events.push(event);
        return event;
      }
    }
  };
}

function supervisorActor(overrides = {}) {
  return {
    actorUserId: 'SUP',
    actorUsername: 'supervisor-prueba',
    actorRole: 'admin',
    actorOperationalRole: 'SUPERVISOR',
    actorOperationalAccessConfigured: true,
    actorEffectivePermissions: [],
    actorDelegablePermissions: [],
    ...overrides
  };
}

test('usuario ADMIN sin configuración aparece como Consulta implícita para administración, sin cambiar runtime', async () => {
  const prisma = createPrisma();

  const managementAccess = await getOperationalAccessForUser(prisma, 'NEW');
  assert.equal(managementAccess.configured, true);
  assert.equal(managementAccess.implicit, true);
  assert.equal(managementAccess.role, 'CONSULTA');
  assert.equal(managementAccess.username, 'usuario-sin-configurar');

  const runtimeAccess = await resolveOperationalAccess(prisma, {
    userRole: 'admin',
    userId: 'NEW',
    username: 'usuario-sin-configurar'
  });
  assert.equal(runtimeAccess.configured, false);
  assert.equal(runtimeAccess.role, null);
  assert.deepEqual(runtimeAccess.effectivePermissions, []);
});

test('Supervisor puede inicializar un usuario sin configuración únicamente como Consulta', async () => {
  const prisma = createPrisma();

  const result = await setOperationalAccess(prisma, {
    targetUserId: 'NEW',
    moduleAccess: { dispatch: true, attendance: false, time: true },
    permissions: {
      [OPERATIONAL_CAPABILITY.DISPATCH_REQUEST_MANAGE]: true,
      [OPERATIONAL_CAPABILITY.TIME_EXPORT]: true
    },
    ...supervisorActor()
  });

  assert.equal(result.role, 'CONSULTA');
  assert.deepEqual(result.moduleAccess, { dispatch: true, attendance: false, time: true });
  assert.equal(result.effectivePermissions.includes(OPERATIONAL_CAPABILITY.DISPATCH_REQUEST_MANAGE), true);
  assert.equal(result.effectivePermissions.includes(OPERATIONAL_CAPABILITY.TIME_EXPORT), true);
  assert.equal(result.effectivePermissions.includes(OPERATIONAL_CAPABILITY.SUPERVISE_PERMISSIONS), false);

  const persisted = await getOperationalAccessForUser(prisma, 'NEW');
  assert.equal(persisted.configured, true);
  assert.equal(persisted.implicit, false);
  assert.equal(persisted.role, 'CONSULTA');

  const event = prisma.events.at(-1);
  assert.equal(event.entityType, OPERATIONAL_ACCESS_ENTITY_TYPE);
  assert.equal(event.action, OPERATIONAL_ACCESS_ACTION);
  assert.equal(event.fromValue.role, null);
  assert.equal(event.toValue.role, 'CONSULTA');
  assert.equal(event.metadata.initializedBySupervisor, true);
  assert.equal(event.metadata.roleAssignedByDev, false);
});

test('Supervisor sigue sin poder asignar rol Supervisor ni autoeditarse al inicializar', async () => {
  const prisma = createPrisma();

  await assert.rejects(
    setOperationalAccess(prisma, {
      targetUserId: 'NEW',
      role: 'SUPERVISOR',
      permissions: {},
      ...supervisorActor()
    }),
    /operational_role_dev_required/
  );

  await assert.rejects(
    setOperationalAccess(prisma, {
      targetUserId: 'SUP',
      moduleAccess: { dispatch: true, attendance: false, time: false },
      permissions: {},
      ...supervisorActor()
    }),
    /operational_access_self_forbidden/
  );
});
