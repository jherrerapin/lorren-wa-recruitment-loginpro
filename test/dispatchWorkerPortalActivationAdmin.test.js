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
  const state = {
    headers: {},
    statusCode: 200,
    json: null,
    render: null,
    redirect: null,
    send: null
  };
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
    sessionRepository: {},
    env: {
      RAILWAY_PUBLIC_DOMAIN: 'lorren.example.up.railway.app',
      ATTENDANCE_BIOMETRIC_SECRET: 'b'.repeat(64)
    },
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

test('rechaza orígenes inseguros, con rutas o credenciales', () => {
  assert.throws(
    () => resolveWorkerPortalPublicOrigin({ ATTENDANCE_PORTAL_PUBLIC_ORIGIN: 'http://lorren.example' }),
    /attendance_portal_public_origin_https_required/
  );
  assert.throws(
    () => resolveWorkerPortalPublicOrigin({ ATTENDANCE_PORTAL_PUBLIC_ORIGIN: 'https://lorren.example/admin' }),
    /attendance_portal_public_origin_path_not_allowed/
  );
  assert.throws(
    () => resolveWorkerPortalPublicOrigin({ ATTENDANCE_PORTAL_PUBLIC_ORIGIN: 'https://user:pass@lorren.example' }),
    /attendance_portal_public_origin_invalid/
  );
});

test('GET niega por defecto a un administrador sin permiso de Asistencia', async () => {
  const router = buildRouter();
  const { res, state } = responseDouble();
  await runRoute(router, '/', 'get', requestDouble({ role: 'admin' }), res);
  assert.equal(state.statusCode, 403);
  assert.equal(state.send, 'No tienes permiso para gestionar activaciones del Portal del Auxiliar');
  assert.equal(state.render, null);
});

test('GET permite a DEV y mantiene respuesta sin almacenamiento', async () => {
  const router = buildRouter();
  const { res, state } = responseDouble();
  await runRoute(router, '/', 'get', requestDouble(), res);
  assert.equal(state.statusCode, 200);
  assert.equal(state.render.view, 'operacionesPortalActivaciones');
  assert.equal(state.render.locals.workers[0].label, 'Auxiliar Prueba · Directo');
  assert.equal(state.render.locals.workers[0].documentNumber, undefined);
  assert.equal(state.render.locals.workers[0].biometric.enrolled, false);
  assert.match(state.headers['Cache-Control'], /no-store/);
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
  assert.equal(state.render.view, 'operacionesPortalActivaciones');
  assert.equal(state.render.locals.role, 'admin');
});

test('la consulta predeterminada replica Personal operativo: solo CONTRATADO de DispatchWorker', async () => {
  let observedQuery;
  const prisma = {
    dispatchWorker: {
      async findMany(query) {
        observedQuery = query;
        return [workerFixture({ contractType: 'CONTRATISTA' })];
      }
    }
  };
  const router = dispatchWorkerPortalActivationAdminRouter(prisma, {
    repository: {},
    sessionRepository: {},
    env: {
      RAILWAY_PUBLIC_DOMAIN: 'lorren.example.up.railway.app',
      ATTENDANCE_BIOMETRIC_SECRET: 'b'.repeat(64)
    },
    ttlMinutes: 30,
    nowFn: () => NOW,
    loadBiometricStatusMapFn: async () => new Map()
  });
  const { res, state } = responseDouble();

  await runRoute(router, '/', 'get', requestDouble(), res);

  assert.deepEqual(observedQuery.where, { operationalStatus: 'CONTRATADO' });
  assert.equal(observedQuery.select.contractType, true);
  assert.equal(observedQuery.select.documentNumber, undefined);
  assert.equal(state.render.locals.workers[0].label, 'Auxiliar Prueba · Contratista');
});

test('POST niega a un administrador sin permiso antes de emitir', async () => {
  let issueCalls = 0;
  const router = buildRouter({
    issueActivationFn: async () => {
      issueCalls += 1;
      return null;
    }
  });
  const { res, state } = responseDouble();
  await runRoute(router, '/emitir', 'post', validPostRequest({ role: 'admin' }), res);
  assert.equal(state.statusCode, 403);
  assert.deepEqual(state.json, { ok: false, error: 'forbidden' });
  assert.equal(issueCalls, 0);
});

test('POST rechaza solicitudes sin cabecera personalizada antes de emitir', async () => {
  let issueCalls = 0;
  const router = buildRouter({
    issueActivationFn: async () => {
      issueCalls += 1;
      return null;
    }
  });
  const { res, state } = responseDouble();
  await runRoute(router, '/emitir', 'post', requestDouble({
    method: 'POST',
    body: { workerId: WORKER_ID },
    headers: { 'content-type': 'application/json' }
  }), res);
  assert.equal(state.statusCode, 400);
  assert.deepEqual(state.json, { ok: false, error: 'activation_request_invalid' });
  assert.equal(issueCalls, 0);
});

