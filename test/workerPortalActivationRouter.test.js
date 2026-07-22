import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  WORKER_PORTAL_ACTIVATION_PATH,
  WORKER_PORTAL_HOME_PATH,
  WORKER_PORTAL_INSTALLATION_COOKIE_NAME,
  applyWorkerPortalSecurityHeaders,
  buildWorkerPortalActivationUrl,
  resolveWorkerPortalInstallationId,
  setWorkerPortalInstallationCookie,
  workerPortalCookieOptions,
  workerPortalRouter
} from '../src/routes/workerPortal.js';
import { WORKER_PORTAL_SESSION_COOKIE_NAME } from '../src/modules/dispatch-attendance/domain/workerPortalSessionPolicy.js';

const ACTIVATION_TOKEN = 'A'.repeat(43);
const SESSION_TOKEN = 'B'.repeat(43);
const INSTALLATION_ID = '123e4567-e89b-42d3-a456-426614174000';
const NOW = new Date('2026-07-22T18:00:00.000Z');
const EXPIRES_AT = new Date('2026-07-29T18:00:00.000Z');
const PEPPER = 'p'.repeat(32);

function responseDouble() {
  const state = {
    headers: {},
    cookies: [],
    clearedCookies: [],
    statusCode: 200,
    json: null,
    render: null
  };

  const res = {
    set(name, value) {
      state.headers[name] = value;
      return this;
    },
    cookie(name, value, options) {
      state.cookies.push({ name, value, options });
      return this;
    },
    clearCookie(name, options) {
      state.clearedCookies.push({ name, options });
      return this;
    },
    status(code) {
      state.statusCode = code;
      return this;
    },
    json(payload) {
      state.json = payload;
      return payload;
    },
    render(view, locals) {
      state.render = { view, locals };
      return state.render;
    }
  };

  return { res, state };
}

function requestDouble({ body = {}, cookies = {}, headers = {}, ip = '127.0.0.1' } = {}) {
  const lowerHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    body,
    cookies,
    ip,
    get(name) {
      return lowerHeaders[String(name).toLowerCase()] ?? undefined;
    }
  };
}

function activationRequest(overrides = {}) {
  return requestDouble({
    body: { activationToken: ACTIVATION_TOKEN },
    headers: { 'x-requested-with': 'worker-portal' },
    ...overrides
  });
}

function routeHandler(router, path, method) {
  const layer = router.stack.find((item) => item.route?.path === path && item.route.methods?.[method]);
  assert.ok(layer, `route ${method.toUpperCase()} ${path} must exist`);
  return layer.route.stack.at(-1).handle;
}

function buildRouter(options = {}) {
  return workerPortalRouter({}, {
    repository: {},
    installationPepper: PEPPER,
    nowFn: () => NOW,
    randomUUIDFn: () => INSTALLATION_ID,
    nonceBytesFn: (size) => Buffer.alloc(size, 7),
    activateSessionFn: async () => ({
      rawSessionToken: SESSION_TOKEN,
      cookie: {
        name: WORKER_PORTAL_SESSION_COOKIE_NAME,
        options: workerPortalCookieOptions(EXPIRES_AT.getTime() - NOW.getTime())
      }
    }),
    resolveSessionFn: async () => null,
    ...options
  });
}

test('las cookies del portal son Secure, HttpOnly, Strict y limitadas al portal', () => {
  assert.deepEqual(workerPortalCookieOptions(60_000), {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/operaciones/portal',
    maxAge: 60_000
  });
});

test('la instalación reutiliza UUID válido y difiere la cookie nueva hasta activar', () => {
  const existing = resolveWorkerPortalInstallationId(
    requestDouble({ cookies: { [WORKER_PORTAL_INSTALLATION_COOKIE_NAME]: INSTALLATION_ID } }),
    () => { throw new Error('must_not_generate'); }
  );
  assert.deepEqual(existing, { installationId: INSTALLATION_ID, shouldSetCookie: false });

  const generated = resolveWorkerPortalInstallationId(
    requestDouble({ cookies: { [WORKER_PORTAL_INSTALLATION_COOKIE_NAME]: 'invalid' } }),
    () => INSTALLATION_ID
  );
  assert.deepEqual(generated, { installationId: INSTALLATION_ID, shouldSetCookie: true });

  const { res, state } = responseDouble();
  setWorkerPortalInstallationCookie(res, generated.installationId);
  assert.equal(state.cookies[0].name, WORKER_PORTAL_INSTALLATION_COOKIE_NAME);
  assert.equal(state.cookies[0].options.httpOnly, true);
  assert.equal(state.cookies[0].options.secure, true);
});

