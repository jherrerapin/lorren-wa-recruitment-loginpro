import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADMIN_SESSION_DEFAULTS,
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
