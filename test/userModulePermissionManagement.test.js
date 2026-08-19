import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { adminRouter } from '../src/routes/admin.js';
import { locationsRouter } from '../src/routes/locations.js';
import { canManageUserModulePermissions } from '../src/services/appUsers.js';
import { dedupeCitiesByNormalizedName } from '../src/services/cityOptions.js';

function readSource(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('la autoridad de permisos de módulos admite DEV y reclutador-general DB con alcance total', () => {
  assert.equal(canManageUserModulePermissions({ userRole: 'dev', userSource: 'env' }), true);
  assert.equal(canManageUserModulePermissions({
    userRole: 'admin',
    userSource: 'db',
    username: 'reclutador-general',
    userAccessScope: 'ALL'
  }), true);

  assert.equal(canManageUserModulePermissions({
    userRole: 'admin',
    userSource: 'db',
    username: 'reclutador-vacante',
    userAccessScope: 'ALL'
  }), false);
  assert.equal(canManageUserModulePermissions({
    userRole: 'admin',
    userSource: 'db',
    username: 'reclutador-general',
    userAccessScope: 'VACANCY'
  }), false);
  assert.equal(canManageUserModulePermissions({
    userRole: 'admin',
    userSource: 'env',
    username: 'reclutador-general',
    userAccessScope: 'ALL'
  }), false);
});

test('reclutador-general puede activar y retirar módulos de un usuario administrable', async () => {
  const updates = [];
  const prisma = {
    appUser: {
      findUnique: async () => ({
        id: 'user-1',
        username: 'reclutador-vacante',
        role: 'ADMIN',
        canAccessDispatch: false,
        canAccessAttendance: false,
        canAccessStatistics: false,
        canAccessMetaAds: false,
        canAccessCvAnalysis: false
      }),
      update: async ({ data }) => {
        updates.push(data);
        return { id: 'user-1' };
      }
    },
    vacancy: { findMany: async () => [] }
  };

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => {
    req.session = {
      userRole: 'admin',
      userId: 'general-1',
      username: 'reclutador-general',
      userSource: 'db',
      userAccessScope: 'ALL'
    };
    next();
  });
  app.use('/admin/locations', locationsRouter(prisma));

  const server = await listen(app);
  try {
    const { port } = server.address();
    const enabled = await fetch(`http://127.0.0.1:${port}/admin/locations/users/user-1/access`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'accessScope=ALL&canAccessAttendance=true&canAccessMetaAds=true&canAccessCvAnalysis=true',
      redirect: 'manual'
    });
    const disabled = await fetch(`http://127.0.0.1:${port}/admin/locations/users/user-1/access`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'accessScope=ALL',
      redirect: 'manual'
    });

    assert.equal(enabled.status, 302);
    assert.equal(disabled.status, 302);
    assert.deepEqual(
      {
        canAccessDispatch: updates[0].canAccessDispatch,
        canAccessAttendance: updates[0].canAccessAttendance,
        canAccessStatistics: updates[0].canAccessStatistics,
        canAccessMetaAds: updates[0].canAccessMetaAds,
        canAccessCvAnalysis: updates[0].canAccessCvAnalysis
      },
      {
        canAccessDispatch: true,
        canAccessAttendance: true,
        canAccessStatistics: true,
        canAccessMetaAds: true,
        canAccessCvAnalysis: true
      }
    );
    assert.deepEqual(
      {
        canAccessDispatch: updates[1].canAccessDispatch,
        canAccessAttendance: updates[1].canAccessAttendance,
        canAccessStatistics: updates[1].canAccessStatistics,
        canAccessMetaAds: updates[1].canAccessMetaAds,
        canAccessCvAnalysis: updates[1].canAccessCvAnalysis
      },
      {
        canAccessDispatch: false,
        canAccessAttendance: false,
        canAccessStatistics: false,
        canAccessMetaAds: false,
        canAccessCvAnalysis: false
      }
    );
  } finally {
    await close(server);
  }
});

test('catálogo de sucursales deduplica variantes y conserva el nombre canónico', () => {
  const cities = dedupeCitiesByNormalizedName([
    { id: 'branch-bogota-plain', name: 'Bogota' },
    { id: 'branch-bogota-canonical', name: 'Bogotá' },
    { id: 'branch-neiva', name: 'Neiva' },
    { id: 'city_legacy', name: 'Sucursal temporal' }
  ]);

  assert.deepEqual(cities.map((city) => city.name), ['Bogotá', 'Neiva']);
  assert.equal(cities[0].id, 'branch-bogota-canonical');
});

