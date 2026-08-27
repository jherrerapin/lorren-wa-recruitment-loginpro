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
import {
  WORKER_PORTAL_SESSION_CONTINUITY_MAX_AGE_MS,
  WORKER_PORTAL_SESSION_COOKIE_NAME
} from '../src/modules/dispatch-attendance/domain/workerPortalSessionPolicy.js';
import { createPrismaWorkerPortalSessionRepository } from '../src/modules/dispatch-attendance/infrastructure/prismaWorkerPortalSessionRepository.js';

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

function requestDouble({ body = {}, cookies = {}, headers = {}, ip = '127.0.0.1', params = {} } = {}) {
  const lowerHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    body,
    cookies,
    params,
    ip,
    method: 'GET',
    originalUrl: '/',
    get(name) {
      return lowerHeaders[String(name).toLowerCase()] ?? undefined;
    }
  };
}

function findRouteLayer(router, path, method) {
  const pending = [router];
  const visited = new Set();
  while (pending.length) {
    const current = pending.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    for (const layer of current.stack || []) {
      if (layer.route?.path === path && layer.route.methods?.[method]) return layer;
      if (layer.handle?.stack) pending.push(layer.handle);
    }
  }
  return null;
}

function routeHandler(router, path, method) {
  const layer = findRouteLayer(router, path, method);
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
    resolveSessionFn: async () => null,
    loadAssignmentsFn: async () => [],
    ...options
  });
}

test('el enlace de activación usa query y no fragmento', () => {
  const activationUrl = buildWorkerPortalActivationUrl('https://lorren.example', ACTIVATION_TOKEN);
  const parsed = new URL(activationUrl);
  assert.equal(parsed.pathname, WORKER_PORTAL_ACTIVATION_PATH);
  assert.equal(parsed.searchParams.get('token'), ACTIVATION_TOKEN);
  assert.equal(parsed.hash, '');
});

test('las cookies permanecen seguras, host-only y disponibles para la verificación biométrica', () => {
  const options = workerPortalCookieOptions(60_000);
  assert.equal(options.httpOnly, true);
  assert.equal(options.secure, true);
  assert.equal(options.sameSite, 'strict');
  assert.equal(options.path, '/');
  assert.equal(Object.hasOwn(options, 'domain'), false);

  const missing = resolveWorkerPortalInstallationId(requestDouble(), () => INSTALLATION_ID);
  assert.equal(missing.installationId, INSTALLATION_ID);
  assert.equal(missing.shouldSetCookie, true);

  const { res, state } = responseDouble();
  setWorkerPortalInstallationCookie(res, INSTALLATION_ID);
  assert.equal(state.cookies[0].name, WORKER_PORTAL_INSTALLATION_COOKIE_NAME);
});

test('GET de activación solo renderiza y nunca consume el token', async () => {
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
  assert.match(state.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
});

test('POST exitoso emite instalación, sesión y una redirección limpia', async () => {
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
  const req = requestDouble({
    body: { activationToken: ACTIVATION_TOKEN },
    headers: {
      'x-requested-with': 'worker-portal',
      'user-agent': 'Browser Test',
      'sec-ch-ua-platform': 'Android'
    },
    ip: '10.0.0.7'
  });

  await routeHandler(router, '/activar', 'post')(req, res);

  assert.equal(observedInput.rawActivationToken, ACTIVATION_TOKEN);
  assert.equal(observedInput.installationPepper, PEPPER);
  assert.deepEqual(state.cookies.map((item) => item.name), [
    WORKER_PORTAL_INSTALLATION_COOKIE_NAME,
    WORKER_PORTAL_SESSION_COOKIE_NAME
  ]);
  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.json, { ok: true, redirectTo: WORKER_PORTAL_HOME_PATH });
  assert.equal(JSON.stringify(state.json).includes(ACTIVATION_TOKEN), false);
  assert.equal(JSON.stringify(state.json).includes(SESSION_TOKEN), false);
});

