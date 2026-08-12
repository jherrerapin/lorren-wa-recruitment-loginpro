import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  ADMIN_SESSION_DEFAULTS,
  buildAdminSessionCookieClearOptions,
  createAdminLogoutHandler,
  createAdminSessionMiddleware,
  ensureEnvironmentDispatchProfile,
  resolveAdminSessionConfig
} from '../src/services/adminSession.js';

test('la configuración de desarrollo conserva los defaults administrativos actuales', () => {
  const config = resolveAdminSessionConfig({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://localhost/lorren'
  });

  assert.equal(config.isProduction, false);
  assert.equal(config.hasConfiguredSecret, false);
  assert.equal(config.cookieName, 'loginpro.sid');
  assert.equal(config.secret, 'dev-session-secret-change-me');
  assert.deepEqual(config.storeOptions, {
    conString: 'postgresql://localhost/lorren',
    tableName: 'session',
    createTableIfMissing: true,
    pruneSessionInterval: 3600
  });
  assert.deepEqual(config.sessionOptions.cookie, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    path: '/',
    maxAge: 1000 * 60 * 60 * 8
  });
});

test('producción usa secreto y cookie configurados sin alterar el contrato', () => {
  const config = resolveAdminSessionConfig({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://db/production',
    SESSION_COOKIE_NAME: 'custom.sid',
    SESSION_SECRET: 'configured-secret'
  });

  assert.equal(config.isProduction, true);
  assert.equal(config.hasConfiguredSecret, true);
  assert.equal(config.cookieName, 'custom.sid');
  assert.equal(config.secret, 'configured-secret');
  assert.equal(config.sessionOptions.cookie.secure, true);
  assert.equal(config.sessionOptions.name, 'custom.sid');
  assert.equal(config.sessionOptions.secret, 'configured-secret');
  assert.equal(config.sessionOptions.resave, false);
  assert.equal(config.sessionOptions.saveUninitialized, false);
});

test('una sesión env de despacho sin AppUser crea un perfil persistente para alertas personales', async () => {
  const created = [];
  const sessionData = {
    userId: null,
    userSource: 'env',
    userRole: 'admin',
    username: 'operaciones-despacho-principal',
    canAccessDispatch: false,
    canAccessAttendance: false,
    canAccessStatistics: false,
    canAccessMetaAds: false,
    canAccessCvAnalysis: false
  };
  const prismaClient = {
    appUser: {
      findUnique: async () => null,
      create: async ({ data }) => {
        created.push(data);
        return { id: 'app-user-1', ...data };
      }
    }
  };
  const bcryptModule = {
    hash: async (value, rounds) => {
      assert.equal(value, 'abcd');
      assert.equal(rounds, 10);
      return 'random-hash';
    }
  };

  const profile = await ensureEnvironmentDispatchProfile(sessionData, {
    prismaClient,
    bcryptModule,
    randomBytesFn: () => Buffer.from('abcd', 'utf8')
  });

  assert.equal(profile.id, 'app-user-1');
  assert.equal(sessionData.userId, 'app-user-1');
  assert.equal(created.length, 1);
  assert.equal(created[0].username, 'operaciones-despacho-principal');
  assert.equal(created[0].passwordHash, 'random-hash');
  assert.equal(created[0].role, 'ADMIN');
  assert.equal(created[0].canAccessDispatch, true);
  assert.equal(created[0].isActive, true);
});

test('el puente reutiliza un AppUser existente y no crea duplicados', async () => {
  let createCalls = 0;
  const sessionData = {
    userId: null,
    userSource: 'env',
    userRole: 'dev',
    username: 'dev-env',
    canAccessDispatch: true
  };
  const existing = { id: 'existing-user', username: 'dev-env', isActive: true };
  const prismaClient = {
    appUser: {
      findUnique: async () => existing,
      create: async () => {
        createCalls += 1;
        return null;
      }
    }
  };

  const profile = await ensureEnvironmentDispatchProfile(sessionData, { prismaClient });

  assert.equal(profile, existing);
  assert.equal(sessionData.userId, 'existing-user');
  assert.equal(createCalls, 0);
});

test('una sesión que no proviene de env no se autoaprovisiona', async () => {
  let queries = 0;
  const sessionData = {
    userId: null,
    userSource: 'db',
    userRole: 'admin',
    username: 'usuario-db',
    canAccessDispatch: true
  };
  const prismaClient = {
    appUser: {
      findUnique: async () => {
        queries += 1;
        return null;
      }
    }
  };

  const profile = await ensureEnvironmentDispatchProfile(sessionData, { prismaClient });

  assert.equal(profile, null);
  assert.equal(sessionData.userId, null);
  assert.equal(queries, 0);
});

