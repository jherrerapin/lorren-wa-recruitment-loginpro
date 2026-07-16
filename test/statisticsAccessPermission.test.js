import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { locationsRouter } from '../src/routes/locations.js';
import { dispatchAuditMiddleware } from '../src/services/dispatchAuditMiddleware.js';
import {
  canManageLorenV2,
  canSeeLorenV2,
  requireLorenV2,
  requireLorenV2Write
} from '../src/services/lorenV2Gate.js';

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

test('AppUser declara un permiso de Estadísticas cerrado por defecto y su migración', () => {
  const schema = readSource('prisma/schema.prisma');
  assert.match(schema, /canAccessStatistics\s+Boolean\s+@default\(false\)/);
  assert.match(schema, /@@index\(\[canAccessStatistics\]\)/);

  const migrationsDir = new URL('../prisma/migrations', import.meta.url);
  const migrations = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('_add_statistics_access_to_app_user'))
    .map((entry) => readFileSync(join(migrationsDir.pathname, entry.name, 'migration.sql'), 'utf8'));

  assert.ok(migrations.some((source) => /ADD COLUMN "canAccessStatistics" BOOLEAN NOT NULL DEFAULT false/.test(source)));
  assert.ok(migrations.some((source) => /CREATE INDEX "AppUser_canAccessStatistics_idx"/.test(source)));
});

test('la guarda permite Estadísticas por permiso explícito sin ampliar las vacantes', () => {
  const now = new Date('2026-07-15T12:00:00-05:00');
  const user = {
    userRole: 'admin',
    username: 'reclutador-vacante',
    userAccessScope: 'VACANCY',
    canAccessStatistics: true
  };

  assert.equal(canSeeLorenV2(user, now), true);
  assert.equal(canSeeLorenV2({ ...user, canAccessStatistics: false }, now), false);
  assert.equal(canSeeLorenV2({ session: { canAccessStatistics: true } }, now), false);
  assert.equal(canManageLorenV2(user, now), false);
  assert.equal(canManageLorenV2({ userRole: 'admin', username: 'reclutador-general', userAccessScope: 'ALL' }, now), true);

  let nextCalled = false;
  requireLorenV2(user, {
    status: () => ({ send: () => assert.fail('No debe rechazar el permiso explícito') })
  }, () => { nextCalled = true; });
  assert.equal(nextCalled, true);

  let statusCode = null;
  requireLorenV2Write(user, {
    status: (status) => {
      statusCode = status;
      return { send: () => {} };
    }
  }, () => assert.fail('El permiso de consulta no debe habilitar escrituras sensibles'));
  assert.equal(statusCode, 403);
});

test('el refresco de una sesión activa aplica asignaciones y revocaciones de Estadísticas', async () => {
  let canAccessStatistics = true;
  let isActive = true;
  const prisma = {
    appUser: {
      findUnique: async () => ({
        isActive,
        accessScope: 'VACANCY',
        scopeCity: null,
        scopeVacancyId: 'vac-1',
        canAccessDispatch: false,
        canAccessStatistics
      })
    }
  };
  const middleware = dispatchAuditMiddleware(prisma);
  const req = {
    method: 'GET',
    path: '/admin',
    session: { userSource: 'db', userId: 'user-1' }
  };

  await middleware(req, {}, () => {});
  assert.equal(req.canAccessStatistics, true);
  assert.equal(req.session.canAccessStatistics, true);

  canAccessStatistics = false;
  await middleware(req, {}, () => {});
  assert.equal(req.canAccessStatistics, false);
  assert.equal(req.session.canAccessStatistics, false);

  isActive = false;
  req.session.userRole = 'admin';
  req.session.userId = 'user-1';
  req.session.canAccessStatistics = true;
  await middleware(req, {}, () => {});
  assert.equal(req.session.userRole, null);
  assert.equal(req.session.canAccessStatistics, false);
});

test('DEV puede asignar y retirar el permiso desde la edición del usuario', async () => {
  const updates = [];
  const prisma = {
    appUser: {
      findUnique: async () => ({
        id: 'user-1',
        username: 'reclutador-vacante',
        role: 'ADMIN',
        canAccessDispatch: false,
        canAccessStatistics: false
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
      userRole: 'dev',
      userId: 'dev-1',
      username: 'devloginpro',
      userSource: 'env'
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
      body: 'accessScope=ALL&canAccessStatistics=true',
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
    assert.equal(updates[0].canAccessStatistics, true);
    assert.equal(updates[1].canAccessStatistics, false);
  } finally {
    await close(server);
  }
});

test('un administrador que no es DEV no puede alterar el permiso de Estadísticas', async () => {
  let savedData = null;
  const prisma = {
    appUser: {
      findUnique: async () => ({
        id: 'user-1',
        username: 'reclutador-vacante',
        role: 'ADMIN',
        canAccessDispatch: false,
        canAccessStatistics: false
      }),
      update: async ({ data }) => {
        savedData = data;
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
      userId: 'admin-1',
      username: 'reclutador',
      userSource: 'env'
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
      body: 'accessScope=ALL&canAccessStatistics=true',
      redirect: 'manual'
    });

    assert.equal(response.status, 302);
    assert.equal(Object.hasOwn(savedData, 'canAccessStatistics'), false);
  } finally {
    await close(server);
  }
});

test('interfaz y endpoints auxiliares usan el mismo permiso de Estadísticas', () => {
  const usersView = readSource('src/views/users.ejs');
  const server = readSource('src/server.js');
  const cvAnalysis = readSource('src/routes/lorenV2CvAnalysis.js');
  const dataConsents = readSource('src/routes/lorenV2DataConsents.js');
  const dailySummary = readSource('src/routes/lorenV2DailySummary.js');
  const reports = readSource('src/routes/lorenV2Reports.js');
  const metaAds = readSource('src/routes/metaAdsStats.js');

  assert.match(usersView, /name="canAccessStatistics"/);
  assert.match(usersView, /Acceso al módulo de Estadísticas/);
  assert.match(usersView, /user\.canAccessStatistics \? 'checked' : ''/);
  assert.match(usersView, /role === 'dev'[\s\S]*name="canAccessStatistics"/);
  assert.match(server, /function canManageStats\(req = \{\}\) \{\s*return canManageLorenV2\(req\);\s*\}/);
  assert.match(server, /meta\/sync-form[\s\S]*!canManageStats\(req\)/);

  for (const source of [cvAnalysis, dataConsents, dailySummary, reports, metaAds]) {
    assert.match(source, /getAccessContext/);
  }
  for (const source of [cvAnalysis, dataConsents, dailySummary, reports, metaAds]) {
    assert.match(source, /buildCandidateAccessWhere|buildVacancyAccessWhere/);
  }
  assert.match(dataConsents, /post\('\/:candidateId\/accept', requireLorenV2Write/);
  assert.match(dataConsents, /post\('\/:candidateId\/revoke', requireLorenV2Write/);
  assert.match(metaAds, /if \(!canManageLorenV2\(req\)\) return res\.status\(403\)/);

  const sessionMiddleware = server.indexOf('app.use(session({');
  const permissionRefresh = server.indexOf('app.use(dispatchAuditMiddleware(prisma));');
  const statisticsViewPermission = server.indexOf('res.locals.canSeeLorenV2 = canSeeLorenV2(req);');
  assert.ok(sessionMiddleware < permissionRefresh, 'El refresco requiere una sesión ya disponible.');
  assert.ok(permissionRefresh < statisticsViewPermission, 'El permiso debe refrescarse antes de renderizar la navegación.');
});