test('POST con permiso emite enlace y registra al usuario autorizado como actor', async () => {
  let observedInput;
  const router = buildRouter({
    issueActivationFn: async (input) => {
      observedInput = input;
      return {
        activationId: 'activation-1',
        workerId: WORKER_ID,
        rawToken: TOKEN,
        expiresAt: EXPIRES_AT
      };
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
  assert.equal(observedInput.ttlMinutes, 30);
  assert.equal(state.json.ok, true);
  assert.equal(state.json.worker.contractType, 'Directo');
  assert.equal(state.json.activationUrl, `https://lorren.example.up.railway.app/operaciones/portal/activar#token=${TOKEN}`);
  assert.equal(state.json.rawToken, undefined);
  assert.equal(state.json.expiresAt, EXPIRES_AT.toISOString());
});

test('un origen público faltante falla cerrado sin filtrar el token', async () => {
  const originalError = console.error;
  const logs = [];
  console.error = (...values) => logs.push(values);
  try {
    const router = buildRouter({
      resolveOriginFn: () => {
        throw new Error('attendance_portal_public_origin_required');
      }
    });
    const { res, state } = responseDouble();
    await runRoute(router, '/emitir', 'post', validPostRequest(), res);
    assert.equal(state.statusCode, 503);
    assert.deepEqual(state.json, { ok: false, error: 'activation_service_unavailable' });
    assert.equal(JSON.stringify(logs).includes(TOKEN), false);
  } finally {
    console.error = originalError;
  }
});

test('la pantalla conserva la emisión del enlace y mueve el rostro al portal', () => {
  const view = fs.readFileSync('src/views/operacionesPortalActivaciones.ejs', 'utf8');
  const hardening = fs.readFileSync('src/public/worker-portal-hardening.js', 'utf8');
  const copyListenerIndex = view.indexOf("copyButton?.addEventListener('click'");
  const clipboardIndex = view.indexOf('navigator.clipboard.writeText');
  assert.ok(copyListenerIndex >= 0);
  assert.ok(clipboardIndex > copyListenerIndex);
  assert.match(view, /Gestión de asistencia/);
  assert.match(hardening, /getElementById\('enroll-button'\)\?\.remove/);
  assert.match(hardening, /getElementById\('biometric-dialog'\)\?\.remove/);
  assert.match(hardening, /Registro facial desde el portal/);
  assert.match(view, /No abras este enlace en tu computador/);
  assert.doesNotMatch(view, /window\.open\(|location\.href\s*=\s*activationUrl/);
});

test('las rutas administrativas conservan permisos y la biometría usa sesión del portal', () => {
  const bridgeSource = fs.readFileSync('src/routes/dispatchBridge.js', 'utf8');
  const personalView = fs.readFileSync('src/views/operacionesPersonal.ejs', 'utf8');
  const activationSource = fs.readFileSync('src/routes/dispatchWorkerPortalActivationAdmin.js', 'utf8');
  const activationCoreSource = fs.readFileSync('src/routes/dispatchWorkerPortalActivationAdminCore.js', 'utf8');

  assert.match(bridgeSource, /'\/portal-activaciones',[\s\S]*dispatchWorkerPortalActivationAdminRouter\(prisma\)/);
  assert.match(activationCoreSource, /router\.get\('\/', requireAttendancePermission/);
  assert.match(activationCoreSource, /router\.post\('\/emitir', requireAttendancePermission, requireAdminJson/);
  assert.match(activationCoreSource, /router\.post\('\/biometria\/revocar', requireAttendancePermission, requireAdminJson/);
  assert.match(activationSource, /replacementRouter\.post\('\/biometria\/desafio', parsePortalCookie, requireWorkerPortalJson/);
  assert.match(activationSource, /replacementRouter\.post\('\/biometria\/verificar', parsePortalCookie, requireWorkerPortalJson/);
  assert.match(activationSource, /biometric_enrollment_moved_to_worker_portal/);
  assert.match(activationSource, /resolvePortalRequestSession/);
  assert.match(activationSource, /loadBiometricAssignment/);
  assert.match(bridgeSource, /filterOperationsPersonalAttendanceHtml/);
  assert.match(activationCoreSource, /currentRole\(req\) === 'dev' \|\| req\.canAccessAttendanceFeature === true/);
  assert.match(personalView, /<% if \(role === 'dev'\) \{ %>[\s\S]*Sincronizar contratados/);
});
