import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  ADMIN_SESSION_DEFAULTS,
  buildAdminSessionCookieClearOptions,
  createAdminLogoutHandler,
  createAdminSessionMiddleware,
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
