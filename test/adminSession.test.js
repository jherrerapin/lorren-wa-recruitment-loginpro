import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  ADMIN_SESSION_DEFAULTS,
  ADMIN_SESSION_SECRET_ENV,
  ADMIN_SESSION_SECRET_MIN_LENGTH,
  KNOWN_INSECURE_SESSION_SECRETS,
  buildAdminSessionCookieClearOptions,
  createAdminLogoutHandler,
  createAdminSessionMiddleware,
  resolveAdminSessionConfig,
  resolveAdminSessionSecret
} from '../src/services/adminSession.js';

const TEST_DATABASE_URL = 'postgresql://test:test@localhost/test_database';
const TEST_SESSION_SECRET = 'TEST-SESSION-SECRET';
const TEST_PRODUCTION_SESSION_SECRET = 'TEST-PRODUCTION-SESSION-SECRET-0123456789ABCDEF';

function developmentEnvironment(overrides = {}) {
  return {
    NODE_ENV: 'development',
    DATABASE_URL: TEST_DATABASE_URL,
    SESSION_SECRET: TEST_SESSION_SECRET,
    ...overrides
  };
}

function productionEnvironment(overrides = {}) {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: TEST_DATABASE_URL,
    SESSION_SECRET: TEST_PRODUCTION_SESSION_SECRET,
    ...overrides
  };
}