test('el enlace futuro coloca el token exclusivamente en el fragmento', () => {
  const activationUrl = buildWorkerPortalActivationUrl('https://lorren.example', ACTIVATION_TOKEN);
  const parsed = new URL(activationUrl);
  assert.equal(parsed.pathname, WORKER_PORTAL_ACTIVATION_PATH);
  assert.equal(parsed.search, '');
  assert.equal(parsed.hash, `#token=${ACTIVATION_TOKEN}`);
  assert.equal(parsed.href.includes(`?token=${ACTIVATION_TOKEN}`), false);
});

test('GET de activación nunca consume el token y aplica cabeceras de seguridad', async () => {
  let activationCalls = 0;
  const router = buildRouter({
    activateSessionFn: async () => {
      activationCalls += 1;
      throw new Error('must_not_run');
    }
  });
  const { res, state } = responseDouble();

  await routeHandler(router, '/activar', 'get')(requestDouble(), res);

  assert.equal(activationCalls, 0);
  assert.equal(state.render.view, 'workerPortal');
  assert.equal(state.render.locals.mode, 'activation');
  assert.match(state.headers['Cache-Control'], /no-store/);
  assert.equal(state.headers['Referrer-Policy'], 'no-referrer');
  assert.match(state.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(state.headers['Content-Security-Policy'], /nonce-/);
});

test('POST exitoso activa sesión, fija dos cookies y responde una URL limpia', async () => {
  let observedInput;
  const router = buildRouter({
    activateSessionFn: async (input) => {
      observedInput = input;
      return {
        rawSessionToken: SESSION_TOKEN,
        cookie: {
          name: WORKER_PORTAL_SESSION_COOKIE_NAME,
          options: workerPortalCookieOptions(EXPIRES_AT.getTime() - NOW.getTime())
        }
      };
    }
  });
  const { res, state } = responseDouble();
  const req = activationRequest({
    headers: {
      'x-requested-with': 'worker-portal',
      'user-agent': 'Browser Test',
      'sec-ch-ua-platform': 'Android'
    },
    ip: '10.0.0.7'
  });

  await routeHandler(router, '/activar', 'post')(req, res);

  assert.equal(observedInput.rawActivationToken, ACTIVATION_TOKEN);
  assert.equal(observedInput.installationId, INSTALLATION_ID);
  assert.equal(observedInput.installationPepper, PEPPER);
  assert.equal(observedInput.userAgent, 'Browser Test');
  assert.equal(observedInput.platform, 'Android');
  assert.equal(observedInput.ipAddress, '10.0.0.7');
  assert.deepEqual(state.cookies.map((item) => item.name), [
    WORKER_PORTAL_INSTALLATION_COOKIE_NAME,
    WORKER_PORTAL_SESSION_COOKIE_NAME
  ]);
  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.json, { ok: true, redirectTo: WORKER_PORTAL_HOME_PATH });
  assert.equal(JSON.stringify(state.json).includes(ACTIVATION_TOKEN), false);
  assert.equal(JSON.stringify(state.json).includes(SESSION_TOKEN), false);
});

test('una activación rechazada no deja cookie persistente de instalación', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const router = buildRouter({
      activateSessionFn: async () => {
        throw new Error('worker_portal_session_repository_result_invalid');
      }
    });
    const { res, state } = responseDouble();

    await routeHandler(router, '/activar', 'post')(activationRequest(), res);

    assert.equal(state.statusCode, 400);
    assert.deepEqual(state.json, { ok: false, error: 'activation_invalid_or_expired' });
    assert.equal(state.cookies.length, 0);
    assert.equal(JSON.stringify(state.json).includes(ACTIVATION_TOKEN), false);
  } finally {
    console.warn = originalWarn;
  }
});

test('POST sin cabecera del portal se rechaza antes de consumir la activación', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  let activationCalls = 0;
  try {
    const router = buildRouter({
      activateSessionFn: async () => {
        activationCalls += 1;
        return null;
      }
    });
    const { res, state } = responseDouble();

    await routeHandler(router, '/activar', 'post')(
      requestDouble({ body: { activationToken: ACTIVATION_TOKEN } }),
      res
    );

    assert.equal(activationCalls, 0);
    assert.equal(state.statusCode, 400);
    assert.equal(state.cookies.length, 0);
  } finally {
    console.warn = originalWarn;
  }
});

