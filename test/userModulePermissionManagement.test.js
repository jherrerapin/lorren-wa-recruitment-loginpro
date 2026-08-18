import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { locationsRouter } from '../src/routes/locations.js';
import { canManageUserModulePermissions } from '../src/services/appUsers.js';

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

test('el módulo de permisos muestra Sucursales y habilita la edición para reclutador-general', () => {
  const usersView = readSource('src/views/users.ejs');
  const locationsSource = readSource('src/routes/locations.js');

  assert.match(usersView, /una o varias sucursales/);
  assert.match(usersView, />Una sucursal</);
  assert.match(usersView, />Sucursal<\/label>/);
  assert.match(usersView, /Todas las sucursales y vacantes/);
  assert.match(usersView, /Sucursales para consultar vacantes/);
  assert.match(usersView, /role === 'dev' \|\| currentUsername === 'reclutador-general'/);
  assert.match(usersView, /Solo DEV puede conceder permisos iniciales/);
  assert.match(locationsSource, /if \(canManageUserModulePermissions\(req\)\)/);
});
