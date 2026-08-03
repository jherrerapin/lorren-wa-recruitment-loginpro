import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  WORKER_PORTAL_ACTIVATION_ADMIN_HEADER,
  dispatchWorkerPortalActivationAdminRouter,
  resolveWorkerPortalPublicOrigin
} from '../src/routes/dispatchWorkerPortalActivationAdmin.js';

const WORKER_ID = 'worker-1';
const TOKEN = 'A'.repeat(43);
const NOW = new Date('2026-07-22T20:00:00.000Z');
const EXPIRES_AT = new Date('2026-07-22T20:30:00.000Z');

function responseDouble() {
  const state = { headers: {}, statusCode: 200, json: null, render: null, redirect: null, send: null };
  const res = {
    set(name, value) { state.headers[name] = value; return this; },
    status(code) { state.statusCode = code; return this; },
    json(payload) { state.json = payload; return payload; },
    render(view, locals) { state.render = { view, locals }; return state.render; },
    redirect(location) { state.redirect = location; return location; },
    send(payload) { state.send = payload; return payload; }
  };
  return { res, state };
}

function requestDouble({
  method = 'GET',
  role = 'dev',
  username = 'dev',
  canAccessAttendanceFeature = false,
  body = {},
  headers = {},
  cookies = {},
  params = {},
  ip = '127.0.0.1'
} = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    method,
    body,
    cookies,
    params,
    ip,
    canAccessAttendanceFeature,
    session: role ? { userRole: role, username } : {},
    get(name) { return normalizedHeaders[String(name).toLowerCase()] ?? undefined; },
    is(type) { return type === 'application/json' && normalizedHeaders['content-type'] === 'application/json'; }
  };
}

function routeLayer(router, path, method) {
  const layer = router.stack.find((item) => item.route?.path === path && item.route.methods?.[method]);
  assert.ok(layer, `route ${method.toUpperCase()} ${path} must exist`);
  return layer.route.stack;
}

async function runRoute(router, path, method, req, res) {
  const handlers = routeLayer(router, path, method);
  let index = 0;
  async function next(error) {
    if (error) throw error;
    const handler = handlers[index++]?.handle;
    if (handler) return handler(req, res, next);
  }
  return next();
}

function workerFixture(overrides = {}) {
  return {
    id: WORKER_ID,
    fullName: 'Auxiliar Prueba',
    contractType: 'DIRECTO',
    operationalStatus: 'CONTRATADO',
    isTestProfile: false,
    ...overrides
  };
}

function buildRouter(options = {}) {
  return dispatchWorkerPortalActivationAdminRouter({}, {
    repository: {},
    env: { RAILWAY_PUBLIC_DOMAIN: 'lorren.example.up.railway.app' },
    ttlMinutes: 30,
    nowFn: () => NOW,
    loadWorkersFn: async () => [workerFixture()],
    findWorkerFn: async () => workerFixture(),
    loadBiometricStatusMapFn: async () => new Map([[WORKER_ID, { enrolled: false }]]),
    issueActivationFn: async () => ({
      activationId: 'activation-1',
      workerId: WORKER_ID,
      rawToken: TOKEN,
      expiresAt: EXPIRES_AT
    }),
    ...options
  });
}

function validPostRequest(overrides = {}) {
  return requestDouble({
    method: 'POST',
    body: { workerId: WORKER_ID },
    headers: {
      'content-type': 'application/json',
      'x-requested-with': WORKER_PORTAL_ACTIVATION_ADMIN_HEADER
    },
    ...overrides
  });
}

test('resuelve primero el origen explícito y luego RAILWAY_PUBLIC_DOMAIN', () => {
  assert.equal(
    resolveWorkerPortalPublicOrigin({
      ATTENDANCE_PORTAL_PUBLIC_ORIGIN: 'https://portal.loginpro.co',
      RAILWAY_PUBLIC_DOMAIN: 'ignored.up.railway.app'
    }),
    'https://portal.loginpro.co'
  );
  assert.equal(
    resolveWorkerPortalPublicOrigin({ RAILWAY_PUBLIC_DOMAIN: 'lorren.example.up.railway.app' }),
    'https://lorren.example.up.railway.app'
  );
});

test('rechaza orígenes inseguros o con rutas', () => {
  assert.throws(
    () => resolveWorkerPortalPublicOrigin({ ATTENDANCE_PORTAL_PUBLIC_ORIGIN: 'http://lorren.example' }),
    /attendance_portal_public_origin_https_required/
  );
  assert.throws(
    () => resolveWorkerPortalPublicOrigin({ ATTENDANCE_PORTAL_PUBLIC_ORIGIN: 'https://lorren.example/admin' }),
    /attendance_portal_public_origin_path_not_allowed/
  );
});

