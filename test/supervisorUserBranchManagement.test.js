import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { locationsRouter } from '../src/routes/locations.js';
import {
  OPERATIONAL_ACCESS_ACTION,
  OPERATIONAL_ACCESS_ENTITY_TYPE
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

function createPrisma() {
  const users = new Map([
    ['SUP', {
      id: 'SUP',
      username: 'supervisor-prueba',
      displayName: 'Supervisor Prueba',
      role: 'ADMIN',
      isActive: true,
      accessScope: 'CITY',
      scopeCity: '["Bogotá","Neiva"]',
      scopeVacancyId: null,
      canAccessDispatch: true,
      canAccessAttendance: true
    }],
    ['USER', {
      id: 'USER',
      username: 'consulta-prueba',
      displayName: 'Consulta Prueba',
      role: 'ADMIN',
      isActive: true,
      accessScope: 'ALL',
      scopeCity: null,
      scopeVacancyId: null,
      canAccessDispatch: true,
      canAccessAttendance: false
    }]
  ]);
  const events = [{
    id: 'ACCESS-USER',
    entityType: OPERATIONAL_ACCESS_ENTITY_TYPE,
    entityId: 'USER',
    action: OPERATIONAL_ACCESS_ACTION,
    toValue: {
      role: 'CONSULTA',
      grants: [],
      denials: [],
      delegablePermissions: []
    },
    createdAt: new Date('2026-09-28T12:00:00Z')
  }];
  const vacancies = [
    { id: 'VAC-BOG', title: 'Auxiliar Bogotá', role: 'Auxiliar', city: 'Bogotá' },
    { id: 'VAC-NEI', title: 'Auxiliar Neiva', role: 'Auxiliar', city: 'Neiva' },
    { id: 'VAC-MED', title: 'Auxiliar Medellín', role: 'Auxiliar', city: 'Medellín' }
  ];

  return {
    users,
    city: {
      findMany: async () => [
        { id: 'CITY-BOG', name: 'Bogotá' },
        { id: 'CITY-NEI', name: 'Neiva' },
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
        return null;
      },
      findMany: async () => [...users.values()].map((user) => ({ ...user })),
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

function supervisorSession(overrides = {}) {
  return {
    userRole: 'admin',
    userId: 'SUP',
    username: 'supervisor-prueba',
    userSource: 'db',
    userAccessScope: 'CITY',
    userAccessCity: '["Bogotá","Neiva"]',
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

async function withServer(prisma, session, callback) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = session;
    next();
  });
  app.use('/admin/locations', locationsRouter(prisma));
  const server = await listen(app);
  try {
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await close(server);
  }
}

test('Supervisor puede asignar y quitar sucursales dentro de su propio alcance', async () => {
  const prisma = createPrisma();
  const response = await withServer(prisma, supervisorSession(), (baseUrl) => fetch(`${baseUrl}/admin/locations/users/USER/territorial-scope`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessScope: 'CITY', scopeCities: ['Bogotá'] })
  }));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.territorialScope, { accessScope: 'CITY', cities: ['Bogotá'], vacancyIds: [] });

  const updated = prisma.users.get('USER');
  assert.equal(updated.accessScope, 'CITY');
  assert.equal(updated.scopeCity, 'Bogotá');
  assert.equal(updated.scopeVacancyId, null);
});

test('Supervisor no puede asignar una sucursal fuera de su propio alcance aunque manipule el request', async () => {
  const prisma = createPrisma();
  const response = await withServer(prisma, supervisorSession(), (baseUrl) => fetch(`${baseUrl}/admin/locations/users/USER/territorial-scope`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessScope: 'CITY', scopeCities: ['Medellín'] })
  }));

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'territorial_scope_forbidden');
  assert.equal(prisma.users.get('USER').accessScope, 'ALL');
  assert.equal(prisma.users.get('USER').scopeCity, null);
});

test('Supervisor con alcance ALL puede devolver un usuario a todas las sucursales', async () => {
  const prisma = createPrisma();
  prisma.users.set('USER', {
    ...prisma.users.get('USER'),
    accessScope: 'CITY',
    scopeCity: 'Bogotá'
  });
  const response = await withServer(prisma, supervisorSession({
    userAccessScope: 'ALL',
    userAccessCity: null
  }), (baseUrl) => fetch(`${baseUrl}/admin/locations/users/USER/territorial-scope`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessScope: 'ALL', scopeCities: [] })
  }));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.territorialScope, { accessScope: 'ALL', cities: [], vacancyIds: [] });
  assert.equal(prisma.users.get('USER').accessScope, 'ALL');
  assert.equal(prisma.users.get('USER').scopeCity, null);
});

test('API del Supervisor expone las sucursales administrables y el alcance actual de cada Consulta', async () => {
  const prisma = createPrisma();
  prisma.users.set('USER', {
    ...prisma.users.get('USER'),
    accessScope: 'CITY',
    scopeCity: 'Neiva'
  });

  const response = await withServer(prisma, supervisorSession(), (baseUrl) => fetch(`${baseUrl}/admin/locations/users/operational-access`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.scopeOptions.allowedCities, ['Bogotá', 'Neiva']);
  assert.equal(body.scopeOptions.canAssignAll, false);
  const user = body.users.find((item) => item.userId === 'USER');
  assert.ok(user);
  assert.deepEqual(user.territorialScope, { accessScope: 'CITY', cities: ['Neiva'], vacancyIds: [] });
});
