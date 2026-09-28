import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { locationsRouter } from '../src/routes/locations.js';
import {
  getOperationalAccessForUser,
  OPERATIONAL_ACCESS_ACTION,
  OPERATIONAL_ACCESS_ENTITY_TYPE,
  OPERATIONAL_CAPABILITY
} from '../src/services/operationalAccess.js';

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function actionMatches(eventAction, condition) {
  if (typeof condition === 'string') return eventAction === condition;
  if (condition?.in) return condition.in.includes(eventAction);
  return true;
}

function createPrisma() {
  const users = new Map([
    ['SUP', {
      id: 'SUP',
      username: 'supervisor-prueba',
      displayName: 'Supervisor Prueba',
      email: 'supervisor@example.test',
      role: 'ADMIN',
      isActive: true,
      accessScope: 'CITY',
      scopeCity: 'Bogotá',
      scopeVacancyId: null,
      canAccessDispatch: true,
      canAccessAttendance: true
    }]
  ]);
  const events = [];
  const created = [];
  const vacancies = [
    { id: 'VAC-BOG-1', title: 'Auxiliar Bogotá', role: 'Auxiliar', city: 'Bogotá' },
    { id: 'VAC-BOG-2', title: 'Líder Bogotá', role: 'Líder', city: 'Bogotá' },
    { id: 'VAC-MED-1', title: 'Auxiliar Medellín', role: 'Auxiliar', city: 'Medellín' }
  ];
  let sequence = 0;

  const prisma = {
    users,
    events,
    created,
    city: {
      findMany: async () => [
        { id: 'CITY-BOG', name: 'Bogotá' },
        { id: 'CITY-MED', name: 'Medellín' }
      ]
    },
    vacancy: {
      findMany: async ({ where } = {}) => {
        const ids = where?.id?.in;
        const selected = Array.isArray(ids) ? vacancies.filter((vacancy) => ids.includes(vacancy.id)) : vacancies;
        return selected.map((vacancy) => ({ ...vacancy }));
      }
    },
    appUser: {
      findUnique: async ({ where }) => {
        if (where?.id) return users.get(where.id) || null;
        if (where?.username) return [...users.values()].find((user) => user.username === where.username) || null;
        if (where?.email) return [...users.values()].find((user) => user.email === where.email) || null;
        return null;
      },
      create: async ({ data }) => {
        const user = { id: `CREATED-${++sequence}`, ...data };
        users.set(user.id, user);
        created.push(user);
        return user;
      },
      update: async ({ where, data }) => {
        const current = users.get(where.id);
        if (!current) return null;
        const next = { ...current, ...data };
        users.set(where.id, next);
        return next;
      }
    },
    devAuditEvent: {
      findFirst: async ({ where }) => [...events].reverse().find((event) => (
        event.entityType === where.entityType
        && event.entityId === where.entityId
        && actionMatches(event.action, where.action)
      )) || null,
      create: async ({ data }) => {
        const event = { id: `EVENT-${events.length + 1}`, ...data };
        events.push(event);
        return event;
      }
    },
    $transaction: async (callback) => callback(prisma)
  };

  return prisma;
}

function supervisorSession(overrides = {}) {
  return {
    userRole: 'admin',
    userId: 'SUP',
    username: 'supervisor-prueba',
    userSource: 'db',
    userAccessScope: 'CITY',
    userAccessCity: 'Bogotá',
    userAccessVacancyId: null,
    operationalRole: 'SUPERVISOR',
    operationalAccessConfigured: true,
    operationalEffectivePermissions: [],
    operationalDelegablePermissions: [],
    canAccessDispatch: true,
    canAccessAttendance: true,
    ...overrides
  };
}

