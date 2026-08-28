import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKER_PORTAL_HOME_PATH,
  WORKER_PORTAL_INSTALLATION_COOKIE_NAME,
  workerPortalRouter
} from '../src/routes/workerPortal.js';
import {
  WORKER_PORTAL_SESSION_CONTINUITY_MAX_AGE_MS,
  WORKER_PORTAL_SESSION_COOKIE_NAME
} from '../src/modules/dispatch-attendance/domain/workerPortalSessionPolicy.js';
import { createPrismaWorkerPortalSessionRepository } from '../src/modules/dispatch-attendance/infrastructure/prismaWorkerPortalSessionRepository.js';

const NOW = new Date('2026-08-28T12:00:00.000Z');
const SESSION_TOKEN = 'S'.repeat(43);
const INSTALLATION_ID = '123e4567-e89b-42d3-a456-426614174000';
const PEPPER = 'p'.repeat(32);

function responseDouble() {
  const state = {
    headers: {},
    cookies: [],
    clearedCookies: [],
    render: null,
    redirect: null
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
    render(view, locals) {
      state.render = { view, locals };
      return state.render;
    },
    redirect(statusOrPath, maybePath) {
      state.redirect = typeof statusOrPath === 'number'
        ? { status: statusOrPath, path: maybePath }
        : { status: 302, path: statusOrPath };
      return this;
    }
  };
  return { res, state };
}

function requestDouble(cookies = {}) {
  return {
    cookies,
    method: 'GET',
    originalUrl: `/activar?token=${'A'.repeat(43)}`,
    ip: '127.0.0.1',
    get() {
      return undefined;
    }
  };
}

function findRouteHandler(router, path, method) {
  const pending = [router];
  const visited = new Set();
  while (pending.length) {
    const current = pending.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    for (const layer of current.stack || []) {
      if (layer.route?.path === path && layer.route.methods?.[method]) {
        return layer.route.stack.at(-1).handle;
      }
      if (layer.handle?.stack) pending.push(layer.handle);
    }
  }
  throw new Error(`route_${method}_${path}_not_found`);
}

function buildRouter(options = {}) {
  return workerPortalRouter({}, {
    repository: {},
    installationPepper: PEPPER,
    nowFn: () => NOW,
    nonceBytesFn: (size) => Buffer.alloc(size, 9),
    loadAssignmentsFn: async () => [],
    ...options
  });
}

test('un enlace viejo en un dispositivo ya autenticado abre el Portal sin reactivar', async () => {
  let resolveCalls = 0;
  let activationCalls = 0;
  const router = buildRouter({
    resolveSessionFn: async ({ rawSessionToken }) => {
      resolveCalls += 1;
      assert.equal(rawSessionToken, SESSION_TOKEN);
      return {
        workerId: 'worker-pseudo-1',
        deviceId: 'device-pseudo-1',
        sessionId: 'session-pseudo-1',
        expiresAt: new Date('2027-08-28T12:00:00.000Z')
      };
    },
    activateSessionFn: async () => {
      activationCalls += 1;
      throw new Error('old_link_must_not_activate');
    }
  });
  const { res, state } = responseDouble();
  const handler = findRouteHandler(router, '/activar', 'get');

  await handler(requestDouble({
    [WORKER_PORTAL_SESSION_COOKIE_NAME]: SESSION_TOKEN,
    [WORKER_PORTAL_INSTALLATION_COOKIE_NAME]: INSTALLATION_ID
  }), res);

  assert.equal(resolveCalls, 1);
  assert.equal(activationCalls, 0);
  assert.deepEqual(state.redirect, { status: 302, path: WORKER_PORTAL_HOME_PATH });
  assert.equal(state.render, null);
  assert.equal(state.clearedCookies.length, 0);

  const renewedSession = state.cookies.find((cookie) => cookie.name === WORKER_PORTAL_SESSION_COOKIE_NAME);
  const renewedInstallation = state.cookies.find((cookie) => cookie.name === WORKER_PORTAL_INSTALLATION_COOKIE_NAME);
  assert.ok(renewedSession);
  assert.equal(renewedSession.value, SESSION_TOKEN);
  assert.equal(renewedSession.options.maxAge, WORKER_PORTAL_SESSION_CONTINUITY_MAX_AGE_MS);
  assert.ok(renewedInstallation);
  assert.equal(renewedInstallation.value, INSTALLATION_ID);
});

test('sin una sesión válida el GET conserva el flujo de activación sin consumir el enlace', async () => {
  let activationCalls = 0;
  const router = buildRouter({
    resolveSessionFn: async () => null,
    activateSessionFn: async () => {
      activationCalls += 1;
      throw new Error('get_must_not_consume_activation');
    }
  });
  const { res, state } = responseDouble();
  const handler = findRouteHandler(router, '/activar', 'get');

  await handler(requestDouble(), res);

  assert.equal(activationCalls, 0);
  assert.equal(state.redirect, null);
  assert.equal(state.render?.locals?.mode, 'activation');
});

test('una cookie de sesión ya inválida no bloquea una nueva activación', async () => {
  const router = buildRouter({ resolveSessionFn: async () => null });
  const { res, state } = responseDouble();
  const handler = findRouteHandler(router, '/activar', 'get');

  await handler(requestDouble({ [WORKER_PORTAL_SESSION_COOKIE_NAME]: SESSION_TOKEN }), res);

  assert.equal(state.redirect, null);
  assert.equal(state.render?.locals?.mode, 'activation');
  assert.equal(state.clearedCookies[0]?.name, WORKER_PORTAL_SESSION_COOKIE_NAME);
});

test('un token consumido en otro dispositivo no puede revocar sesión ni dispositivo actuales', async () => {
  let writes = 0;
  const consumedActivation = {
    id: 'activation-pseudo-old',
    workerId: 'worker-pseudo-2',
    purpose: 'PRIMARY_DEVICE_ACTIVATION',
    status: 'CONSUMED',
    expiresAt: new Date('2026-08-29T12:00:00.000Z'),
    consumedAt: new Date('2026-08-27T12:00:00.000Z'),
    revokedAt: null
  };
  const tx = {
    dispatchWorkerActivation: {
      findUnique: async () => consumedActivation,
      updateMany: async () => { writes += 1; return { count: 0 }; },
      update: async () => { writes += 1; }
    },
    dispatchWorker: {
      findFirst: async () => { writes += 1; return { id: consumedActivation.workerId }; }
    },
    dispatchWorkerDevice: {
      updateMany: async () => { writes += 1; },
      upsert: async () => { writes += 1; }
    },
    dispatchWorkerPortalSession: {
      updateMany: async () => { writes += 1; },
      create: async () => { writes += 1; }
    }
  };
  const prisma = {
    dispatchWorker: {},
    dispatchWorkerActivation: {},
    dispatchWorkerDevice: {},
    dispatchWorkerPortalSession: {},
    $transaction: async (operation) => operation(tx)
  };
  const repository = createPrismaWorkerPortalSessionRepository(prisma);

  const result = await repository.claimActivationAuthorizeDeviceAndCreateSession({
    purpose: 'PRIMARY_DEVICE_ACTIVATION',
    activationTokenHash: 'a'.repeat(64),
    installationIdHash: 'b'.repeat(64),
    sessionTokenHash: 'c'.repeat(64),
    sessionExpiresAt: new Date('2027-08-28T12:00:00.000Z'),
    now: NOW,
    userAgent: 'Pseudo Browser',
    platform: 'Android',
    ipAddress: '127.0.0.1'
  });

  assert.equal(result, null);
  assert.equal(writes, 0);
});
