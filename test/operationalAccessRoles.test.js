import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync } from 'node:fs';
import {
  canManageOperationalPermissions,
  getOperationalAccessForUser,
  hasOperationalCapability,
  OPERATIONAL_CAPABILITY,
  operationalAccessCatalog,
  operationalRoleBasePermissions,
  setOperationalAccess
} from '../src/services/operationalAccess.js';
import { requiredOperationalCapability } from '../src/services/dispatchAuditMiddleware.js';
import { locationsRouter } from '../src/routes/locations.js';

function createPrisma() {
  const users = new Map([
    ['TEST-USER-COORD', { id: 'TEST-USER-COORD', username: 'usuario-coordinacion', displayName: 'Usuario Coordinación', role: 'ADMIN', isActive: true }],
    ['TEST-USER-SUP', { id: 'TEST-USER-SUP', username: 'usuario-supervision', displayName: 'Usuario Supervisión', role: 'ADMIN', isActive: true }],
    ['TEST-USER-VIEW', { id: 'TEST-USER-VIEW', username: 'usuario-consulta', displayName: 'Usuario Consulta', role: 'ADMIN', isActive: true }]
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
      },
      findMany: async () => [...users.values()]
    },
    devAuditEvent: {
      findFirst: async ({ where }) => {
        return [...events].reverse().find((event) => event.entityType === where.entityType
          && event.entityId === where.entityId
          && event.action === where.action) || null;
      },
      create: async ({ data }) => {
        const event = { id: `TEST-EVENT-${events.length + 1}`, ...data };
        events.push(event);
        return event;
      }
    }
  };
}

function devActor() {
  return {
    actorUserId: 'TEST-DEV',
    actorUsername: 'dev-prueba',
    actorRole: 'dev',
    actorEffectivePermissions: [],
    actorDelegablePermissions: []
  };
}

function supervisorActor(delegablePermissions) {
  return {
    actorUserId: 'TEST-USER-SUP',
    actorUsername: 'usuario-supervision',
    actorRole: 'admin',
    actorOperationalRole: 'SUPERVISOR',
    actorOperationalAccessConfigured: true,
    actorEffectivePermissions: [OPERATIONAL_CAPABILITY.SUPERVISE_PERMISSIONS],
    actorDelegablePermissions: delegablePermissions
  };
}

