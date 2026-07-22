import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  workerPortalRouter
} from '../src/routes/workerPortal.js';
import { WORKER_PORTAL_SESSION_COOKIE_NAME } from '../src/modules/dispatch-attendance/domain/workerPortalSessionPolicy.js';

const SESSION_TOKEN = 'S'.repeat(43);
const ACTIVATION_TOKEN = 'A'.repeat(43);
const INSTALLATION_ID = '123e4567-e89b-42d3-a456-426614174000';
const NOW = new Date('2026-07-22T19:00:00.000Z');
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
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );

  return {
    body,
    cookies,
    ip,
    get(name) {
      return normalizedHeaders[String(name).toLowerCase()] ?? undefined;
    }
  };
}

function routeHandler(router, path, method) {
  const layer = router.stack.find((item) => item.route?.path === path && item.route.methods?.[method]);
  assert.ok(layer, `route ${method.toUpperCase()} ${path} must exist`);
  return layer.route.stack.at(-1).handle;
}

function buildRouter(options = {}) {
  return workerPortalRouter({}, {
    installationPepper: PEPPER,
    nowFn: () => NOW,
    randomUUIDFn: () => INSTALLATION_ID,
    nonceBytesFn: (size) => Buffer.alloc(size, 9),
    activationAttemptGuard: { consume: () => ({ allowed: true, retryAfterSeconds: 0 }) },
    ...options
  });
}

test('construir el router no inicializa el repositorio Prisma', () => {
  let factoryCalls = 0;

  assert.doesNotThrow(() => buildRouter({
    repositoryFactory() {
      factoryCalls += 1;
      throw new Error('must_not_initialize');
    }
  }));

  assert.equal(factoryCalls, 0);
});

test('la portada sin cookie responde acceso inactivo sin consultar Prisma', async () => {
  let factoryCalls = 0;
  const router = buildRouter({
    repositoryFactory() {
      factoryCalls += 1;
      throw new Error('must_not_initialize');
    }
  });
  const { res, state } = responseDouble();

  await routeHandler(router, '/', 'get')(requestDouble(), res);

  assert.equal(factoryCalls, 0);
  assert.equal(state.statusCode, 200);
  assert.equal(state.render.view, 'workerPortal');
  assert.equal(state.render.locals.mode, 'inactive');
  assert.equal(state.clearedCookies.length, 0);
});

test('una falla temporal de Prisma muestra indisponibilidad sin borrar la cookie', async () => {
  const originalError = console.error;
  const observedLogs = [];
  console.error = (...values) => observedLogs.push(values);

  try {
    const router = buildRouter({
      repositoryFactory() {
        throw new Error('worker_portal_session_prisma_dispatchWorkerPortalSession_required');
      }
    });
    const { res, state } = responseDouble();

    await routeHandler(router, '/', 'get')(
      requestDouble({ cookies: { [WORKER_PORTAL_SESSION_COOKIE_NAME]: SESSION_TOKEN } }),
      res
    );

    assert.equal(state.statusCode, 200);
    assert.equal(state.render.locals.mode, 'unavailable');
    assert.equal(state.clearedCookies.length, 0);
    assert.deepEqual(observedLogs, [
      ['[WORKER_PORTAL_AVAILABILITY_ERROR]', { code: 'worker_portal_session_prisma_dispatchWorkerPortalSession_required' }]
    ]);
    assert.equal(JSON.stringify(observedLogs).includes(SESSION_TOKEN), false);
  } finally {
    console.error = originalError;
  }
});

test('una cookie de sesión malformada se elimina y vuelve a acceso inactivo', async () => {
  const router = buildRouter({ repository: {} });
  const { res, state } = responseDouble();

  await routeHandler(router, '/', 'get')(
    requestDouble({ cookies: { [WORKER_PORTAL_SESSION_COOKIE_NAME]: 'invalid-session-token' } }),
    res
  );

  assert.equal(state.render.locals.mode, 'inactive');
  assert.equal(state.clearedCookies.length, 1);
  assert.equal(state.clearedCookies[0].name, WORKER_PORTAL_SESSION_COOKIE_NAME);
  assert.equal(state.clearedCookies[0].options.path, '/operaciones/portal');
});

test('la activación devuelve indisponibilidad cuando Prisma no puede inicializarse', async () => {
  const originalError = console.error;
  const observedLogs = [];
  console.error = (...values) => observedLogs.push(values);

  try {
    const router = buildRouter({
      repositoryFactory() {
        throw new Error('worker_portal_session_prisma_dispatchWorkerPortalSession_required');
      }
    });
    const { res, state } = responseDouble();

    await routeHandler(router, '/activar', 'post')(
      requestDouble({
        body: { activationToken: ACTIVATION_TOKEN },
        headers: { 'x-requested-with': 'worker-portal' }
      }),
      res
    );

    assert.equal(state.statusCode, 503);
    assert.deepEqual(state.json, { ok: false, error: 'portal_temporarily_unavailable' });
    assert.equal(state.cookies.length, 0);
    assert.equal(JSON.stringify(state.json).includes(ACTIVATION_TOKEN), false);
    assert.equal(JSON.stringify(observedLogs).includes(ACTIVATION_TOKEN), false);
  } finally {
    console.error = originalError;
  }
});

test('la vista contempla el estado de indisponibilidad temporal', () => {
  const view = fs.readFileSync('src/views/workerPortal.ejs', 'utf8');
  assert.match(view, /mode === 'unavailable'/);
  assert.match(view, /Portal temporalmente no disponible/);
  assert.match(view, /Tu dispositivo no fue desactivado/);
});