test('API de sucursales usa City aunque una sucursal no tenga vacantes', async () => {
  const prisma = {
    city: {
      findMany: async () => [
        { id: 'branch-bogota-plain', name: 'Bogota' },
        { id: 'branch-bogota-canonical', name: 'Bogotá' },
        { id: 'branch-neiva', name: 'Neiva' },
        { id: 'branch-no-vacancy', name: 'Pereira' }
      ]
    }
  };

  const app = express();
  app.use((req, _res, next) => {
    req.session = {
      userRole: 'admin',
      userId: 'general-1',
      username: 'reclutador-general',
      userSource: 'db',
      userAccessScope: 'ALL'
    };
    next();
  });
  app.use('/admin/locations', locationsRouter(prisma));

  const server = await listen(app);
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/admin/locations/api/cities`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.map((city) => city.name), ['Bogotá', 'Neiva', 'Pereira']);
  } finally {
    await close(server);
  }
});

test('edición de usuario conserva alcance CITY con varias sucursales', async () => {
  const updates = [];
  const prisma = {
    city: {
      findMany: async () => [
        { id: 'branch-bogota', name: 'Bogotá' },
        { id: 'branch-neiva', name: 'Neiva' }
      ]
    },
    appUser: {
      findUnique: async () => ({
        id: 'user-1',
        username: 'reclutador-multiple',
        role: 'ADMIN',
        canAccessDispatch: false,
        canAccessAttendance: false,
        canAccessStatistics: false,
        canAccessMetaAds: false,
        canAccessCvAnalysis: false
      }),
      update: async ({ data }) => {
        updates.push(data);
        return { id: 'user-1' };
      }
    },
    vacancy: { findMany: async () => [] }
  };

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => {
    req.session = {
      userRole: 'admin',
      userId: 'general-1',
      username: 'reclutador-general',
      userSource: 'db',
      userAccessScope: 'ALL'
    };
    next();
  });
  app.use('/admin/locations', locationsRouter(prisma));

  const server = await listen(app);
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/admin/locations/users/user-1/access`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'accessScope=CITY&scopeCities=Bogot%C3%A1&scopeCities=Neiva',
      redirect: 'manual'
    });

    assert.equal(response.status, 302);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].accessScope, 'CITY');
    assert.equal(updates[0].scopeCity, '["Bogotá","Neiva"]');
    assert.equal(updates[0].scopeVacancyId, null);
  } finally {
    await close(server);
  }
});

test('creación de usuario acepta el JSON compatible generado por múltiples checkboxes', async () => {
  const created = [];
  const prisma = {
    appUser: {
      findMany: async () => [],
      create: async ({ data }) => {
        created.push(data);
        return { id: 'created-user', ...data };
      }
    }
  };

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => {
    req.session = {
      userRole: 'admin',
      userId: 'env-admin',
      username: 'admin-test',
      userSource: 'env',
      userAccessScope: 'ALL'
    };
    next();
  });
  app.use('/admin', adminRouter(prisma));

  const server = await listen(app);
  try {
    const { port } = server.address();
    const params = new URLSearchParams({
      password: 'TEST-123456',
      accessScope: 'CITY',
      scopeCity: JSON.stringify(['Bogotá', 'Neiva'])
    });
    const response = await fetch(`http://127.0.0.1:${port}/admin/users/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      redirect: 'manual'
    });

    assert.equal(response.status, 302);
    assert.equal(created.length, 1);
    assert.equal(created[0].accessScope, 'CITY');
    assert.equal(created[0].scopeCity, '["Bogotá","Neiva"]');
    assert.equal(created[0].scopeVacancyId, null);
  } finally {
    await close(server);
  }
});

test('creación de usuario persiste varias vacantes seleccionadas y conserva la primera como compatibilidad', async () => {
  const created = [];
  const vacancies = [
    { id: 'vacancy-alpha', title: 'Auxiliar Alpha', role: 'Auxiliar', city: 'Bogotá' },
    { id: 'vacancy-beta', title: 'Auxiliar Beta', role: 'Auxiliar', city: 'Neiva' }
  ];
  const prisma = {
    appUser: {
      findMany: async () => [],
      create: async ({ data }) => {
        created.push(data);
        return { id: 'created-user', ...data };
      }
    },
    vacancy: {
      findMany: async ({ where } = {}) => {
        const requestedIds = where?.id?.in || [];
        return vacancies.filter((vacancy) => requestedIds.includes(vacancy.id));
      }
    }
  };

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => {
    req.session = {
      userRole: 'admin',
      userId: 'env-admin',
      username: 'admin-test',
      userSource: 'env',
      userAccessScope: 'ALL'
    };
    next();
  });
  app.use('/admin', adminRouter(prisma));

  const server = await listen(app);
  try {
    const { port } = server.address();
    const params = new URLSearchParams({
      password: 'TEST-123456',
      accessScope: 'VACANCY'
    });
    params.append('scopeVacancyIds', 'vacancy-alpha');
    params.append('scopeVacancyIds', 'vacancy-beta');

    const response = await fetch(`http://127.0.0.1:${port}/admin/users/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      redirect: 'manual'
    });

    assert.equal(response.status, 302);
    assert.equal(created.length, 1);
    assert.equal(created[0].accessScope, 'VACANCY');
    assert.equal(created[0].scopeVacancyId, 'vacancy-alpha');
    assert.deepEqual(JSON.parse(created[0].scopeCity), {
      cities: ['Bogotá', 'Neiva'],
      vacancyIds: ['vacancy-alpha', 'vacancy-beta']
    });
  } finally {
    await close(server);
  }
});