function effectiveState(role, overrides = {}) {
  const base = new Set(operationalRoleBasePermissions(role));
  const states = Object.fromEntries(operationalAccessCatalog().capabilities.map((item) => [item.key, base.has(item.key)]));
  return { ...states, ...overrides };
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('DEV asigna rol base y puede ampliar o restringir funciones individuales', async () => {
  const prisma = createPrisma();
  const permissions = effectiveState('COORDINADOR', {
    [OPERATIONAL_CAPABILITY.DISPATCH_ASSIGNMENT_MANAGE]: false,
    [OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_MANAGE]: true
  });

  const result = await setOperationalAccess(prisma, {
    targetUserId: 'TEST-USER-COORD',
    role: 'COORDINADOR',
    permissions,
    delegablePermissions: [],
    ...devActor()
  });

  assert.equal(result.role, 'COORDINADOR');
  assert.equal(result.effectivePermissions.includes(OPERATIONAL_CAPABILITY.DISPATCH_REQUEST_MANAGE), true);
  assert.equal(result.effectivePermissions.includes(OPERATIONAL_CAPABILITY.DISPATCH_ASSIGNMENT_MANAGE), false);
  assert.equal(result.effectivePermissions.includes(OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_MANAGE), true);
  assert.equal(prisma.events.at(-1).metadata.roleAssignedByDev, true);
});

test('solo DEV define Supervisor y su techo delegable', async () => {
  const prisma = createPrisma();
  const supervisor = await setOperationalAccess(prisma, {
    targetUserId: 'TEST-USER-SUP',
    role: 'SUPERVISOR',
    permissions: effectiveState('SUPERVISOR'),
    delegablePermissions: [
      OPERATIONAL_CAPABILITY.ATTENDANCE_CORRECT,
      OPERATIONAL_CAPABILITY.TIME_EXPORT,
      OPERATIONAL_CAPABILITY.SUPERVISE_PERMISSIONS
    ],
    ...devActor()
  });

  assert.equal(supervisor.role, 'SUPERVISOR');
  assert.deepEqual(supervisor.delegablePermissions.sort(), [
    OPERATIONAL_CAPABILITY.ATTENDANCE_CORRECT,
    OPERATIONAL_CAPABILITY.TIME_EXPORT
  ].sort());
  assert.equal(canManageOperationalPermissions({
    userRole: 'admin',
    operationalRole: 'SUPERVISOR',
    operationalAccessConfigured: true,
    operationalEffectivePermissions: supervisor.effectivePermissions
  }), true);
});

test('Supervisor amplía o restringe únicamente funciones autorizadas y no cambia el rol', async () => {
  const prisma = createPrisma();
  await setOperationalAccess(prisma, {
    targetUserId: 'TEST-USER-COORD',
    role: 'COORDINADOR',
    permissions: effectiveState('COORDINADOR'),
    ...devActor()
  });

  const delegated = await setOperationalAccess(prisma, {
    targetUserId: 'TEST-USER-COORD',
    permissions: {
      [OPERATIONAL_CAPABILITY.ATTENDANCE_CORRECT]: true,
      [OPERATIONAL_CAPABILITY.TIME_EXPORT]: true
    },
    ...supervisorActor([
      OPERATIONAL_CAPABILITY.ATTENDANCE_CORRECT,
      OPERATIONAL_CAPABILITY.TIME_EXPORT
    ])
  });

  assert.equal(delegated.role, 'COORDINADOR');
  assert.equal(delegated.effectivePermissions.includes(OPERATIONAL_CAPABILITY.ATTENDANCE_CORRECT), true);
  assert.equal(delegated.effectivePermissions.includes(OPERATIONAL_CAPABILITY.TIME_EXPORT), true);
  assert.equal(prisma.events.at(-1).metadata.delegatedBySupervisor, true);

  await assert.rejects(
    setOperationalAccess(prisma, {
      targetUserId: 'TEST-USER-COORD',
      permissions: { [OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_DELETE]: true },
      ...supervisorActor([OPERATIONAL_CAPABILITY.ATTENDANCE_CORRECT])
    }),
    /operational_access_capability_not_delegable/
  );
});

test('Supervisor no puede modificarse a sí mismo ni administrar otro Supervisor', async () => {
  const prisma = createPrisma();
  await setOperationalAccess(prisma, {
    targetUserId: 'TEST-USER-SUP',
    role: 'SUPERVISOR',
    permissions: effectiveState('SUPERVISOR'),
    delegablePermissions: [OPERATIONAL_CAPABILITY.TIME_EXPORT],
    ...devActor()
  });

  await assert.rejects(
    setOperationalAccess(prisma, {
      targetUserId: 'TEST-USER-SUP',
      permissions: { [OPERATIONAL_CAPABILITY.TIME_EXPORT]: true },
      ...supervisorActor([OPERATIONAL_CAPABILITY.TIME_EXPORT])
    }),
    /operational_access_self_forbidden/
  );

  prisma.users.set('TEST-USER-SUP-2', { id: 'TEST-USER-SUP-2', username: 'usuario-supervision-dos', displayName: 'Usuario Supervisión Dos', role: 'ADMIN', isActive: true });
  await setOperationalAccess(prisma, {
    targetUserId: 'TEST-USER-SUP-2',
    role: 'SUPERVISOR',
    permissions: effectiveState('SUPERVISOR'),
    delegablePermissions: [],
    ...devActor()
  });

  await assert.rejects(
    setOperationalAccess(prisma, {
      targetUserId: 'TEST-USER-SUP-2',
      permissions: { [OPERATIONAL_CAPABILITY.TIME_EXPORT]: true },
      ...supervisorActor([OPERATIONAL_CAPABILITY.TIME_EXPORT])
    }),
    /operational_access_supervisor_target_forbidden/
  );
});

test('usuarios sin rol operativo mantienen compatibilidad histórica hasta que DEV configure uno', async () => {
  const prisma = createPrisma();
  const access = await getOperationalAccessForUser(prisma, 'TEST-USER-VIEW');
  assert.equal(access.configured, false);
  assert.equal(hasOperationalCapability({
    userRole: 'admin',
    operationalAccessConfigured: false,
    operationalEffectivePermissions: []
  }, OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_DELETE), true);

  assert.equal(hasOperationalCapability({
    userRole: 'admin',
    operationalAccessConfigured: true,
    operationalRole: 'CONSULTA',
    operationalEffectivePermissions: operationalRoleBasePermissions('CONSULTA')
  }, OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_DELETE), false);
});

test('guardas centrales distinguen acciones sensibles de Despacho, Asistencia y Gestión de Tiempo', () => {
  assert.equal(requiredOperationalCapability({ method: 'POST', originalUrl: '/admin/operaciones/personal/TEST-WORKER/eliminar' }), OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_DELETE);
  assert.equal(requiredOperationalCapability({ method: 'POST', originalUrl: '/admin/operaciones/clientes/TEST-CLIENT/eliminar' }), OPERATIONAL_CAPABILITY.DISPATCH_MASTERDATA_DELETE);
  assert.equal(requiredOperationalCapability({ method: 'POST', originalUrl: '/admin/operaciones/asistencia/sessions/TEST-SESSION/review', body: { action: 'DELETE_MARK' } }), OPERATIONAL_CAPABILITY.ATTENDANCE_CORRECT);
  assert.equal(requiredOperationalCapability({ method: 'POST', originalUrl: '/admin/operaciones/asistencia/sessions/TEST-SESSION/review', body: { action: 'VALIDATE' } }), OPERATIONAL_CAPABILITY.ATTENDANCE_MANAGE);
  assert.equal(requiredOperationalCapability({ method: 'POST', originalUrl: '/admin/operaciones/asistencia/gestion-tiempo/imports/TEST-BATCH/reverse' }), OPERATIONAL_CAPABILITY.TIME_IMPORT_REVERSE);
  assert.equal(requiredOperationalCapability({ method: 'GET', originalUrl: '/admin/operaciones/asistencia/gestion-tiempo/export.xlsx' }), OPERATIONAL_CAPABILITY.TIME_EXPORT);
  assert.equal(requiredOperationalCapability({ method: 'POST', originalUrl: '/admin/operaciones/asistencia/gestion-tiempo/policy' }), null);
});

test('API permite a DEV asignar rol y a Supervisor solo delegar su techo', async () => {
  const prisma = createPrisma();
  const app = express();
  app.use(express.json());
  let mode = 'dev';
  app.use((req, _res, next) => {
    req.session = mode === 'dev'
      ? { userRole: 'dev', userId: 'TEST-DEV', username: 'dev-prueba', userSource: 'env' }
      : {
          userRole: 'admin',
          userId: 'TEST-USER-SUP',
          username: 'usuario-supervision',
          userSource: 'db',
          operationalAccessConfigured: true,
          operationalRole: 'SUPERVISOR',
          operationalEffectivePermissions: [OPERATIONAL_CAPABILITY.SUPERVISE_PERMISSIONS],
          operationalDelegablePermissions: [OPERATIONAL_CAPABILITY.TIME_EXPORT]
        };
    next();
  });
  app.use('/admin/locations', locationsRouter(prisma));

  const server = await listen(app);
  try {
    const { port } = server.address();
    const devResponse = await fetch(`http://127.0.0.1:${port}/admin/locations/users/TEST-USER-COORD/operational-access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        role: 'COORDINADOR',
        permissions: effectiveState('COORDINADOR'),
        delegablePermissions: []
      })
    });
    assert.equal(devResponse.status, 200);

    mode = 'supervisor';
    const delegated = await fetch(`http://127.0.0.1:${port}/admin/locations/users/TEST-USER-COORD/operational-access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: { [OPERATIONAL_CAPABILITY.TIME_EXPORT]: true } })
    });
    assert.equal(delegated.status, 200);
    const access = await getOperationalAccessForUser(prisma, 'TEST-USER-COORD');
    assert.equal(access.role, 'COORDINADOR');
    assert.equal(access.effectivePermissions.includes(OPERATIONAL_CAPABILITY.TIME_EXPORT), true);

    const forbidden = await fetch(`http://127.0.0.1:${port}/admin/locations/users/TEST-USER-COORD/operational-access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: { [OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_DELETE]: true } })
    });
    assert.equal(forbidden.status, 403);
  } finally {
    await close(server);
  }
});

test('middleware ejecutado conserva la guarda operativa antes de continuar', () => {
  const source = readFileSync(new URL('../src/services/dispatchAuditMiddleware.js', import.meta.url), 'utf8');
  assert.match(source, /if \(!enforceOperationalCapability\(req, res\)\) return;/);
  assert.match(source, /await refreshDatabaseUserPermissions\(prisma, req\)/);
});