test('GET niega a un administrador sin permiso y permite a DEV', async () => {
  const router = buildRouter();
  const denied = responseDouble();
  await runRoute(router, '/', 'get', requestDouble({ role: 'admin' }), denied.res);
  assert.equal(denied.state.statusCode, 403);

  const allowed = responseDouble();
  await runRoute(router, '/', 'get', requestDouble(), allowed.res);
  assert.equal(allowed.state.statusCode, 200);
  assert.equal(allowed.state.render.view, 'operacionesPortalActivaciones');
  assert.equal(allowed.state.render.locals.workers[0].label, 'Auxiliar Prueba · Directo');
  assert.equal(allowed.state.render.locals.workers[0].biometric.enrolled, false);
  assert.match(allowed.state.headers['Cache-Control'], /no-store/);
});

test('GET permite al administrador con permiso individual de Asistencia', async () => {
  const router = buildRouter();
  const { res, state } = responseDouble();
  await runRoute(router, '/', 'get', requestDouble({
    role: 'admin',
    username: 'operaciones-autorizado',
    canAccessAttendanceFeature: true
  }), res);
  assert.equal(state.statusCode, 200);
  assert.equal(state.render.locals.role, 'admin');
});

test('POST niega solicitudes sin permiso o sin cabecera personalizada', async () => {
  let issueCalls = 0;
  const router = buildRouter({ issueActivationFn: async () => { issueCalls += 1; return null; } });

  const forbidden = responseDouble();
  await runRoute(router, '/emitir', 'post', validPostRequest({ role: 'admin' }), forbidden.res);
  assert.equal(forbidden.state.statusCode, 403);

  const invalid = responseDouble();
  await runRoute(router, '/emitir', 'post', requestDouble({
    method: 'POST',
    body: { workerId: WORKER_ID },
    headers: { 'content-type': 'application/json' }
  }), invalid.res);
  assert.equal(invalid.state.statusCode, 400);
  assert.equal(issueCalls, 0);
});

test('POST autorizado genera el enlace sin filtrar el token crudo', async () => {
  let observedInput;
  const router = buildRouter({
    issueActivationFn: async (input) => {
      observedInput = input;
      return { activationId: 'activation-1', workerId: WORKER_ID, rawToken: TOKEN, expiresAt: EXPIRES_AT };
    }
  });
  const { res, state } = responseDouble();
  await runRoute(router, '/emitir', 'post', validPostRequest({
    role: 'admin',
    username: 'operaciones-autorizado',
    canAccessAttendanceFeature: true
  }), res);

  assert.equal(state.statusCode, 201);
  assert.equal(observedInput.workerId, WORKER_ID);
  assert.equal(observedInput.createdByUsername, 'operaciones-autorizado');
  assert.equal(state.json.activationUrl, `https://lorren.example.up.railway.app/operaciones/portal/activar#token=${TOKEN}`);
  assert.equal(state.json.rawToken, undefined);
});

test('la pantalla administrativa nunca renderiza registro facial', () => {
  const view = fs.readFileSync('src/views/operacionesPortalActivaciones.ejs', 'utf8');
  const copyListenerIndex = view.indexOf("copyButton?.addEventListener('click'");
  const clipboardIndex = view.indexOf('navigator.clipboard.writeText');
  assert.ok(copyListenerIndex >= 0 && clipboardIndex > copyListenerIndex);
  assert.match(view, /Gestión de asistencia/);
  assert.match(view, /Genera el enlace para activar el celular/);
  assert.doesNotMatch(view, /enroll-button|biometric-dialog|captureEnrollment/);
  assert.doesNotMatch(view, /Registrar rostro|Actualizar rostro/);
  assert.equal(fs.existsSync('src/public/worker-portal-hardening.js'), false);
  assert.doesNotMatch(view, /window\.open\(|location\.href\s*=\s*activationUrl/);
});

test('la administración usa un solo router y no conserva rutas biométricas del portal', () => {
  const bridgeSource = fs.readFileSync('src/routes/dispatchBridge.js', 'utf8');
  const activationSource = fs.readFileSync('src/routes/dispatchWorkerPortalActivationAdmin.js', 'utf8');

  assert.match(bridgeSource, /'\/portal-activaciones',[\s\S]*dispatchWorkerPortalActivationAdminRouter\(prisma\)/);
  assert.match(activationSource, /router\.get\('\/', requireAttendancePermission/);
  assert.match(activationSource, /router\.post\('\/emitir', requireAttendancePermission, requireAdminJson/);
  assert.match(activationSource, /'\/biometria\/revocar',[\s\S]*requireAttendancePermission/);
  assert.doesNotMatch(activationSource, /biometria\/desafio|biometria\/verificar|biometria\/registrar/);
  assert.doesNotMatch(activationSource, /replaceRouteHandlers|routeLayer|router\.stack/);
  assert.equal(fs.existsSync('src/routes/dispatchWorkerPortalActivationAdminCore.js'), false);
});
