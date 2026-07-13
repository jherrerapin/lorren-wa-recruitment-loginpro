import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { lorenV2Router } from '../src/routes/lorenV2.js';
import { requireLorenV2 } from '../src/services/lorenV2Gate.js';

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function buildApp(syncMetaAds) {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => {
    req.userRole = 'dev';
    req.username = 'dev';
    req.userAccessScope = 'ALL';
    next();
  });
  app.use('/admin/estadisticas', lorenV2Router({}, { syncMetaAds }));
  return app;
}

async function postSync(app) {
  const server = await listen(app);
  try {
    const address = server.address();
    return await fetch(`http://127.0.0.1:${address.port}/admin/estadisticas/campaigns/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'since=2026-07-01&until=2026-07-13',
      redirect: 'manual'
    });
  } finally {
    await close(server);
  }
}

test('requireLorenV2 solo autoriza y entrega el control al siguiente handler', () => {
  let nextCalled = false;
  const req = { userRole: 'dev' };
  const res = {
    status: () => res,
    send: () => {
      throw new Error('No debe responder para dev');
    }
  };

  requireLorenV2(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
});

test('el router compuesto procesa una sincronización exitosa sin despachador lateral', async () => {
  const response = await postSync(buildApp(async () => ({
    ok: true,
    partial: false,
    currentAds: 0,
    missingAds: 8
  })));

  assert.equal(response.status, 302);
  const location = response.headers.get('location');
  assert.match(location, /^\/admin\/estadisticas\/campaigns\?/);
  assert.match(location, /sync=success/);
  assert.match(location, /currentAds=0/);
  assert.match(location, /missingAds=8/);
});

test('un fallo de métricas informa sincronización parcial y no devuelve JSON 500', async () => {
  const response = await postSync(buildApp(async () => ({
    ok: true,
    partial: true,
    currentAds: 0,
    missingAds: 5
  })));

  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /sync=partial/);
});

test('un error controlado de inventario vuelve al panel con estado de error', async () => {
  const response = await postSync(buildApp(async () => ({
    ok: false,
    stage: 'inventory_fetch',
    error: { code: 200 }
  })));

  assert.equal(response.status, 302);
  const location = response.headers.get('location');
  assert.match(location, /sync=error/);
  assert.match(location, /stage=inventory_fetch/);
  assert.match(location, /code=200/);
});

test('una excepción inesperada también vuelve al panel y no expone internal_server_error', async () => {
  const response = await postSync(buildApp(async () => {
    throw new Error('fallo inesperado');
  }));

  assert.equal(response.status, 302);
  const location = response.headers.get('location');
  assert.match(location, /sync=error/);
  assert.match(location, /stage=unexpected/);
  assert.match(location, /META_ADS_SYNC_UNEXPECTED/);
});
