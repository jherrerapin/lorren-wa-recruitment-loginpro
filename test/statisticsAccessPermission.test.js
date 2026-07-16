import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { locationsRouter } from '../src/routes/locations.js';
import { dispatchAuditMiddleware } from '../src/services/dispatchAuditMiddleware.js';
import {
  canManageLorenV2,
  canSeeCvAnalysis,
  canSeeLorenV2,
  canSeeMetaAds,
  requireCvAnalysis,
  requireLorenV2,
  requireLorenV2Write,
  requireMetaAds
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

test('AppUser declara permisos cerrados para cada herramienta de Estadísticas y sus migraciones', () => {
  const schema = readSource('prisma/schema.prisma');
  assert.match(schema, /canAccessStatistics\s+Boolean\s+@default\(false\)/);
  assert.match(schema, /canAccessMetaAds\s+Boolean\s+@default\(false\)/);
  assert.match(schema, /canAccessCvAnalysis\s+Boolean\s+@default\(false\)/);
  assert.match(schema, /@@index\(\[canAccessStatistics\]\)/);
  assert.match(schema, /@@index\(\[canAccessMetaAds\]\)/);
  assert.match(schema, /@@index\(\[canAccessCvAnalysis\]\)/);

  const migrationsDir = new URL('../prisma/migrations', import.meta.url);
  const migrations = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('_add_statistics_access_to_app_user'))
    .map((entry) => readFileSync(join(migrationsDir.pathname, entry.name, 'migration.sql'), 'utf8'));

  assert.ok(migrations.some((source) => /ADD COLUMN "canAccessStatistics" BOOLEAN NOT NULL DEFAULT false/.test(source)));
  assert.ok(migrations.some((source) => /CREATE INDEX "AppUser_canAccessStatistics_idx"/.test(source)));

  const granularMigrations = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('_add_statistics_submodule_access'))
    .map((entry) => readFileSync(join(migrationsDir.pathname, entry.name, 'migration.sql'), 'utf8'));
  assert.ok(granularMigrations.some((source) => /ADD COLUMN "canAccessMetaAds" BOOLEAN NOT NULL DEFAULT false/.test(source)));
  assert.ok(granularMigrations.some((source) => /ADD COLUMN "canAccessCvAnalysis" BOOLEAN NOT NULL DEFAULT false/.test(source)));
  assert.ok(granularMigrations.some((source) => /WHERE "canAccessStatistics" = true/.test(source)));
});

test('la guarda separa Meta Ads y Análisis HV sin ampliar las vacantes', () => {
  const now = new Date('2026-07-15T12:00:00-05:00');
  const user = {
    userRole: 'admin',
    username: 'reclutador-vacante',
    userAccessScope: 'VACANCY',
    canAccessMetaAds: true,
    canAccessCvAnalysis: false
  };

  assert.equal(canSeeLorenV2(user, now), true);
  assert.equal(canSeeMetaAds(user, now), true);
  assert.equal(canSeeCvAnalysis(user, now), false);
  assert.equal(canSeeMetaAds({ ...user, canAccessMetaAds: false, canAccessCvAnalysis: true }, now), false);
  assert.equal(canSeeCvAnalysis({ ...user, canAccessMetaAds: false, canAccessCvAnalysis: true }, now), true);
  assert.equal(canSeeLorenV2({ ...user, canAccessMetaAds: false }, now), false);
  assert.equal(canSeeLorenV2({ session: { canAccessStatistics: true } }, now), false);
  assert.equal(canManageLorenV2(user, now), false);
  const general = { userRole: 'admin', username: 'reclutador-general', userAccessScope: 'ALL' };
  assert.equal(canManageLorenV2(general, now), true);
  assert.equal(canSeeMetaAds(general, now), true);
  assert.equal(canSeeCvAnalysis(general, now), true);

  let nextCalled = false;
  requireLorenV2(user, {
    status: () => ({ send: () => assert.fail('No debe rechazar el permiso explícito') })
  }, () => { nextCalled = true; });
  assert.equal(nextCalled, true);

  let metaNextCalled = false;
  requireMetaAds(user, {
    status: () => ({ send: () => assert.fail('Meta Ads debe estar habilitado') })
  }, () => { metaNextCalled = true; });
  assert.equal(metaNextCalled, true);

  let cvStatusCode = null;
  requireCvAnalysis(user, {
    status: (status) => {
      cvStatusCode = status;
      return { send: () => {} };
    }
  }, () => assert.fail('Análisis HV debe permanecer bloqueado'));
  assert.equal(cvStatusCode, 403);

  let statusCode = null;
  requireLorenV2Write(user, {
    status: (status) => {
      statusCode = status;
      return { send: () => {} };
    }
  }, () => assert.fail('El permiso de consulta no debe habilitar escrituras sensibles'));
  assert.equal(statusCode, 403);
});