test('el factory inyecta store, registra errores y devuelve el middleware', () => {
  const calls = {
    connectorSessionModule: null,
    storeOptions: null,
    sessionOptions: null,
    warnings: [],
    errors: []
  };

  class FakeStore {
    constructor(options) {
      calls.storeOptions = options;
      this.listeners = new Map();
    }

    on(event, listener) {
      this.listeners.set(event, listener);
    }
  }

  function fakeSessionModule(options) {
    calls.sessionOptions = options;
    return function fakeSessionMiddleware(_req, _res, next) {
      next();
    };
  }

  function fakeConnectPgSimple(sessionModule) {
    calls.connectorSessionModule = sessionModule;
    return FakeStore;
  }

  const logger = {
    warn: (...args) => calls.warnings.push(args),
    error: (...args) => calls.errors.push(args)
  };

  const result = createAdminSessionMiddleware({
    env: {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://localhost/test'
    },
    logger,
    sessionModule: fakeSessionModule,
    connectPgSimpleModule: fakeConnectPgSimple
  });

  assert.equal(calls.connectorSessionModule, fakeSessionModule);
  assert.deepEqual(calls.storeOptions, {
    conString: 'postgresql://localhost/test',
    tableName: ADMIN_SESSION_DEFAULTS.storeTableName,
    createTableIfMissing: true,
    pruneSessionInterval: ADMIN_SESSION_DEFAULTS.pruneSessionIntervalSeconds
  });
  assert.equal(calls.sessionOptions.store, result.store);
  assert.equal(typeof result.middleware, 'function');
  assert.equal(calls.warnings.length, 1);
  assert.match(calls.warnings[0][0], /SESSION_SECRET/);

  const storeError = new Error('store failed');
  result.store.listeners.get('error')(storeError);
  assert.deepEqual(calls.errors[0], ['[SESSION_STORE_ERROR]', storeError]);
});

test('el middleware completa userId del perfil env antes de continuar con las rutas', async () => {
  const calls = [];
  class FakeStore {
    on() {}
  }
  function fakeSessionModule() {
    return function fakeSessionMiddleware(req, _res, next) {
      req.session = {
        userId: null,
        userSource: 'env',
        userRole: 'admin',
        username: 'operaciones-despacho-alertas',
        canAccessDispatch: false
      };
      next();
    };
  }
  const prismaClient = {
    appUser: {
      findUnique: async () => ({ id: 'profile-9', username: 'operaciones-despacho-alertas', isActive: true })
    }
  };
  const result = createAdminSessionMiddleware({
    env: { NODE_ENV: 'development', DATABASE_URL: 'postgresql://localhost/test' },
    logger: { warn: () => {}, error: () => {} },
    sessionModule: fakeSessionModule,
    connectPgSimpleModule: () => FakeStore,
    prismaClient
  });
  const req = {};

  await new Promise((resolve, reject) => {
    result.middleware(req, {}, (error) => {
      if (error) return reject(error);
      calls.push(req.session.userId);
      return resolve();
    });
  });

  assert.deepEqual(calls, ['profile-9']);
});

test('el cierre de sesión elimina la cookie configurada y redirige al login', () => {
  const config = resolveAdminSessionConfig({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://db/production',
    SESSION_COOKIE_NAME: 'custom.sid',
    SESSION_SECRET: 'configured-secret'
  });
  const calls = [];
  const handler = createAdminLogoutHandler({ config });
  const req = {
    session: {
      destroy(callback) {
        calls.push(['destroy']);
        callback(null);
      }
    }
  };
  const res = {
    set: (...args) => calls.push(['set', ...args]),
    clearCookie: (...args) => calls.push(['clearCookie', ...args]),
    redirect: (...args) => calls.push(['redirect', ...args])
  };

  handler(req, res);

  assert.deepEqual(calls, [
    ['destroy'],
    ['set', 'Cache-Control', 'no-store'],
    ['clearCookie', 'custom.sid', {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: true
    }],
    ['redirect', 303, '/login']
  ]);
  assert.deepEqual(buildAdminSessionCookieClearOptions(config), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: true
  });
});

test('el cierre de sesión redirige aunque la sesión ya no exista', () => {
  const calls = [];
  const handler = createAdminLogoutHandler({
    config: resolveAdminSessionConfig({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://localhost/test'
    })
  });

  handler({}, {
    set: (...args) => calls.push(['set', ...args]),
    clearCookie: (...args) => calls.push(['clearCookie', ...args]),
    redirect: (...args) => calls.push(['redirect', ...args])
  });

  assert.equal(calls.some(([name]) => name === 'clearCookie'), true);
  assert.deepEqual(calls.at(-1), ['redirect', 303, '/login']);
});

test('un error al destruir la sesión se registra pero no deja al usuario atrapado en logout', () => {
  const storeError = new Error('store unavailable');
  const errors = [];
  const calls = [];
  const handler = createAdminLogoutHandler({
    config: resolveAdminSessionConfig({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://localhost/test'
    }),
    logger: { error: (...args) => errors.push(args) }
  });

  handler({
    session: {
      destroy(callback) {
        callback(storeError);
      }
    }
  }, {
    set: (...args) => calls.push(['set', ...args]),
    clearCookie: (...args) => calls.push(['clearCookie', ...args]),
    redirect: (...args) => calls.push(['redirect', ...args])
  });

  assert.deepEqual(errors, [['[LOGOUT_DESTROY_ERROR]', storeError]]);
  assert.deepEqual(calls.at(-1), ['redirect', 303, '/login']);
});

test('server conecta GET y POST logout con la autoridad de sesión configurada', () => {
  const source = fs.readFileSync('src/server.js', 'utf8');
  assert.match(source, /config: adminSessionConfig/);
  assert.match(source, /createAdminLogoutHandler\(\{ config: adminSessionConfig \}\)/);
  assert.match(source, /app\.post\('\/logout', destroySession\)/);
  assert.match(source, /app\.get\('\/logout', destroySession\)/);
  assert.doesNotMatch(source, /sessionCookieName/);
});
