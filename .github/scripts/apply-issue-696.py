from pathlib import Path

service_path = Path('src/services/adminSession.js')
service = service_path.read_text(encoding='utf-8')

cookie_anchor = """        sameSite: 'lax',
        secure: isProduction,
        maxAge: ADMIN_SESSION_DEFAULTS.maxAgeMs
"""
cookie_replacement = """        sameSite: 'lax',
        secure: isProduction,
        path: '/',
        maxAge: ADMIN_SESSION_DEFAULTS.maxAgeMs
"""
if cookie_anchor not in service:
    raise SystemExit('adminSession.js: no se encontró la configuración de cookie esperada')
service = service.replace(cookie_anchor, cookie_replacement, 1)

factory_anchor = "export function createAdminSessionMiddleware({\n"
helpers = """export function buildAdminSessionCookieClearOptions(config = resolveAdminSessionConfig()) {
  const cookie = config?.sessionOptions?.cookie || {};
  return {
    path: cookie.path || '/',
    httpOnly: cookie.httpOnly !== false,
    sameSite: cookie.sameSite || 'lax',
    secure: Boolean(cookie.secure)
  };
}

export function createAdminLogoutHandler({
  config = resolveAdminSessionConfig(),
  logger = console
} = {}) {
  const cookieName = config.cookieName;
  const cookieOptions = buildAdminSessionCookieClearOptions(config);

  return function destroyAdminSession(req, res) {
    const finishLogout = () => {
      res.set('Cache-Control', 'no-store');
      res.clearCookie(cookieName, cookieOptions);
      return res.redirect(303, '/login');
    };

    if (!req.session || typeof req.session.destroy !== 'function') {
      return finishLogout();
    }

    return req.session.destroy((error) => {
      if (error) logger.error('[LOGOUT_DESTROY_ERROR]', error);
      return finishLogout();
    });
  };
}

"""
if factory_anchor not in service:
    raise SystemExit('adminSession.js: no se encontró el factory de sesión')
service = service.replace(factory_anchor, helpers + factory_anchor, 1)
service_path.write_text(service, encoding='utf-8')

server_path = Path('src/server.js')
server = server_path.read_text(encoding='utf-8')
old_import = "import { createAdminSessionMiddleware } from './services/adminSession.js';"
new_import = "import { createAdminLogoutHandler, createAdminSessionMiddleware } from './services/adminSession.js';"
if old_import not in server:
    raise SystemExit('server.js: no se encontró el import de adminSession')
server = server.replace(old_import, new_import, 1)

old_session_setup = """const { middleware: adminSessionMiddleware } = createAdminSessionMiddleware();
app.use(adminSessionMiddleware);
"""
new_session_setup = """const { middleware: adminSessionMiddleware, config: adminSessionConfig } = createAdminSessionMiddleware();
const destroySession = createAdminLogoutHandler({ config: adminSessionConfig });
app.use(adminSessionMiddleware);
"""
if old_session_setup not in server:
    raise SystemExit('server.js: no se encontró la inicialización de sesión')
server = server.replace(old_session_setup, new_session_setup, 1)

old_logout = """const destroySession = (req, res) => {
  req.session.destroy(() => {
    res.clearCookie(sessionCookieName);
    res.redirect('/login');
  });
};

app.post('/logout', destroySession);
app.get('/logout', destroySession);
"""
new_logout = """app.post('/logout', destroySession);
app.get('/logout', destroySession);
"""
if old_logout not in server:
    raise SystemExit('server.js: no se encontró el logout defectuoso')
server = server.replace(old_logout, new_logout, 1)
server_path.write_text(server, encoding='utf-8')

test_path = Path('test/adminSession.test.js')
tests = test_path.read_text(encoding='utf-8')
old_test_import = """import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADMIN_SESSION_DEFAULTS,
  createAdminSessionMiddleware,
  resolveAdminSessionConfig
} from '../src/services/adminSession.js';
"""
new_test_import = """import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  ADMIN_SESSION_DEFAULTS,
  buildAdminSessionCookieClearOptions,
  createAdminLogoutHandler,
  createAdminSessionMiddleware,
  resolveAdminSessionConfig
} from '../src/services/adminSession.js';
"""
if old_test_import not in tests:
    raise SystemExit('adminSession.test.js: no se encontró el bloque de imports')
tests = tests.replace(old_test_import, new_test_import, 1)

old_expected_cookie = """  assert.deepEqual(config.sessionOptions.cookie, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: 1000 * 60 * 60 * 8
  });
"""
new_expected_cookie = """  assert.deepEqual(config.sessionOptions.cookie, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    path: '/',
    maxAge: 1000 * 60 * 60 * 8
  });
"""
if old_expected_cookie not in tests:
    raise SystemExit('adminSession.test.js: no se encontró la expectativa de cookie')
tests = tests.replace(old_expected_cookie, new_expected_cookie, 1)

new_tests = r'''

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
'''

tests = tests.rstrip() + new_tests + '\n'
test_path.write_text(tests, encoding='utf-8')

print('Corrección #696 aplicada correctamente.')
