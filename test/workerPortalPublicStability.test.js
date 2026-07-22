import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  WORKER_PORTAL_INSTALLATION_COOKIE_NAME,
  createWorkerPortalActivationRateLimiter,
  workerPortalRouter
} from '../src/routes/workerPortal.js';
import { WORKER_PORTAL_SESSION_COOKIE_NAME } from '../src/modules/dispatch-attendance/domain/workerPortalSessionPolicy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VIEWS_PATH = path.join(__dirname, '..', 'src', 'views');
const SESSION_TOKEN = 'S'.repeat(43);
const ACTIVATION_TOKEN = 'A'.repeat(43);
const INSTALLATION_ID = '123e4567-e89b-42d3-a456-426614174000';
const PEPPER = 'p'.repeat(32);
const NOW = new Date('2026-07-22T18:30:00.000Z');

function createPortalApp(options = {}) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', VIEWS_PATH);
  app.use('/operaciones/portal', workerPortalRouter({}, {
    installationPepper: PEPPER,
    nowFn: () => NOW,
    nonceBytesFn: (size) => Buffer.alloc(size, 5),
    randomUUIDFn: () => INSTALLATION_ID,
    rateLimitNowFn: () => NOW.getTime(),
    ...options
  }));
  app.use(express.json({ limit: '2mb' }));
  app.use((error, _req, res, _next) => {
    res.status(500).json({ error: error?.message || 'unexpected' });
  });
  return app;
}

async function withServer(app, action) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    return await action(origin);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function activationRequest(origin, body, headers = {}) {
  return fetch(`${origin}/operaciones/portal/activar`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'worker-portal',
      ...headers
    },
    body
  });
}

test('GET /operaciones/portal responde sin inicializar Prisma cuando no hay sesión', async () => {
  let repositoryCalls = 0;
  const app = createPortalApp({
    repositoryFactory() {
      repositoryCalls += 1;
      throw new Error('must_not_initialize');
    }
  });

  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/operaciones/portal`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Acceso no activo/);
    assert.equal(repositoryCalls, 0);
  });
});

test('una sesión existente degrada a pantalla disponible cuando Prisma falla', async () => {
  const originalError = console.error;
  const logs = [];
  console.error = (...values) => logs.push(values);
  try {
    const app = createPortalApp({
      repositoryFactory() {
        throw new Error('worker_portal_session_prisma_dispatchWorkerPortalSession_required');
      }
    });

    await withServer(app, async (origin) => {
      const response = await fetch(`${origin}/operaciones/portal`, {
        headers: { Cookie: `${WORKER_PORTAL_SESSION_COOKIE_NAME}=${SESSION_TOKEN}` }
      });
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.match(html, /Portal temporalmente no disponible/);
      assert.doesNotMatch(JSON.stringify(logs), new RegExp(SESSION_TOKEN));
    });
  } finally {
    console.error = originalError;
  }
});

test('JSON malformado se rechaza sin alcanzar repositorio ni manejador global', async () => {
  let activationCalls = 0;
  const app = createPortalApp({
    repository: {},
    activateSessionFn: async () => {
      activationCalls += 1;
      throw new Error('must_not_run');
    }
  });

  await withServer(app, async (origin) => {
    const response = await activationRequest(origin, `{"activationToken":"${ACTIVATION_TOKEN}`);
    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.deepEqual(payload, { ok: false, error: 'activation_request_invalid' });
    assert.equal(activationCalls, 0);
    assert.doesNotMatch(JSON.stringify(payload), new RegExp(ACTIVATION_TOKEN));
  });
});

test('el límite real de 4 KB se aplica antes del parser global de 2 MB', async () => {
  let activationCalls = 0;
  const app = createPortalApp({
    repository: {},
    activateSessionFn: async () => {
      activationCalls += 1;
      throw new Error('must_not_run');
    }
  });

  await withServer(app, async (origin) => {
    const response = await activationRequest(origin, JSON.stringify({
      activationToken: ACTIVATION_TOKEN,
      padding: 'x'.repeat(5000)
    }));
    const payload = await response.json();
    assert.equal(response.status, 413);
    assert.deepEqual(payload, { ok: false, error: 'activation_request_invalid' });
    assert.equal(activationCalls, 0);
  });
});