test('creación de usuario rechaza alcance VACANCY sin vacantes seleccionadas', async () => {
  const created = [];
  const prisma = {
    appUser: {
      findMany: async () => [],
      create: async ({ data }) => {
        created.push(data);
        return { id: 'created-user', ...data };
      }
    },
    vacancy: { findMany: async () => [] }
  };

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => {
    req.session = {
      userRole: 'admin',
      userId: 'env-admin',
      username: 'admin-test',
      userSource: 'env',
      userAccessScope: 'ALL'
    };
    next();
  });
  app.use('/admin', adminRouter(prisma));

  const server = await listen(app);
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/admin/users/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'TEST-123456', accessScope: 'VACANCY' }).toString(),
      redirect: 'manual'
    });

    assert.equal(response.status, 302);
    assert.equal(created.length, 0);
    assert.match(response.headers.get('location') || '', /Debes%20seleccionar%20al%20menos%20una%20vacante/);
  } finally {
    await close(server);
  }
});

test('el módulo de permisos muestra Sucursales y Vacantes con selección múltiple', () => {
  const usersView = readSource('src/views/users.ejs');
  const locationsSource = readSource('src/routes/locations.js');
  const adminSource = readSource('src/routes/admin.js');

  assert.match(usersView, /una o varias sucursales completas/);
  assert.match(usersView, />Una o varias sucursales</);
  assert.match(usersView, /id="createCityOptions"/);
  assert.match(usersView, /type="checkbox" name="scopeCities"/);
  assert.match(usersView, /id="scopeCity" name="scopeCity" type="hidden"/);
  assert.doesNotMatch(usersView, /<select id="scopeCity"/);
  assert.match(usersView, /fetch\('\/admin\/locations\/api\/cities'/);
  assert.match(usersView, /option value="CITY"/);
  assert.match(usersView, /Sucursales seleccionadas/);
  assert.match(usersView, /Todas las sucursales y vacantes/);
  assert.match(usersView, />Una o varias vacantes</);
  assert.match(usersView, /id="createVacancyOptions"/);
  assert.match(usersView, /type="checkbox" name="scopeVacancyIds"/);
  assert.doesNotMatch(usersView, /<select id="scopeVacancyId"/);
  assert.match(adminSource, /encodeUserAccessSelection/);
  assert.match(adminSource, /requestedVacancyIds/);
  assert.match(usersView, /role === 'dev' \|\| currentUsername === 'reclutador-general'/);
  assert.match(usersView, /Solo DEV puede conceder permisos iniciales/);
  assert.match(locationsSource, /router\.get\('\/api\/cities'/);
  assert.match(locationsSource, /if \(accessScope === 'CITY'\)/);
  assert.match(locationsSource, /if \(canManageUserModulePermissions\(req\)\)/);
});