test('el refresco de una sesión activa aplica cada permiso de Estadísticas por separado', async () => {
  let canAccessMetaAds = true;
  let canAccessCvAnalysis = false;
  let isActive = true;
  const prisma = {
    appUser: {
      findUnique: async () => ({
        isActive,
        accessScope: 'VACANCY',
        scopeCity: null,
        scopeVacancyId: 'vac-1',
        canAccessDispatch: false,
        canAccessStatistics: canAccessMetaAds || canAccessCvAnalysis,
        canAccessMetaAds,
        canAccessCvAnalysis
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
  assert.equal(req.canAccessMetaAds, true);
  assert.equal(req.canAccessCvAnalysis, false);

  canAccessMetaAds = false;
  canAccessCvAnalysis = true;
  await middleware(req, {}, () => {});
  assert.equal(req.canAccessStatistics, true);
  assert.equal(req.canAccessMetaAds, false);
  assert.equal(req.canAccessCvAnalysis, true);

  canAccessCvAnalysis = false;
  await middleware(req, {}, () => {});
  assert.equal(req.canAccessStatistics, false);

  isActive = false;
  req.session.userRole = 'admin';
  req.session.userId = 'user-1';
  req.session.canAccessStatistics = true;
  req.session.canAccessMetaAds = true;
  req.session.canAccessCvAnalysis = true;
  await middleware(req, {}, () => {});
  assert.equal(req.session.userRole, null);
  assert.equal(req.session.canAccessStatistics, false);
  assert.equal(req.session.canAccessMetaAds, false);
  assert.equal(req.session.canAccessCvAnalysis, false);
});

test('DEV puede asignar y retirar Meta Ads y Análisis HV por separado', async () => {
  const updates = [];
  const prisma = {
    appUser: {
      findUnique: async () => ({
        id: 'user-1',
        username: 'reclutador-vacante',
        role: 'ADMIN',
        canAccessDispatch: false,
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
      body: 'accessScope=ALL&canAccessMetaAds=true&canAccessCvAnalysis=true',
      redirect: 'manual'
    });
    const disabled = await fetch(`http://127.0.0.1:${port}/admin/locations/users/user-1/access`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'accessScope=ALL&canAccessCvAnalysis=true',
      redirect: 'manual'
    });

    assert.equal(enabled.status, 302);
    assert.equal(disabled.status, 302);
    assert.equal(updates[0].canAccessStatistics, true);
    assert.equal(updates[0].canAccessMetaAds, true);
    assert.equal(updates[0].canAccessCvAnalysis, true);
    assert.equal(updates[1].canAccessStatistics, true);
    assert.equal(updates[1].canAccessMetaAds, false);
    assert.equal(updates[1].canAccessCvAnalysis, true);
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
        canAccessStatistics: false,
        canAccessMetaAds: false,
        canAccessCvAnalysis: false
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
      body: 'accessScope=ALL&canAccessMetaAds=true&canAccessCvAnalysis=true',
      redirect: 'manual'
    });

    assert.equal(response.status, 302);
    assert.equal(Object.hasOwn(savedData, 'canAccessStatistics'), false);
    assert.equal(Object.hasOwn(savedData, 'canAccessMetaAds'), false);
    assert.equal(Object.hasOwn(savedData, 'canAccessCvAnalysis'), false);
  } finally {
    await close(server);
  }
});

test('interfaz y rutas exponen solo Meta Ads y Análisis HV con permisos separados', () => {
  const usersView = readSource('src/views/users.ejs');
  const server = readSource('src/server.js');
  const hub = readSource('src/routes/lorenV2.js');
  const cvAnalysis = readSource('src/routes/lorenV2CvAnalysis.js');
  const metaAds = readSource('src/routes/metaAdsStats.js');

  assert.match(usersView, /name="canAccessMetaAds"/);
  assert.match(usersView, /name="canAccessCvAnalysis"/);
  assert.match(usersView, />Meta Ads</);
  assert.match(usersView, />Análisis de hojas de vida</);
  assert.doesNotMatch(usersView, /name="canAccessStatistics"/);
  assert.match(server, /function canManageStats\(req = \{\}\) \{\s*return canManageLorenV2\(req\);\s*\}/);
  assert.match(server, /meta\/sync-form[\s\S]*!canManageStats\(req\)/);
  assert.match(hub, /router\.use\(requireMetaAds, metaAdsStatsRouter/);
  assert.match(cvAnalysis, /router\.use\(requireCvAnalysis\)/);
  assert.match(cvAnalysis, /canSeeMetaAds/);
  assert.match(metaAds, /canSeeCvAnalysis/);
  assert.match(metaAds, />Meta Ads<\/a>/);
  assert.doesNotMatch(cvAnalysis, />Campañas<\/a>|>Resumen diario<\/a>|>Reportes<\/a>|>Datos personales<\/a>/);
  assert.doesNotMatch(server, /lorenV2DailySummaryRouter|lorenV2ReportsRouter|lorenV2DataConsentsRouter/);
  assert.match(server, /\$\{LOREN_STATS_BASE_PATH\}\/daily-summary`[^\n]*redirect\(301, LOREN_STATS_BASE_PATH\)/);
  assert.match(server, /\$\{LOREN_STATS_BASE_PATH\}\/reports`[^\n]*redirect\(301, LOREN_STATS_BASE_PATH\)/);
  assert.match(server, /\$\{LOREN_STATS_BASE_PATH\}\/data-consents`[^\n]*redirect\(301, LOREN_STATS_BASE_PATH\)/);
  for (const source of [cvAnalysis, metaAds]) {
    assert.match(source, /getAccessContext/);
    assert.match(source, /buildCandidateAccessWhere|buildVacancyAccessWhere/);
  }
  assert.match(metaAds, /if \(!canManageLorenV2\(req\)\) return res\.status\(403\)/);

  const sessionMiddleware = server.indexOf('app.use(session({');
  const permissionRefresh = server.indexOf('app.use(dispatchAuditMiddleware(prisma));');
  const statisticsViewPermission = server.indexOf('res.locals.canSeeLorenV2 = canSeeLorenV2(req);');
  assert.ok(sessionMiddleware < permissionRefresh, 'El refresco requiere una sesión ya disponible.');
  assert.ok(permissionRefresh < statisticsViewPermission, 'El permiso debe refrescarse antes de renderizar la navegación.');
});