test('el rate limit bloquea antes de nuevas consultas de activación', async () => {
  let activationCalls = 0;
  const app = createPortalApp({
    repository: {},
    rateLimitMaxAttempts: 2,
    activateSessionFn: async () => {
      activationCalls += 1;
      throw new Error('activation_rejected');
    }
  });

  await withServer(app, async (origin) => {
    const body = JSON.stringify({ activationToken: ACTIVATION_TOKEN });
    const first = await activationRequest(origin, body);
    const second = await activationRequest(origin, body);
    const third = await activationRequest(origin, body);
    assert.equal(first.status, 400);
    assert.equal(second.status, 400);
    assert.equal(third.status, 429);
    assert.equal(activationCalls, 2);
    assert.ok(Number(third.headers.get('retry-after')) >= 1);
    assert.deepEqual(await third.json(), { ok: false, error: 'activation_rate_limited' });
  });
});

test('el rate limiter mantiene memoria acotada', () => {
  let now = 1000;
  const limiter = createWorkerPortalActivationRateLimiter({
    windowMs: 60_000,
    maxAttempts: 10,
    maxEntries: 2,
    nowFn: () => now
  });
  const response = {
    set() { return this; },
    status() { return this; },
    json() { return this; }
  };
  const next = () => {};

  limiter.middleware({ ip: '10.0.0.1' }, response, next);
  limiter.middleware({ ip: '10.0.0.2' }, response, next);
  limiter.middleware({ ip: '10.0.0.3' }, response, next);
  assert.ok(limiter.size() <= 2);

  now += 61_000;
  limiter.middleware({ ip: '10.0.0.4' }, response, next);
  assert.ok(limiter.size() <= 2);
});

test('un POST válido solo fija cookies después de activar correctamente', async () => {
  const expiresAt = new Date(NOW.getTime() + 60_000);
  const app = createPortalApp({
    repository: {},
    activateSessionFn: async () => ({
      rawSessionToken: SESSION_TOKEN,
      cookie: {
        name: WORKER_PORTAL_SESSION_COOKIE_NAME,
        options: {
          httpOnly: true,
          secure: true,
          sameSite: 'strict',
          path: '/operaciones/portal',
          maxAge: expiresAt.getTime() - NOW.getTime()
        }
      }
    })
  });

  await withServer(app, async (origin) => {
    const response = await activationRequest(origin, JSON.stringify({ activationToken: ACTIVATION_TOKEN }));
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload, { ok: true, redirectTo: '/operaciones/portal' });
    const cookies = response.headers.getSetCookie?.() || [];
    const serialized = cookies.join('\n');
    assert.match(serialized, new RegExp(WORKER_PORTAL_INSTALLATION_COOKIE_NAME));
    assert.match(serialized, new RegExp(WORKER_PORTAL_SESSION_COOKIE_NAME));
    assert.doesNotMatch(JSON.stringify(payload), new RegExp(SESSION_TOKEN));
  });
});

test('server monta el portal antes del parser JSON global', async () => {
  const fs = await import('node:fs/promises');
  const serverSource = await fs.readFile(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const portalMount = "app.use('/operaciones/portal', wrapAsyncRouter(workerPortalRouter(prisma)));";
  const globalParser = "app.use(express.json({ limit: '2mb' }));";
  assert.ok(serverSource.indexOf(portalMount) >= 0);
  assert.ok(serverSource.indexOf(portalMount) < serverSource.indexOf(globalParser));
  assert.equal(serverSource.match(new RegExp(portalMount.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length, 1);
});

test('la vista incluye estado de degradación temporal', async () => {
  const fs = await import('node:fs/promises');
  const view = await fs.readFile(path.join(VIEWS_PATH, 'workerPortal.ejs'), 'utf8');
  assert.match(view, /mode === 'unavailable'/);
  assert.match(view, /Portal temporalmente no disponible/);
});
