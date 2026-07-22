import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ATTENDANCE_PORTAL_RELEASE_ID,
  WORKER_PORTAL_PUBLIC_PATH,
  dispatchBridgeRouter
} from '../src/routes/dispatchBridge.js';

function responseDouble() {
  const state = {
    headers: {},
    statusCode: 200,
    redirect: null,
    json: null
  };

  return {
    state,
    res: {
      locals: {},
      set(name, value) {
        state.headers[name] = value;
        return this;
      },
      status(code) {
        state.statusCode = code;
        return this;
      },
      redirect(statusCode, location) {
        state.statusCode = statusCode;
        state.redirect = location;
        return this;
      },
      json(payload) {
        state.json = payload;
        return payload;
      }
    }
  };
}

function routeHandler(router, path) {
  const layer = router.stack.find((item) => item.route?.path === path && item.route.methods?.get);
  assert.ok(layer, `GET ${path} debe existir`);
  return layer.route.stack.at(-1).handle;
}

test('GET /admin/operaciones/portal redirige al portal público', () => {
  const router = dispatchBridgeRouter();
  const { res, state } = responseDouble();

  routeHandler(router, '/portal')({}, res);

  assert.equal(state.statusCode, 302);
  assert.equal(state.redirect, WORKER_PORTAL_PUBLIC_PATH);
  assert.match(state.headers['Cache-Control'], /no-store/);
});

test('GET /admin/operaciones/portal/activar redirige a activación pública', () => {
  const router = dispatchBridgeRouter();
  const { res, state } = responseDouble();

  routeHandler(router, '/portal/activar')({}, res);

  assert.equal(state.statusCode, 302);
  assert.equal(state.redirect, `${WORKER_PORTAL_PUBLIC_PATH}/activar`);
});

test('la ruta administrativa de release devuelve la versión exacta', () => {
  const router = dispatchBridgeRouter();
  const { res, state } = responseDouble();

  routeHandler(router, '/portal-release')({}, res);

  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.json, {
    service: 'lorren-attendance-portal',
    release: ATTENDANCE_PORTAL_RELEASE_ID,
    legacyAdminRedirect: true,
    publicPortalPath: WORKER_PORTAL_PUBLIC_PATH
  });
  assert.equal(state.json.release, 'attendance-portal-2026-07-22-r2');
});

test('la marca pública coincide con la constante de runtime', () => {
  const marker = JSON.parse(fs.readFileSync('src/public/attendance-portal-release.json', 'utf8'));
  assert.equal(marker.release, ATTENDANCE_PORTAL_RELEASE_ID);
  assert.equal(marker.legacyAdminRedirect, true);
  assert.equal(marker.publicPortalPath, WORKER_PORTAL_PUBLIC_PATH);
});

test('los cambios funcionales de #610 permanecen presentes', () => {
  const personalView = fs.readFileSync('src/views/operacionesPersonal.ejs', 'utf8');
  const activationRouter = fs.readFileSync('src/routes/dispatchWorkerPortalActivationAdmin.js', 'utf8');
  const activationView = fs.readFileSync('src/views/operacionesPortalActivaciones.ejs', 'utf8');

  assert.match(personalView, /Activar Portal del Auxiliar/);
  assert.match(personalView, /\/admin\/operaciones\/portal-activaciones/);
  assert.match(activationRouter, /const ACTIVE_DISPATCH_WORKER_STATUS = 'CONTRATADO'/);
  assert.match(activationRouter, /operationalStatus:\s*ACTIVE_DISPATCH_WORKER_STATUS/);
  assert.match(activationRouter, /contractType/);
  assert.doesNotMatch(activationRouter, /documentNumber\.slice/);
  assert.match(activationView, /Directo<\/strong> o <strong>Contratista/);
});
