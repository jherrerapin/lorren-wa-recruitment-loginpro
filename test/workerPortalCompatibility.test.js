import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ATTENDANCE_PORTAL_RELEASE_ID,
  ATTENDANCE_PORTAL_RELEASE_PATH,
  WORKER_PORTAL_LEGACY_ADMIN_PATH,
  WORKER_PORTAL_PUBLIC_PATH,
  workerPortalCompatibilityRouter
} from '../src/routes/workerPortalCompatibility.js';

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

test('la URL antigua de admin redirige al portal público correcto', () => {
  const router = workerPortalCompatibilityRouter();
  const { res, state } = responseDouble();

  routeHandler(router, WORKER_PORTAL_LEGACY_ADMIN_PATH)({}, res);

  assert.equal(state.statusCode, 302);
  assert.equal(state.redirect, WORKER_PORTAL_PUBLIC_PATH);
  assert.match(state.headers['Cache-Control'], /no-store/);
});

test('la URL antigua de activación redirige a la ruta pública', () => {
  const router = workerPortalCompatibilityRouter();
  const { res, state } = responseDouble();

  routeHandler(router, `${WORKER_PORTAL_LEGACY_ADMIN_PATH}/activar`)({}, res);

  assert.equal(state.statusCode, 302);
  assert.equal(state.redirect, `${WORKER_PORTAL_PUBLIC_PATH}/activar`);
});

test('la ruta de release permite confirmar el deployment exacto', () => {
  const router = workerPortalCompatibilityRouter();
  const { res, state } = responseDouble();

  routeHandler(router, ATTENDANCE_PORTAL_RELEASE_PATH)({}, res);

  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.json, {
    service: 'lorren-attendance-portal',
    release: ATTENDANCE_PORTAL_RELEASE_ID,
    legacyAdminRedirect: true,
    publicPortalPath: WORKER_PORTAL_PUBLIC_PATH
  });
  assert.equal(state.json.release, 'attendance-portal-2026-07-22-r2');
});

test('server importa y monta la compatibilidad antes del portal público', () => {
  const source = fs.readFileSync('src/server.js', 'utf8');
  const importStatement = "import { workerPortalCompatibilityRouter } from './routes/workerPortalCompatibility.js';";
  const compatibilityMount = 'app.use(workerPortalCompatibilityRouter());';
  const publicPortalMount = "app.use('/operaciones/portal', wrapAsyncRouter(workerPortalRouter(prisma)));";

  assert.match(source, new RegExp(importStatement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(source.match(/app\.use\(workerPortalCompatibilityRouter\(\)\);/g)?.length, 1);
  assert.ok(source.indexOf(compatibilityMount) < source.indexOf(publicPortalMount));
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
