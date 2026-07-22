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

function requestDouble({ method = 'GET', role = 'dev', username = 'dev', body = {}, headers = {} } = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    method,
    body,
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

function buildRouter(options = {}) {
  return dispatchWorkerPortalActivationAdminRouter({}, {
    repository: {},
    env: { RAILWAY_PUBLIC_DOMAIN: 'lorren.example.up.railway.app' },
    ttlMinutes: 30,
    nowFn: () => NOW,
    loadWorkersFn: async () => [{
      id: WORKER_ID,
      fullName: 'Auxiliar Prueba',
      documentNumber: '1234567890',
      operationalStatus: 'CONTRATADO',
      isTestProfile: false
    }],
    findWorkerFn: async () => ({
      id: WORKER_ID,
      fullName: 'Auxiliar Prueba',
      documentNumber: '1234567890',
      operationalStatus: 'CONTRATADO',
      isTestProfile: false
    }),
    issueActivationFn: async () => ({
      activationId: 'activation-1',
      workerId: WORKER_ID,
      rawToken: TOKEN,
      expiresAt: EXPIRES_AT
    }),
    ...options
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

test('GET exige DEV y nunca muestra la pantalla a reclutadores', async () => {
  const router = buildRouter();
  const { res, state } = responseDouble();
  await runRoute(router, '/', 'get', requestDouble({ role: 'admin' }), res);
  assert.equal(state.statusCode, 403);
  assert.equal(state.send, 'Acceso restringido a DEV');
  assert.equal(state.render, null);
});

test('GET DEV lista solo el modelo sanitizado y aplica no-store', async () => {
  const router = buildRouter();
  const { res, state } = responseDouble();
  await runRoute(router, '/', 'get', requestDouble(), res);
  assert.equal(state.statusCode, 200);
  assert.equal(state.render.view, 'operacionesPortalActivaciones');
  assert.equal(state.render.locals.workers[0].id, WORKER_ID);
  assert.equal(state.render.locals.workers[0].label, 'Auxiliar Prueba · 7890');
  assert.equal(state.render.locals.workers[0].documentNumber, undefined);
  assert.match(state.headers['Cache-Control'], /no-store/);
});

test('POST rechaza solicitudes sin cabecera personalizada antes de emitir', async () => {
  let issueCalls = 0;
  const router = buildRouter({
    issueActivationFn: async () => { issueCalls += 1; return null; }
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

test('POST DEV emite un enlace con fragmento y registra el actor sin devolver token separado', async () => {
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
  await runRoute(router, '/emitir', 'post', requestDouble({
    method: 'POST',
    username: 'dev-principal',
    body: { workerId: WORKER_ID },
    headers: {
      'content-type': 'application/json',
      'x-requested-with': WORKER_PORTAL_ACTIVATION_ADMIN_HEADER
    }
  }), res);

  assert.equal(state.statusCode, 201);
  assert.equal(observedInput.workerId, WORKER_ID);
  assert.equal(observedInput.createdByUsername, 'dev-principal');
  assert.equal(observedInput.ttlMinutes, 30);
  assert.equal(state.json.ok, true);
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
      resolveOriginFn: () => { throw new Error('attendance_portal_public_origin_required'); }
    });
    const { res, state } = responseDouble();
    await runRoute(router, '/emitir', 'post', requestDouble({
      method: 'POST',
      body: { workerId: WORKER_ID },
      headers: {
        'content-type': 'application/json',
        'x-requested-with': WORKER_PORTAL_ACTIVATION_ADMIN_HEADER
      }
    }), res);
    assert.equal(state.statusCode, 503);
    assert.deepEqual(state.json, { ok: false, error: 'activation_service_unavailable' });
    assert.equal(JSON.stringify(logs).includes(TOKEN), false);
  } finally {
    console.error = originalError;
  }
});

test('la pantalla copia únicamente mediante clic y conserva alternativa manual', () => {
  const view = fs.readFileSync('src/views/operacionesPortalActivaciones.ejs', 'utf8');
  const copyListenerIndex = view.indexOf("copyButton?.addEventListener('click'");
  const clipboardIndex = view.indexOf('navigator.clipboard.writeText');
  assert.ok(copyListenerIndex >= 0);
  assert.ok(clipboardIndex > copyListenerIndex);
  assert.match(view, /activationUrl\.focus\(\)/);
  assert.match(view, /activationUrl\.select\(\)/);
  assert.match(view, /No abras este enlace en tu computador/);
  assert.doesNotMatch(view, /window\.open\(|location\.href\s*=\s*activationUrl/);
});

test('dispatchBridge monta la ruta bajo DEV y muestra el botón en el control temporal', () => {
  const source = fs.readFileSync('src/routes/dispatchBridge.js', 'utf8');
  assert.match(source, /dispatchWorkerPortalActivationAdminRouter/);
  assert.match(source, /'\/portal-activaciones',[\s\S]*requireDev,[\s\S]*dispatchWorkerPortalActivationAdminRouter\(prisma\)/);
  assert.match(source, /href="\/admin\/operaciones\/portal-activaciones"/);
  assert.match(source, /Activar Portal del Auxiliar/);
});