async function postCreate(prisma, session, body) {
  const app = express();
  app.use((req, _res, next) => {
    req.session = session;
    next();
  });
  app.use('/admin/locations', locationsRouter(prisma));

  const server = await listen(app);
  try {
    const { port } = server.address();
    return await fetch(`http://127.0.0.1:${port}/admin/locations/users/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
      redirect: 'manual'
    });
  } finally {
    await close(server);
  }
}

test('Supervisor conserva compatibilidad: si no selecciona alcance ni permisos, hereda su alcance y crea Consulta sin módulos', async () => {
  const prisma = createPrisma();
  const response = await postCreate(prisma, supervisorSession(), {
    displayName: 'Usuario Nuevo',
    email: 'Usuario.Nuevo@Example.Test',
    password: 'TEST-123456',
    recoveryPhone: '3001234567'
  });

  assert.equal(response.status, 302);
  assert.match(response.headers.get('location') || '', /^\/admin\/locations\/users\?/);
  assert.equal(prisma.created.length, 1);

  const created = prisma.created[0];
  assert.equal(created.displayName, 'Usuario Nuevo');
  assert.equal(created.email, 'usuario.nuevo@example.test');
  assert.equal(created.role, 'ADMIN');
  assert.equal(created.accessScope, 'CITY');
  assert.equal(created.scopeCity, 'Bogotá');
  assert.equal(created.scopeVacancyId, null);
  assert.equal(created.canAccessDispatch, false);
  assert.equal(created.canAccessAttendance, false);
  assert.equal(created.canAccessStatistics, false);
  assert.equal(created.canAccessMetaAds, false);
  assert.equal(created.canAccessCvAnalysis, false);
  assert.equal(created.createdByUsername, 'supervisor-prueba');

  const operational = await getOperationalAccessForUser(prisma, created.id);
  assert.equal(operational.configured, true);
  assert.equal(operational.implicit, false);
  assert.equal(operational.role, 'CONSULTA');
  assert.deepEqual(operational.effectivePermissions, []);
  assert.equal(operational.effectivePermissions.includes(OPERATIONAL_CAPABILITY.SUPERVISE_PERMISSIONS), false);

  const initialization = prisma.events.find((event) => (
    event.entityType === OPERATIONAL_ACCESS_ENTITY_TYPE
    && event.entityId === created.id
    && event.action === OPERATIONAL_ACCESS_ACTION
  ));
  assert.ok(initialization);
  assert.equal(initialization.toValue.role, 'CONSULTA');
  assert.equal(initialization.metadata.initializedBySupervisor, true);
  assert.equal(initialization.metadata.roleAssignedByDev, false);
});

test('Supervisor puede crear Consulta con alcance más estrecho y módulos/funciones configurados desde el inicio', async () => {
  const prisma = createPrisma();
  const operationalAccessConfig = JSON.stringify({
    role: 'SUPERVISOR',
    moduleAccess: { dispatch: true, attendance: false, time: true },
    permissions: {
      [OPERATIONAL_CAPABILITY.DISPATCH_REQUEST_MANAGE]: true,
      [OPERATIONAL_CAPABILITY.TIME_EXPORT]: true
    },
    delegablePermissions: [OPERATIONAL_CAPABILITY.SUPERVISE_PERMISSIONS]
  });

  const response = await postCreate(prisma, supervisorSession(), {
    displayName: 'Usuario Configurado',
    email: 'configurado@example.test',
    password: 'TEST-123456',
    accessScope: 'VACANCY',
    scopeCities: 'Bogotá',
    scopeVacancyIds: 'VAC-BOG-2',
    operationalAccessConfig
  });

  assert.equal(response.status, 302);
  assert.equal(prisma.created.length, 1);
  const created = prisma.created[0];
  assert.equal(created.accessScope, 'VACANCY');
  assert.equal(created.scopeCity, '{"cities":["Bogotá"],"vacancyIds":["VAC-BOG-2"]}');
  assert.equal(created.scopeVacancyId, 'VAC-BOG-2');
  assert.equal(created.canAccessDispatch, true);
  assert.equal(created.canAccessAttendance, false);

  const operational = await getOperationalAccessForUser(prisma, created.id);
  assert.equal(operational.role, 'CONSULTA');
  assert.equal(operational.effectivePermissions.includes(OPERATIONAL_CAPABILITY.DISPATCH_VIEW), true);
  assert.equal(operational.effectivePermissions.includes(OPERATIONAL_CAPABILITY.DISPATCH_REQUEST_MANAGE), true);
  assert.equal(operational.effectivePermissions.includes(OPERATIONAL_CAPABILITY.TIME_VIEW), true);
  assert.equal(operational.effectivePermissions.includes(OPERATIONAL_CAPABILITY.TIME_EXPORT), true);
  assert.equal(operational.effectivePermissions.includes(OPERATIONAL_CAPABILITY.SUPERVISE_PERMISSIONS), false);

  const initialization = prisma.events.find((event) => (
    event.entityType === OPERATIONAL_ACCESS_ENTITY_TYPE
    && event.entityId === created.id
  ));
  assert.equal(initialization.toValue.role, 'CONSULTA');
  assert.equal(initialization.metadata.roleAssignedByDev, false);
  assert.equal(initialization.metadata.initializedBySupervisor, true);

  const payroll = prisma.events.find((event) => event.entityType === 'APP_USER_PAYROLL_ACCESS' && event.entityId === created.id);
  assert.ok(payroll);
  assert.equal(payroll.action, 'PAYROLL_ACCESS_ENABLED');
});

test('Supervisor no puede crear un usuario fuera de su alcance territorial', async () => {
  const prisma = createPrisma();
  const response = await postCreate(prisma, supervisorSession(), {
    displayName: 'Usuario Fuera Alcance',
    email: 'fuera@example.test',
    password: 'TEST-123456',
    accessScope: 'CITY',
    scopeCities: 'Medellín'
  });

  assert.equal(response.status, 302);
  assert.equal(prisma.created.length, 0);
});

test('Supervisor con alcance VACANCY no puede elevar el usuario nuevo a ALL', async () => {
  const prisma = createPrisma();
  const response = await postCreate(prisma, supervisorSession({
    userAccessScope: 'VACANCY',
    userAccessCity: '{"cities":["Bogotá"],"vacancyIds":["VAC-BOG-1"]}',
    userAccessVacancyId: 'VAC-BOG-1'
  }), {
    displayName: 'Usuario Vacante',
    email: 'vacante@example.test',
    password: 'TEST-123456',
    accessScope: 'ALL'
  });

  assert.equal(response.status, 302);
  assert.equal(prisma.created.length, 0);
});

test('un ADMIN que no es Supervisor no puede crear usuarios por la ruta del Supervisor', async () => {
  const prisma = createPrisma();
  const response = await postCreate(prisma, supervisorSession({
    operationalRole: 'CONSULTA',
    operationalAccessConfigured: true
  }), {
    displayName: 'Usuario Bloqueado',
    email: 'bloqueado@example.test',
    password: 'TEST-123456'
  });

  assert.equal(response.status, 403);
  assert.equal(prisma.created.length, 0);
});