test('los logs sanitizan mensajes arbitrarios y nunca incluyen el token', async () => {
  const originalWarn = console.warn;
  let observedLog;
  console.warn = (...args) => { observedLog = args; };
  try {
    const router = buildRouter({
      activateSessionFn: async () => {
        throw new Error(`sensitive ${ACTIVATION_TOKEN}`);
      }
    });
    const { res } = responseDouble();

    await routeHandler(router, '/activar', 'post')(activationRequest(), res);

    assert.deepEqual(observedLog, [
      '[WORKER_PORTAL_ACTIVATION_REJECTED]',
      { code: 'worker_portal_error' }
    ]);
    assert.equal(JSON.stringify(observedLog).includes(ACTIVATION_TOKEN), false);
  } finally {
    console.warn = originalWarn;
  }
});

test('la portada resuelve una sesión válida sin exponer IDs internos', async () => {
  let observedToken;
  const router = buildRouter({
    resolveSessionFn: async ({ rawSessionToken }) => {
      observedToken = rawSessionToken;
      return {
        workerId: 'worker-secret-id',
        deviceId: 'device-secret-id',
        sessionId: 'session-secret-id',
        expiresAt: EXPIRES_AT
      };
    }
  });
  const { res, state } = responseDouble();

  await routeHandler(router, '/', 'get')(
    requestDouble({ cookies: { [WORKER_PORTAL_SESSION_COOKIE_NAME]: SESSION_TOKEN } }),
    res
  );

  assert.equal(observedToken, SESSION_TOKEN);
  assert.equal(state.render.locals.mode, 'active');
  assert.equal(state.render.locals.workerId, undefined);
  assert.equal(state.render.locals.deviceId, undefined);
  assert.equal(state.render.locals.sessionId, undefined);
  assert.equal(state.clearedCookies.length, 0);
});

test('sesión ausente o revocada se trata como no autenticada y limpia la cookie', async () => {
  const router = buildRouter({ resolveSessionFn: async () => null });
  const { res, state } = responseDouble();

  await routeHandler(router, '/', 'get')(
    requestDouble({ cookies: { [WORKER_PORTAL_SESSION_COOKIE_NAME]: SESSION_TOKEN } }),
    res
  );

  assert.equal(state.render.locals.mode, 'inactive');
  assert.equal(state.clearedCookies[0].name, WORKER_PORTAL_SESSION_COOKIE_NAME);
  assert.equal(state.clearedCookies[0].options.path, '/operaciones/portal');
});

test('la vista elimina el fragmento antes del POST y no carga terceros', () => {
  const view = fs.readFileSync('src/views/workerPortal.ejs', 'utf8');
  const replaceIndex = view.indexOf('window.history.replaceState');
  const fetchIndex = view.indexOf("fetch('/operaciones/portal/activar'");
  assert.ok(replaceIndex >= 0);
  assert.ok(fetchIndex > replaceIndex);
  assert.match(view, /window\.location\.hash/);
  assert.match(view, /'X-Requested-With': 'worker-portal'/);
  assert.doesNotMatch(view, /https?:\/\//i);
  assert.doesNotMatch(view, /localStorage|sessionStorage/);
});

test('server monta el router público antes del router general de operaciones', () => {
  const server = fs.readFileSync('src/server.js', 'utf8');
  const importStatement = "import { workerPortalRouter } from './routes/workerPortal.js';";
  const mountStatement = "app.use('/operaciones/portal', wrapAsyncRouter(workerPortalRouter(prisma)));";
  assert.match(server, new RegExp(importStatement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(server, new RegExp(mountStatement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(server.indexOf(mountStatement) < server.indexOf("app.use('/operaciones', wrapAsyncRouter(publicDispatchClientRouter()));"));
});

test('las cabeceras sin nonce bloquean scripts y framing', () => {
  const { res, state } = responseDouble();
  applyWorkerPortalSecurityHeaders(res);
  assert.match(state.headers['Content-Security-Policy'], /script-src 'none'/);
  assert.match(state.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.equal(state.headers['X-Frame-Options'], 'DENY');
});
