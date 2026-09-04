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
import { injectAdminModuleNavigation } from '../src/services/adminNavigation.js';
import { requiredOperationalCapability } from '../src/services/dispatchAuditMiddleware.js';
import { locationsRouter } from '../src/routes/locations.js';

function createPrisma() {
  const users = new Map([
    ['TEST-USER-COORD', {
      id: 'TEST-USER-COORD',
      username: 'usuario-coordinacion',
      displayName: 'Usuario Coordinación',
      role: 'ADMIN',
      isActive: true,
      canAccessDispatch: false,
      canAccessAttendance: false
    }],
    ['TEST-USER-SUP', {
      id: 'TEST-USER-SUP',
      username: 'usuario-supervision',
      displayName: 'Usuario Supervisión',
      role: 'ADMIN',
      isActive: true,
      canAccessDispatch: true,
      canAccessAttendance: true
    }],
    ['TEST-USER-VIEW', {
      id: 'TEST-USER-VIEW',
      username: 'usuario-consulta',
      displayName: 'Usuario Consulta',
      role: 'ADMIN',
      isActive: true,
      canAccessDispatch: true,
      canAccessAttendance: false
    }]
  ]);
  const events = [];

  function actionMatches(eventAction, condition) {
    if (typeof condition === 'string') return eventAction === condition;
    if (condition?.in) return condition.in.includes(eventAction);
    return true;
  }

  return {
    users,
    events,
    appUser: {
      findUnique: async ({ where }) => {
        if (where?.id) return users.get(where.id) || null;
        if (where?.username) return [...users.values()].find((user) => user.username === where.username) || null;
        return null;
      },
      findMany: async () => [...users.values()],
      update: async ({ where, data }) => {
        const current = users.get(where.id);
        if (!current) return null;
        const next = { ...current, ...data };
        users.set(where.id, next);
        return next;
      }
    },
    devAuditEvent: {
      findFirst: async ({ where }) => {
        return [...events].reverse().find((event) => event.entityType === where.entityType
          && event.entityId === where.entityId
          && actionMatches(event.action, where.action)) || null;
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
    actorSource: 'env',
    actorAccessScope: 'ALL',
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

function operationsMenu(html) {
  return html.match(/<details[^>]*data-module-menu="operations"[\s\S]*?<\/details>/)?.[0] || '';
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

test('catálogo marca una sola raíz visible por módulo', () => {
  const roots = operationalAccessCatalog().capabilities.filter((item) => item.moduleAccess === true);
  assert.deepEqual(roots.map((item) => item.moduleAccessKey), ['dispatch', 'attendance', 'time']);
  assert.deepEqual(roots.map((item) => item.moduleLabel), [
    'Operaciones / Despacho',
    'Asistencia',
    'Asistencia y Gestión de Tiempo'
  ]);
});

test('la raíz del módulo manda sobre VIEW sin borrar la configuración interna', async () => {
  const prisma = createPrisma();
  const result = await setOperationalAccess(prisma, {
    targetUserId: 'TEST-USER-COORD',
    role: 'COORDINADOR',
    moduleAccess: { dispatch: true, attendance: false, time: false },
    permissions: effectiveState('COORDINADOR', {
      [OPERATIONAL_CAPABILITY.ATTENDANCE_MANAGE]: true,
      [OPERATIONAL_CAPABILITY.TIME_EXPORT]: true
    }),
    delegablePermissions: [],
    ...devActor()
  });

  assert.equal(result.effectivePermissions.includes(OPERATIONAL_CAPABILITY.DISPATCH_VIEW), true);
  assert.equal(result.effectivePermissions.includes(OPERATIONAL_CAPABILITY.ATTENDANCE_VIEW), false);
  assert.equal(result.effectivePermissions.includes(OPERATIONAL_CAPABILITY.TIME_VIEW), false);
  assert.equal(result.effectivePermissions.includes(OPERATIONAL_CAPABILITY.ATTENDANCE_MANAGE), true);
  assert.equal(result.effectivePermissions.includes(OPERATIONAL_CAPABILITY.TIME_EXPORT), true);
  assert.equal(result.metadata, undefined);
  assert.equal(prisma.events.at(-1).metadata.moduleAccessSynchronized, true);
});

test('Asistencia conserva la dependencia histórica de Operaciones / Despacho', async () => {
  const prisma = createPrisma();
  const result = await setOperationalAccess(prisma, {
    targetUserId: 'TEST-USER-COORD',
    role: 'CONSULTA',
    moduleAccess: { dispatch: false, attendance: true, time: false },
    permissions: effectiveState('CONSULTA'),
    delegablePermissions: [],
    ...devActor()
  });

  assert.equal(result.moduleAccess.dispatch, true);
  assert.equal(result.moduleAccess.attendance, true);
  assert.equal(result.effectivePermissions.includes(OPERATIONAL_CAPABILITY.DISPATCH_VIEW), true);
  assert.equal(result.effectivePermissions.includes(OPERATIONAL_CAPABILITY.ATTENDANCE_VIEW), true);
});

test('Supervisor inicia con administración sensible no destructiva y deja acciones críticas como opt-in de DEV', () => {
  const base = new Set(operationalRoleBasePermissions('SUPERVISOR'));
  assert.equal(base.has(OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_MANAGE), true);
  assert.equal(base.has(OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_STATUS), true);
  assert.equal(base.has(OPERATIONAL_CAPABILITY.DISPATCH_MASTERDATA_MANAGE), true);
  assert.equal(base.has(OPERATIONAL_CAPABILITY.ATTENDANCE_MANAGE), true);
  assert.equal(base.has(OPERATIONAL_CAPABILITY.ATTENDANCE_CONFIG), true);
  assert.equal(base.has(OPERATIONAL_CAPABILITY.TIME_EXPORT), true);
  assert.equal(base.has(OPERATIONAL_CAPABILITY.TIME_COMPENSATION), true);
  assert.equal(base.has(OPERATIONAL_CAPABILITY.SUPERVISE_PERMISSIONS), true);

  assert.equal(base.has(OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_DELETE), false);
  assert.equal(base.has(OPERATIONAL_CAPABILITY.DISPATCH_MASTERDATA_DELETE), false);
  assert.equal(base.has(OPERATIONAL_CAPABILITY.ATTENDANCE_CORRECT), false);
  assert.equal(base.has(OPERATIONAL_CAPABILITY.TIME_IMPORT), false);
  assert.equal(base.has(OPERATIONAL_CAPABILITY.TIME_IMPORT_REVERSE), false);
});

test('solo DEV define Supervisor, módulos raíz y techo delegable de funciones internas', async () => {
  const prisma = createPrisma();
  const supervisor = await setOperationalAccess(prisma, {
    targetUserId: 'TEST-USER-SUP',
    role: 'SUPERVISOR',
    permissions: effectiveState('SUPERVISOR'),
    delegablePermissions: [
      OPERATIONAL_CAPABILITY.DISPATCH_VIEW,
      OPERATIONAL_CAPABILITY.ATTENDANCE_VIEW,
      OPERATIONAL_CAPABILITY.TIME_VIEW,
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

test('Supervisor amplía o restringe únicamente funciones autorizadas y no cambia rol ni módulo', async () => {
  const prisma = createPrisma();
  await setOperationalAccess(prisma, {
    targetUserId: 'TEST-USER-COORD',
    role: 'COORDINADOR',
    moduleAccess: { dispatch: true, attendance: true, time: true },
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
      permissions: { [OPERATIONAL_CAPABILITY.DISPATCH_VIEW]: false },
      ...supervisorActor([OPERATIONAL_CAPABILITY.DISPATCH_VIEW, OPERATIONAL_CAPABILITY.TIME_EXPORT])
    }),
    /operational_access_capability_not_delegable/
  );

  await assert.rejects(
    setOperationalAccess(prisma, {
      targetUserId: 'TEST-USER-COORD',
      moduleAccess: { dispatch: false, attendance: false, time: false },
      permissions: { [OPERATIONAL_CAPABILITY.TIME_EXPORT]: false },
      ...supervisorActor([OPERATIONAL_CAPABILITY.TIME_EXPORT])
    }),
    /operational_module_access_dev_required/
  );

  await assert.rejects(
    setOperationalAccess(prisma, {
      targetUserId: 'TEST-USER-COORD',
      permissions: { [OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_DELETE]: true },
      ...supervisorActor([OPERATIONAL_CAPABILITY.ATTENDANCE_CORRECT])
    }),
    /operational_access_capability_not_delegable/
  );
});

test('delegación parcial de Supervisor conserva overrides previos que no fueron enviados', async () => {
  const prisma = createPrisma();
  await setOperationalAccess(prisma, {
    targetUserId: 'TEST-USER-COORD',
    role: 'COORDINADOR',
    permissions: effectiveState('COORDINADOR', {
      [OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_MANAGE]: true,
      [OPERATIONAL_CAPABILITY.DISPATCH_ASSIGNMENT_MANAGE]: false
    }),
    ...devActor()
  });

  const delegated = await setOperationalAccess(prisma, {
    targetUserId: 'TEST-USER-COORD',
    permissions: { [OPERATIONAL_CAPABILITY.TIME_EXPORT]: true },
    ...supervisorActor([OPERATIONAL_CAPABILITY.TIME_EXPORT])
  });

  assert.equal(delegated.effectivePermissions.includes(OPERATIONAL_CAPABILITY.TIME_EXPORT), true);
  assert.equal(delegated.effectivePermissions.includes(OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_MANAGE), true);
  assert.equal(delegated.effectivePermissions.includes(OPERATIONAL_CAPABILITY.DISPATCH_ASSIGNMENT_MANAGE), false);
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

  prisma.users.set('TEST-USER-SUP-2', {
    id: 'TEST-USER-SUP-2',
    username: 'usuario-supervision-dos',
    displayName: 'Usuario Supervisión Dos',
    role: 'ADMIN',
    isActive: true,
    canAccessDispatch: true,
    canAccessAttendance: true
  });
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
  assert.equal(requiredOperationalCapability({ method: 'GET', originalUrl: '/admin/operaciones/solicitudes' }), OPERATIONAL_CAPABILITY.DISPATCH_REQUEST_MANAGE);
  assert.equal(requiredOperationalCapability({ method: 'POST', originalUrl: '/admin/operaciones/solicitudes' }), OPERATIONAL_CAPABILITY.DISPATCH_REQUEST_MANAGE);
});

test('guardas centrales cubren también rutas operativas heredadas fuera de /admin/operaciones', () => {
  assert.equal(requiredOperationalCapability({ method: 'POST', originalUrl: '/operaciones/admin-delete/clientes/TEST-CLIENT' }), OPERATIONAL_CAPABILITY.DISPATCH_MASTERDATA_DELETE);
  assert.equal(requiredOperationalCapability({ method: 'POST', originalUrl: '/operaciones/admin-delete/personal/TEST-WORKER' }), OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_DELETE);
  assert.equal(requiredOperationalCapability({ method: 'POST', originalUrl: '/operaciones/admin-delete/solicitudes/TEST-REQUEST' }), OPERATIONAL_CAPABILITY.DISPATCH_REQUEST_MANAGE);
  assert.equal(requiredOperationalCapability({ method: 'POST', originalUrl: '/operaciones/admin-clientes' }), OPERATIONAL_CAPABILITY.DISPATCH_MASTERDATA_MANAGE);
  assert.equal(requiredOperationalCapability({ method: 'POST', originalUrl: '/operaciones/admin-worker/nuevo' }), OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_MANAGE);
});

test('navegación usa capacidades internas y no muestra Crear solicitud sin su permiso', () => {
  const baseHtml = '<!DOCTYPE html><html><head><title>Operaciones</title></head><body><nav class="navbar"><a href="/admin">Panel</a></nav><main>Contenido</main></body></html>';
  const request = {
    originalUrl: '/admin/operaciones',
    userRole: 'admin',
    canAccessDispatch: true,
    operationalAccessConfigured: true,
    operationalRole: 'CONSULTA',
    operationalEffectivePermissions: [OPERATIONAL_CAPABILITY.DISPATCH_VIEW],
    session: {
      userRole: 'admin',
      canAccessDispatch: true,
      operationalAccessConfigured: true,
      operationalRole: 'CONSULTA',
      operationalEffectivePermissions: [OPERATIONAL_CAPABILITY.DISPATCH_VIEW]
    }
  };
  const menu = operationsMenu(injectAdminModuleNavigation(baseHtml, request));
  assert.match(menu, /href="\/admin\/operaciones">Panel operativo<\/a>/);
  assert.doesNotMatch(menu, /href="\/admin\/operaciones\/solicitudes">Crear solicitud<\/a>/);
  assert.doesNotMatch(menu, /href="\/admin\/operaciones\/asignaciones">Asignación de auxiliares<\/a>/);

  request.operationalEffectivePermissions.push(OPERATIONAL_CAPABILITY.DISPATCH_REQUEST_MANAGE);
  request.session.operationalEffectivePermissions = request.operationalEffectivePermissions;
  const enabled = operationsMenu(injectAdminModuleNavigation(baseHtml, request));
  assert.match(enabled, /href="\/admin\/operaciones\/solicitudes">Crear solicitud<\/a>/);
});

test('API unificada sincroniza módulos legacy, VIEW y Gestión de Tiempo; Supervisor solo cambia funciones internas', async () => {
  const prisma = createPrisma();
  const app = express();
  app.use(express.json());
  let mode = 'dev';
  app.use((req, _res, next) => {
    req.session = mode === 'dev'
      ? { userRole: 'dev', userId: 'TEST-DEV', username: 'dev-prueba', userSource: 'env', userAccessScope: 'ALL' }
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
        moduleAccess: { dispatch: true, attendance: false, time: true },
        permissions: effectiveState('COORDINADOR'),
        delegablePermissions: []
      })
    });
    assert.equal(devResponse.status, 200);
    const devPayload = await devResponse.json();
    assert.deepEqual(devPayload.moduleAccess, { dispatch: true, attendance: false, time: true });
    assert.equal(prisma.users.get('TEST-USER-COORD').canAccessDispatch, true);
    assert.equal(prisma.users.get('TEST-USER-COORD').canAccessAttendance, false);

    let access = await getOperationalAccessForUser(prisma, 'TEST-USER-COORD');
    assert.equal(access.effectivePermissions.includes(OPERATIONAL_CAPABILITY.DISPATCH_VIEW), true);
    assert.equal(access.effectivePermissions.includes(OPERATIONAL_CAPABILITY.ATTENDANCE_VIEW), false);
    assert.equal(access.effectivePermissions.includes(OPERATIONAL_CAPABILITY.TIME_VIEW), true);
    assert.equal(prisma.events.some((event) => event.action === 'PAYROLL_ACCESS_ENABLED'), true);

    mode = 'supervisor';
    const delegated = await fetch(`http://127.0.0.1:${port}/admin/locations/users/TEST-USER-COORD/operational-access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: { [OPERATIONAL_CAPABILITY.TIME_EXPORT]: true } })
    });
    assert.equal(delegated.status, 200);
    access = await getOperationalAccessForUser(prisma, 'TEST-USER-COORD');
    assert.equal(access.role, 'COORDINADOR');
    assert.equal(access.effectivePermissions.includes(OPERATIONAL_CAPABILITY.TIME_EXPORT), true);

    const rootForbidden = await fetch(`http://127.0.0.1:${port}/admin/locations/users/TEST-USER-COORD/operational-access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        moduleAccess: { dispatch: false, attendance: false, time: false },
        permissions: { [OPERATIONAL_CAPABILITY.TIME_EXPORT]: false }
      })
    });
    assert.equal(rootForbidden.status, 403);

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

test('UI consolida el permiso general dentro del módulo y Supervisor recibe solo funciones internas', () => {
  const ui = readFileSync(new URL('../src/public/payroll-user-access.js', import.meta.url), 'utf8');
  const middleware = readFileSync(new URL('../src/services/dispatchAuditMiddleware.js', import.meta.url), 'utf8');

  assert.match(ui, /Rol, módulos y funciones/);
  assert.match(ui, /data\.operationalModuleAccess/);
  assert.match(ui, /item\.moduleAccess !== true/);
  assert.match(ui, /Asistencia y Gestión de Tiempo/);
  assert.match(ui, /Los roles y accesos a módulos siguen siendo exclusivos de DEV/);
  assert.doesNotMatch(ui, /const payrollPermission\s*=/);
  assert.match(middleware, /const supervisorPageAllowed = path\.startsWith\('\/admin\/operaciones'\) && canSupervise;/);
});

test('middleware ejecutado refresca permisos, falla cerrado y aplica la guarda antes de continuar', () => {
  const source = readFileSync(new URL('../src/services/dispatchAuditMiddleware.js', import.meta.url), 'utf8');
  assert.match(source, /if \(!enforceOperationalCapability\(req, res\)\) return;/);
  assert.match(source, /await refreshDatabaseUserPermissions\(prisma, req\)/);
  assert.match(source, /else denyOperationalAccess\(req\);/);
});