test('errores de configuración de activación producen 503 sin exponer secretos', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const router = buildRouter({
      activateSessionFn: async () => {
        throw new Error('installation_pepper_required');
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
  } finally {
    console.error = originalError;
  }
});

test('la portada activa carga asignaciones y renueva las mismas cookies de sesión e instalación', async () => {
  let observedWorkerId;
  const assignments = [{ id: 'assignment-public', clientName: 'Cliente' }];
  const router = buildRouter({
    resolveSessionFn: async ({ rawSessionToken }) => {
      assert.equal(rawSessionToken, SESSION_TOKEN);
      return {
        workerId: 'worker-secret-id',
        deviceId: 'device-secret-id',
        sessionId: 'session-secret-id',
        expiresAt: EXPIRES_AT
      };
    },
    loadAssignmentsFn: async (_prisma, input) => {
      observedWorkerId = input.workerId;
      return assignments;
    }
  });
  const { res, state } = responseDouble();

  await routeHandler(router, '/', 'get')(
    requestDouble({
      cookies: {
        [WORKER_PORTAL_SESSION_COOKIE_NAME]: SESSION_TOKEN,
        [WORKER_PORTAL_INSTALLATION_COOKIE_NAME]: INSTALLATION_ID
      }
    }),
    res
  );

  assert.equal(observedWorkerId, 'worker-secret-id');
  assert.equal(state.render.locals.mode, 'active');
  assert.deepEqual(state.render.locals.assignments, assignments);
  assert.equal(state.render.locals.workerId, undefined);
  assert.equal(state.render.locals.deviceId, undefined);
  assert.equal(state.render.locals.sessionId, undefined);

  const sessionCookie = state.cookies.find((item) => item.name === WORKER_PORTAL_SESSION_COOKIE_NAME);
  const installationCookie = state.cookies.find((item) => item.name === WORKER_PORTAL_INSTALLATION_COOKIE_NAME);
  assert.ok(sessionCookie);
  assert.equal(sessionCookie.value, SESSION_TOKEN);
  assert.equal(sessionCookie.options.httpOnly, true);
  assert.equal(sessionCookie.options.secure, true);
  assert.equal(sessionCookie.options.sameSite, 'lax');
  assert.equal(sessionCookie.options.maxAge, WORKER_PORTAL_SESSION_CONTINUITY_MAX_AGE_MS);
  assert.ok(installationCookie);
  assert.equal(installationCookie.value, INSTALLATION_ID);
});

test('la resolución normal nunca inventa otra instalación si la cookie de instalación falta', async () => {
  let randomUuidCalls = 0;
  const router = buildRouter({
    randomUUIDFn: () => {
      randomUuidCalls += 1;
      return INSTALLATION_ID;
    },
    resolveSessionFn: async () => ({
      workerId: 'worker-continuity',
      deviceId: 'device-continuity',
      sessionId: 'session-continuity',
      expiresAt: EXPIRES_AT
    })
  });
  const { res, state } = responseDouble();

  await routeHandler(router, '/', 'get')(
    requestDouble({ cookies: { [WORKER_PORTAL_SESSION_COOKIE_NAME]: SESSION_TOKEN } }),
    res
  );

  assert.equal(state.render.locals.mode, 'active');
  assert.equal(randomUuidCalls, 0);
  assert.equal(state.cookies.some((item) => item.name === WORKER_PORTAL_INSTALLATION_COOKIE_NAME), false);
  assert.equal(state.cookies.some((item) => item.name === WORKER_PORTAL_SESSION_COOKIE_NAME), true);
});

test('sesión histórica vencida se renueva solo si sesión, auxiliar y dispositivo siguen autorizados', async () => {
  let query = null;
  let touch = null;
  const historicalExpiry = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
  const prisma = {
    dispatchWorker: {},
    dispatchWorkerActivation: {},
    dispatchWorkerDevice: {},
    dispatchWorkerPortalSession: {
      async findFirst(input) {
        query = input;
        return {
          id: 'session-historical',
          workerId: 'worker-historical',
          workerDeviceId: 'device-historical',
          expiresAt: historicalExpiry
        };
      },
      async updateMany(input) {
        touch = input;
        return { count: 1 };
      }
    }
  };
  const repository = createPrismaWorkerPortalSessionRepository(prisma);
  const result = await repository.resolveActiveSession({
    sessionTokenHash: 'c'.repeat(64),
    now: NOW
  });

  assert.equal(Object.hasOwn(query.where, 'expiresAt'), false);
  assert.equal(query.where.status, 'ACTIVE');
  assert.equal(query.where.revokedAt, null);
  assert.deepEqual(query.where.worker.is.operationalStatus.in, ['ACTIVE', 'CONTRATADO']);
  assert.equal(query.where.workerDevice.is.authorizationType, 'PRIMARY');
  assert.equal(query.where.workerDevice.is.status, 'ACTIVE');
  assert.equal(query.where.workerDevice.is.revokedAt, null);
  assert.equal(touch.data.lastSeenAt, NOW);
  assert.ok(touch.data.expiresAt.getTime() > NOW.getTime());
  assert.ok(result.expiresAt.getTime() > NOW.getTime());
});

test('revocación real, baja del auxiliar o dispositivo inválido siguen cerrando la sesión', async () => {
  const prisma = {
    dispatchWorker: {},
    dispatchWorkerActivation: {},
    dispatchWorkerDevice: {},
    dispatchWorkerPortalSession: {
      async findFirst() {
        return null;
      },
      async updateMany() {
        throw new Error('must_not_touch_invalid_session');
      }
    }
  };
  const repository = createPrismaWorkerPortalSessionRepository(prisma);

  const result = await repository.resolveActiveSession({
    sessionTokenHash: 'd'.repeat(64),
    now: NOW
  });
  assert.equal(result, null);
});

test('sesión ausente o revocada muestra acceso inactivo y limpia una cookie existente', async () => {
  const router = buildRouter({ resolveSessionFn: async () => null });
  const { res, state } = responseDouble();

  await routeHandler(router, '/', 'get')(
    requestDouble({ cookies: { [WORKER_PORTAL_SESSION_COOKIE_NAME]: SESSION_TOKEN } }),
    res
  );

  assert.equal(state.render.locals.mode, 'inactive');
  assert.equal(state.clearedCookies[0].name, WORKER_PORTAL_SESSION_COOKIE_NAME);
});

test('la vista usa GPS, cámara, biometría local y multipart sin cargar terceros', () => {
  const view = fs.readFileSync('src/views/workerPortal.ejs', 'utf8');
  const replaceIndex = view.indexOf('window.history.replaceState');
  const activationFetchIndex = view.indexOf("fetch('/operaciones/portal/activar'");
  assert.ok(replaceIndex >= 0);
  assert.ok(activationFetchIndex > replaceIndex);
  assert.match(view, /new URLSearchParams\(window\.location\.search\)/);
  assert.match(view, /navigator\.geolocation\.getCurrentPosition/);
  assert.match(view, /getUserMedia/);
  assert.match(view, /new FormData\(\)/);
  assert.match(view, /LorrenWorkerBiometric/);
  assert.match(view, /biometria\/desafio/);
  assert.match(view, /photoConsent/);
  assert.doesNotMatch(view, /https?:\/\//i);
  assert.doesNotMatch(view, /localStorage|sessionStorage/);
});

test('las cabeceras permiten cámara local y bloquean framing', () => {
  const { res, state } = responseDouble();
  applyWorkerPortalSecurityHeaders(res, 'nonce-test');
  assert.match(state.headers['Content-Security-Policy'], /media-src 'self' blob:/);
  assert.match(state.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.equal(state.headers['X-Frame-Options'], 'DENY');
});

test('server monta el portal antes de los parsers globales', () => {
  const server = fs.readFileSync('src/server.js', 'utf8');
  const mountStatement = "app.use('/operaciones/portal', wrapAsyncRouter(workerPortalRouter(prisma)));";
  assert.match(server, new RegExp(mountStatement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(server.indexOf(mountStatement) < server.indexOf("app.use(express.json({ limit: '2mb' }));"));
  assert.equal(server.split(mountStatement).length - 1, 1);
});