test('la configuración de desarrollo exige un secreto explícito y conserva los defaults administrativos', () => {
  const config = resolveAdminSessionConfig(developmentEnvironment());

  assert.equal(config.isProduction, false);
  assert.equal(config.hasConfiguredSecret, true);
  assert.equal(config.cookieName, 'loginpro.sid');
  assert.equal(config.secret, TEST_SESSION_SECRET);
  assert.deepEqual(config.storeOptions, {
    conString: TEST_DATABASE_URL,
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

test('producción rechaza SESSION_SECRET ausente o vacío', () => {
  const missing = productionEnvironment();
  delete missing.SESSION_SECRET;
  const blank = productionEnvironment({ SESSION_SECRET: '   ' });

  assert.throws(
    () => resolveAdminSessionConfig(missing),
    { message: 'admin_session_secret_required' }
  );
  assert.throws(
    () => resolveAdminSessionConfig(blank),
    { message: 'admin_session_secret_required' }
  );
});

test('producción rechaza secretos débiles y valores predeterminados conocidos', () => {
  const weakSecret = 'TEST-WEAK-SECRET';
  assert.ok(weakSecret.length < ADMIN_SESSION_SECRET_MIN_LENGTH);
  assert.throws(
    () => resolveAdminSessionSecret(productionEnvironment({ SESSION_SECRET: weakSecret })),
    { message: 'admin_session_secret_insecure' }
  );

  for (const knownSecret of KNOWN_INSECURE_SESSION_SECRETS) {
    assert.throws(
      () => resolveAdminSessionSecret(productionEnvironment({ SESSION_SECRET: knownSecret })),
      { message: 'admin_session_secret_insecure' }
    );
  }
});

test('los errores de configuración no incluyen el secreto ni fragmentos del secreto', () => {
  const secret = 'TEST-WEAK-SECRET-DO-NOT-LOG';
  let thrown;
  try {
    resolveAdminSessionSecret(productionEnvironment({ SESSION_SECRET: secret }));
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof Error);
  assert.equal(thrown.message, 'admin_session_secret_insecure');
  assert.doesNotMatch(String(thrown.stack || thrown.message), /TEST-WEAK-SECRET-DO-NOT-LOG/);
});

test('producción acepta un secreto robusto y conserva el contrato de cookie', () => {
  assert.ok(TEST_PRODUCTION_SESSION_SECRET.length >= ADMIN_SESSION_SECRET_MIN_LENGTH);
  const config = resolveAdminSessionConfig(productionEnvironment({
    SESSION_COOKIE_NAME: 'TEST-custom.sid'
  }));

  assert.equal(config.isProduction, true);
  assert.equal(config.hasConfiguredSecret, true);
  assert.equal(config.cookieName, 'TEST-custom.sid');
  assert.equal(config.secret, TEST_PRODUCTION_SESSION_SECRET);
  assert.equal(config.sessionOptions.cookie.secure, true);
  assert.equal(config.sessionOptions.name, 'TEST-custom.sid');
  assert.equal(config.sessionOptions.secret, TEST_PRODUCTION_SESSION_SECRET);
  assert.equal(config.sessionOptions.resave, false);
  assert.equal(config.sessionOptions.saveUninitialized, false);
});

test('el entorno de pruebas usa una configuración explícita y determinística', () => {
  const config = resolveAdminSessionConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    SESSION_SECRET: 'TEST-DETERMINISTIC-SESSION-SECRET'
  });

  assert.equal(config.isProduction, false);
  assert.equal(config.secret, 'TEST-DETERMINISTIC-SESSION-SECRET');
  assert.equal(config.sessionOptions.cookie.secure, false);
});

test('el factory valida el secreto antes de crear el store', () => {
  let connectorCalls = 0;
  assert.throws(
    () => createAdminSessionMiddleware({
      env: {
        NODE_ENV: 'production',
        DATABASE_URL: TEST_DATABASE_URL
      },
      sessionModule: () => {},
      connectPgSimpleModule: () => {
        connectorCalls += 1;
        return class TestStore {};
      }
    }),
    { message: 'admin_session_secret_required' }
  );
  assert.equal(connectorCalls, 0);
});

test('el factory inyecta store, registra errores y devuelve el middleware con secreto explícito', () => {
  const calls = {
    connectorSessionModule: null,
    storeOptions: null,
    sessionOptions: null,
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
    error: (...args) => calls.errors.push(args)
  };

  const result = createAdminSessionMiddleware({
    env: developmentEnvironment(),
    logger,
    sessionModule: fakeSessionModule,
    connectPgSimpleModule: fakeConnectPgSimple
  });

  assert.equal(calls.connectorSessionModule, fakeSessionModule);
  assert.deepEqual(calls.storeOptions, {
    conString: TEST_DATABASE_URL,
    tableName: ADMIN_SESSION_DEFAULTS.storeTableName,
    createTableIfMissing: true,
    pruneSessionInterval: ADMIN_SESSION_DEFAULTS.pruneSessionIntervalSeconds
  });
  assert.equal(calls.sessionOptions.store, result.store);
  assert.equal(calls.sessionOptions.secret, TEST_SESSION_SECRET);
  assert.equal(typeof result.middleware, 'function');

  const storeError = new Error('TEST-STORE-FAILED');
  result.store.listeners.get('error')(storeError);
  assert.deepEqual(calls.errors[0], ['[SESSION_STORE_ERROR]', storeError]);
});

test('el cierre de sesión elimina la cookie configurada y redirige al login', () => {
  const config = resolveAdminSessionConfig(productionEnvironment({
    SESSION_COOKIE_NAME: 'TEST-custom.sid'
  }));
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
    ['clearCookie', 'TEST-custom.sid', {
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
    config: resolveAdminSessionConfig(developmentEnvironment())
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
  const storeError = new Error('TEST-STORE-UNAVAILABLE');
  const errors = [];
  const calls = [];
  const handler = createAdminLogoutHandler({
    config: resolveAdminSessionConfig(developmentEnvironment()),
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

test('la autoridad no conserva un secreto administrativo predeterminado', () => {
  const source = fs.readFileSync('src/services/adminSession.js', 'utf8');
  assert.doesNotMatch(source, /developmentSecret\s*:/);
  assert.match(source, new RegExp(`env\\?\\.\\[ADMIN_SESSION_SECRET_ENV\\]`));
  assert.equal(ADMIN_SESSION_SECRET_ENV, 'SESSION_SECRET');
});
