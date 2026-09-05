import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync } from 'node:fs';
import {
  canManageOperationalPermissions,
  getOperationalAccessForUser,
  hasOperationalCapability,
  OPERATIONAL_ACCESS_ACTION,
  OPERATIONAL_ACCESS_ENTITY_TYPE,
  OPERATIONAL_CAPABILITY,
  operationalAccessCatalog,
  operationalRoleBasePermissions,
  setOperationalAccess,
  supervisorAssignableOperationalCapabilities
} from '../src/services/operationalAccess.js';
import { injectAdminModuleNavigation } from '../src/services/adminNavigation.js';
import { requiredOperationalCapability } from '../src/services/dispatchAuditMiddleware.js';
import { locationsRouter } from '../src/routes/locations.js';

function createPrisma() {
  const users = new Map([
    ['TEST-USER-NORMAL', {
      id: 'TEST-USER-NORMAL',
      username: 'usuario-normal',
      displayName: 'Usuario Normal',
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
      canAccessDispatch: false,
      canAccessAttendance: false
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

function supervisorActor(overrides = {}) {
  return {
    actorUserId: 'TEST-USER-SUP',
    actorUsername: 'usuario-supervision',
    actorRole: 'admin',
    actorOperationalRole: 'SUPERVISOR',
    actorOperationalAccessConfigured: true,
    actorEffectivePermissions: [],
    actorDelegablePermissions: [],
    ...overrides
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

function usersLink(html) {
  return html.match(/<a[^>]*data-standalone-link="users"[\s\S]*?<\/a>/)?.[0] || '';
}

test('catálogo nuevo solo ofrece Consulta y Supervisor; Coordinador queda fuera de asignación', async () => {
  assert.deepEqual(operationalAccessCatalog().roles.map((role) => role.key), ['CONSULTA', 'SUPERVISOR']);

  const prisma = createPrisma();
  await assert.rejects(
    setOperationalAccess(prisma, {
      targetUserId: 'TEST-USER-NORMAL',
      role: 'COORDINADOR',
      permissions: effectiveState('COORDINADOR'),
      ...devActor()
    }),
    /operational_role_invalid/
  );
});

test('DEV asigna Consulta y puede ampliar o restringir funciones individuales', async () => {
  const prisma = createPrisma();
  const permissions = effectiveState('CONSULTA', {
    [OPERATIONAL_CAPABILITY.DISPATCH_REQUEST_MANAGE]: true,
    [OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_MANAGE]: true,
    [OPERATIONAL_CAPABILITY.ATTENDANCE_VIEW]: false
  });

  const result = await setOperationalAccess(prisma, {
    targetUserId: 'TEST-USER-NORMAL',
    role: 'CONSULTA',
    permissions,
    ...devActor()
  });

  assert.equal(result.role, 'CONSULTA');
  assert.equal(result.effectivePermissions.includes(OPERATIONAL_CAPABILITY.DISPATCH_REQUEST_MANAGE), true);
  assert.equal(result.effectivePermissions.includes(OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_MANAGE), true);
  assert.equal(result.effectivePermissions.includes(OPERATIONAL_CAPABILITY.ATTENDANCE_VIEW), false);
  assert.equal(prisma.events.at(-1).metadata.roleAssignedByDev, true);
});

test('configuración histórica Coordinador se lee como Consulta sin perder permisos efectivos', async () => {
  const prisma = createPrisma();
  prisma.events.push({
    id: 'TEST-LEGACY-COORD',
    entityType: OPERATIONAL_ACCESS_ENTITY_TYPE,
    entityId: 'TEST-USER-NORMAL',
    action: OPERATIONAL_ACCESS_ACTION,
    toValue: {
      role: 'COORDINADOR',
      grants: [OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_MANAGE],
      denials: [OPERATIONAL_CAPABILITY.DISPATCH_ASSIGNMENT_MANAGE],
      delegablePermissions: []
    },
    createdAt: new Date('2026-08-01T00:00:00Z')
  });

  const access = await getOperationalAccessForUser(prisma, 'TEST-USER-NORMAL');
  assert.equal(access.role, 'CONSULTA');
  assert.equal(access.effectivePermissions.includes(OPERATIONAL_CAPABILITY.DISPATCH_REQUEST_MANAGE), true);
  assert.equal(access.effectivePermissions.includes(OPERATIONAL_CAPABILITY.DISPATCH_ASSIGNMENT_MANAGE), false);
  assert.equal(access.effectivePermissions.includes(OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_MANAGE), true);
  assert.deepEqual(access.delegablePermissions, []);
});

test('catálogo marca una sola raíz visible por módulo', () => {
  const roots = operationalAccessCatalog().capabilities.filter((item) => item.moduleAccess === true);
  assert.deepEqual(roots.map((item) => item.moduleAccessKey), ['dispatch', 'attendance', 'time']);
  assert.deepEqual(roots.map((item) => item.moduleLabel), [
    'Operaciones / Despacho',
    'Asistencia',
    'Gestión de Tiempo'
  ]);
});

test('la raíz del módulo manda sobre VIEW sin borrar funciones internas', async () => {
  const prisma = createPrisma();
  const result = await setOperationalAccess(prisma, {
    targetUserId: 'TEST-USER-NORMAL',
    role: 'CONSULTA',
    moduleAccess: { dispatch: true, attendance: false, time: false },
    permissions: effectiveState('CONSULTA', {
      [OPERATIONAL_CAPABILITY.ATTENDANCE_MANAGE]: true,
      [OPERATIONAL_CAPABILITY.TIME_EXPORT]: true
    }),
    ...devActor()
  });

  assert.equal(result.effectivePermissions.includes(OPERATIONAL_CAPABILITY.DISPATCH_VIEW), true);
  assert.equal(result.effectivePermissions.includes(OPERATIONAL_CAPABILITY.ATTENDANCE_VIEW), false);
  assert.equal(result.effectivePermissions.includes(OPERATIONAL_CAPABILITY.TIME_VIEW), false);
  assert.equal(result.effectivePermissions.includes(OPERATIONAL_CAPABILITY.ATTENDANCE_MANAGE), true);
  assert.equal(result.effectivePermissions.includes(OPERATIONAL_CAPABILITY.TIME_EXPORT), true);
  assert.equal(prisma.events.at(-1).metadata.moduleAccessSynchronized, true);
});

test('Asistencia conserva la dependencia histórica de Operaciones / Despacho', async () => {
  const prisma = createPrisma();
  const result = await setOperationalAccess(prisma, {
    targetUserId: 'TEST-USER-NORMAL',
    role: 'CONSULTA',
    moduleAccess: { dispatch: false, attendance: true, time: false },
    permissions: effectiveState('CONSULTA'),
    ...devActor()
  });

  assert.equal(result.moduleAccess.dispatch, true);
  assert.equal(result.moduleAccess.attendance, true);
  assert.equal(result.effectivePermissions.includes(OPERATIONAL_CAPABILITY.DISPATCH_VIEW), true);
  assert.equal(result.effectivePermissions.includes(OPERATIONAL_CAPABILITY.ATTENDANCE_VIEW), true);
});

test('Supervisor administra permisos por rol, sin techo delegable ni dependencia de sus módulos propios', async () => {
  const prisma = createPrisma();
  await setOperationalAccess(prisma, {
    targetUserId: 'TEST-USER-NORMAL',
    role: 'CONSULTA',
    moduleAccess: { dispatch: false, attendance: false, time: false },
    permissions: effectiveState('CONSULTA'),
    ...devActor()
  });

  assert.equal(canManageOperationalPermissions({
    userRole: 'admin',
    operationalRole: 'SUPERVISOR',
    operationalAccessConfigured: true,
    operationalEffectivePermissions: []
  }), true);
  assert.equal(canManageOperationalPermissions({
    userRole: 'admin',
    operationalRole: 'CONSULTA',
    operationalAccessConfigured: true
  }), false);

  const assignable = new Set(supervisorAssignableOperationalCapabilities());
  assert.equal(assignable.has(OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_DELETE), true);
  assert.equal(assignable.has(OPERATIONAL_CAPABILITY.TIME_IMPORT_REVERSE), true);
  assert.equal(assignable.has(OPERATIONAL_CAPABILITY.SUPERVISE_PERMISSIONS), false);
  assert.equal(assignable.has(OPERATIONAL_CAPABILITY.DISPATCH_VIEW), false);

  const result = await setOperationalAccess(prisma, {
    targetUserId: 'TEST-USER-NORMAL',
    moduleAccess: { dispatch: true, attendance: false, time: true },
    permissions: {
      [OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_DELETE]: true,
      [OPERATIONAL_CAPABILITY.TIME_IMPORT_REVERSE]: true
    },
    ...supervisorActor({
      actorEffectivePermissions: [],
      actorDelegablePermissions: []
    })
  });

  assert.equal(result.role, 'CONSULTA');
  assert.deepEqual(result.moduleAccess, { dispatch: true, attendance: false, time: true });
  assert.equal(result.effectivePermissions.includes(OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_DELETE), true);
  assert.equal(result.effectivePermissions.includes(OPERATIONAL_CAPABILITY.TIME_IMPORT_REVERSE), true);
  assert.equal(prisma.events.at(-1).metadata.delegatedBySupervisor, true);
});

test('Supervisor no puede cambiar roles, autoeditarse, editar otro Supervisor ni conceder supervisión', async () => {
  const prisma = createPrisma();
  await setOperationalAccess(prisma, {
    targetUserId: 'TEST-USER-NORMAL',
    role: 'CONSULTA',
    permissions: effectiveState('CONSULTA'),
    ...devActor()
  });
  await setOperationalAccess(prisma, {
    targetUserId: 'TEST-USER-SUP',
    role: 'SUPERVISOR',
    permissions: effectiveState('SUPERVISOR'),
    ...devActor()
  });

  await assert.rejects(
    setOperationalAccess(prisma, {
      targetUserId: 'TEST-USER-NORMAL',
      role: 'SUPERVISOR',
      permissions: {},
      ...supervisorActor()
    }),
    /operational_role_dev_required/
  );
  await assert.rejects(
    setOperationalAccess(prisma, {
      targetUserId: 'TEST-USER-NORMAL',
      delegablePermissions: [OPERATIONAL_CAPABILITY.TIME_EXPORT],
      permissions: {},
      ...supervisorActor()
    }),
    /operational_delegation_dev_required/
  );
  await assert.rejects(
    setOperationalAccess(prisma, {
      targetUserId: 'TEST-USER-NORMAL',
      permissions: { [OPERATIONAL_CAPABILITY.SUPERVISE_PERMISSIONS]: true },
      ...supervisorActor()
    }),
    /operational_access_capability_not_delegable/
  );
  await assert.rejects(
    setOperationalAccess(prisma, {
      targetUserId: 'TEST-USER-SUP',
      permissions: { [OPERATIONAL_CAPABILITY.TIME_EXPORT]: true },
      ...supervisorActor()
    }),
    /operational_access_self_forbidden/
  );

  prisma.users.set('TEST-USER-SUP-2', {
    id: 'TEST-USER-SUP-2',
    username: 'usuario-supervision-dos',
    displayName: 'Usuario Supervisión Dos',
    role: 'ADMIN',
    isActive: true,
    canAccessDispatch: false,
    canAccessAttendance: false
  });
  await setOperationalAccess(prisma, {
    targetUserId: 'TEST-USER-SUP-2',
    role: 'SUPERVISOR',
    permissions: effectiveState('SUPERVISOR'),
    ...devActor()
  });
  await assert.rejects(
    setOperationalAccess(prisma, {
      targetUserId: 'TEST-USER-SUP-2',
      permissions: { [OPERATIONAL_CAPABILITY.TIME_EXPORT]: true },
      ...supervisorActor()
    }),
    /operational_access_supervisor_target_forbidden/
  );
});

test('delegación parcial de Supervisor conserva overrides previos que no fueron enviados', async () => {
  const prisma = createPrisma();
  await setOperationalAccess(prisma, {
    targetUserId: 'TEST-USER-NORMAL',
    role: 'CONSULTA',
    permissions: effectiveState('CONSULTA', {
      [OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_MANAGE]: true,
      [OPERATIONAL_CAPABILITY.DISPATCH_VIEW]: false
    }),
    ...devActor()
  });

  const delegated = await setOperationalAccess(prisma, {
    targetUserId: 'TEST-USER-NORMAL',
    permissions: { [OPERATIONAL_CAPABILITY.TIME_EXPORT]: true },
    ...supervisorActor()
  });

  assert.equal(delegated.effectivePermissions.includes(OPERATIONAL_CAPABILITY.TIME_EXPORT), true);
  assert.equal(delegated.effectivePermissions.includes(OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_MANAGE), true);
  assert.equal(delegated.effectivePermissions.includes(OPERATIONAL_CAPABILITY.DISPATCH_VIEW), false);
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

test('guardas centrales distinguen acciones sensibles de Despacho, Gestión de Tiempo', () => {
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

test('navegación oculta Usuarios a Consulta y lo muestra al Supervisor', () => {
  const baseHtml = '<!DOCTYPE html><html><head><title>Panel</title></head><body><nav class="navbar"><a href="/admin">Panel</a></nav><main>Contenido</main></body></html>';
  const consulta = {
    originalUrl: '/admin',
    userRole: 'admin',
    operationalAccessConfigured: true,
    operationalRole: 'CONSULTA',
    operationalEffectivePermissions: [],
    session: {
      userRole: 'admin',
      operationalAccessConfigured: true,
      operationalRole: 'CONSULTA',
      operationalEffectivePermissions: []
    }
  };
  assert.equal(usersLink(injectAdminModuleNavigation(baseHtml, consulta)), '');

  const supervisor = {
    ...consulta,
    operationalRole: 'SUPERVISOR',
    session: { ...consulta.session, operationalRole: 'SUPERVISOR' }
  };
  assert.match(usersLink(injectAdminModuleNavigation(baseHtml, supervisor)), /href="\/admin\/locations\/users"/);
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

  request.operationalEffectivePermissions.push(OPERATIONAL_CAPABILITY.DISPATCH_REQUEST_MANAGE);
  request.session.operationalEffectivePermissions = request.operationalEffectivePermissions;
  const enabled = operationsMenu(injectAdminModuleNavigation(baseHtml, request));
  assert.match(enabled, /href="\/admin\/operaciones\/solicitudes">Crear solicitud<\/a>/);
});

test('API unificada deja a Supervisor administrar todos los módulos y funciones de Consulta sin cambiar rol', async () => {
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
          operationalEffectivePermissions: [],
          operationalDelegablePermissions: []
        };
    next();
  });
  app.use('/admin/locations', locationsRouter(prisma));

  const server = await listen(app);
  try {
    const { port } = server.address();
    const devResponse = await fetch(`http://127.0.0.1:${port}/admin/locations/users/TEST-USER-NORMAL/operational-access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        role: 'CONSULTA',
        moduleAccess: { dispatch: true, attendance: false, time: false },
        permissions: effectiveState('CONSULTA')
      })
    });
    assert.equal(devResponse.status, 200);

    mode = 'supervisor';
    const listResponse = await fetch(`http://127.0.0.1:${port}/admin/locations/users/operational-access`);
    assert.equal(listResponse.status, 200);
    const listPayload = await listResponse.json();
    assert.deepEqual(listPayload.editableModules, ['dispatch', 'attendance', 'time']);
    assert.equal(listPayload.editableCapabilities.includes(OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_DELETE), true);
    assert.equal(listPayload.editableCapabilities.includes(OPERATIONAL_CAPABILITY.TIME_IMPORT_REVERSE), true);
    assert.equal(listPayload.editableCapabilities.includes(OPERATIONAL_CAPABILITY.SUPERVISE_PERMISSIONS), false);

    const delegated = await fetch(`http://127.0.0.1:${port}/admin/locations/users/TEST-USER-NORMAL/operational-access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        role: 'SUPERVISOR',
        moduleAccess: { dispatch: false, attendance: true, time: true },
        permissions: {
          [OPERATIONAL_CAPABILITY.ATTENDANCE_CORRECT]: true,
          [OPERATIONAL_CAPABILITY.TIME_IMPORT_REVERSE]: true
        }
      })
    });
    assert.equal(delegated.status, 200);
    const payload = await delegated.json();
    assert.deepEqual(payload.moduleAccess, { dispatch: true, attendance: true, time: true });
    assert.equal(prisma.users.get('TEST-USER-NORMAL').canAccessDispatch, true);
    assert.equal(prisma.users.get('TEST-USER-NORMAL').canAccessAttendance, true);

    const access = await getOperationalAccessForUser(prisma, 'TEST-USER-NORMAL');
    assert.equal(access.role, 'CONSULTA');
    assert.equal(access.effectivePermissions.includes(OPERATIONAL_CAPABILITY.ATTENDANCE_CORRECT), true);
    assert.equal(access.effectivePermissions.includes(OPERATIONAL_CAPABILITY.TIME_IMPORT_REVERSE), true);
    assert.equal(prisma.events.some((event) => event.action === 'PAYROLL_ACCESS_ENABLED'), true);
  } finally {
    await close(server);
  }
});

test('UI DEV no ofrece Coordinador ni techo delegable y UI Supervisor administra módulos y funciones', () => {
  const devUi = readFileSync(new URL('../src/public/payroll-user-access.js', import.meta.url), 'utf8');
  const supervisorUi = readFileSync(new URL('../src/public/supervisor-user-access.js', import.meta.url), 'utf8');

  assert.match(devUi, /Rol, módulos y funciones/);
  assert.match(devUi, /Selecciona Consulta o Supervisor/);
  assert.doesNotMatch(devUi, /Funciones internas que este Supervisor puede delegar/);
  assert.doesNotMatch(devUi, /Solo DEV define este techo/);
  assert.doesNotMatch(devUi, /const payrollPermission\s*=/);

  assert.match(supervisorUi, /Guardar módulos y funciones/);
  assert.match(supervisorUi, /No hay usuarios Consulta disponibles para administrar/);
  assert.doesNotMatch(supervisorUi, /DEV no delegó funciones/);
  assert.doesNotMatch(supervisorUi, /Consulta o Coordinador/);
});

test('middleware ejecutado refresca permisos, falla cerrado y aplica la guarda antes de continuar', () => {
  const source = readFileSync(new URL('../src/services/dispatchAuditMiddleware.js', import.meta.url), 'utf8');
  assert.match(source, /if \(!enforceOperationalCapability\(req, res\)\) return;/);
  assert.match(source, /await refreshDatabaseUserPermissions\(prisma, req\)/);
  assert.match(source, /else denyOperationalAccess\(req\);/);
});
