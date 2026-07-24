import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { workerPortalRouter } from '../src/routes/workerPortal.js';

async function withPortalServer(callback) {
  const app = express();
  app.use('/operaciones/portal', workerPortalRouter({}, {
    repository: {},
    installationPepper: 'p'.repeat(32),
    nonceBytesFn: (size) => Buffer.alloc(size, 7)
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    return await callback(origin);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('sirve directamente todos los recursos críticos dentro del alcance del portal', async () => {
  await withPortalServer(async (origin) => {
    const [worker, runtime, manifestResponse, icon] = await Promise.all([
      fetch(`${origin}/operaciones/portal/service-worker.js`),
      fetch(`${origin}/operaciones/portal/offline.js`),
      fetch(`${origin}/operaciones/portal/manifest.webmanifest`),
      fetch(`${origin}/operaciones/portal/icon.svg`)
    ]);

    assert.equal(worker.status, 200);
    assert.match(worker.headers.get('content-type') || '', /application\/javascript/);
    assert.equal(worker.headers.get('service-worker-allowed'), '/operaciones/portal');
    assert.match(await worker.text(), /lorren-worker-arrivals/);

    assert.equal(runtime.status, 200);
    assert.match(runtime.headers.get('content-type') || '', /application\/javascript/);
    assert.match(await runtime.text(), /LorrenWorkerPortalOffline/);

    assert.equal(manifestResponse.status, 200);
    assert.match(manifestResponse.headers.get('content-type') || '', /application\/manifest\+json/);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.scope, '/operaciones/portal');
    assert.ok(manifest.icons.every((entry) => entry.src === '/operaciones/portal/icon.svg'));

    assert.equal(icon.status, 200);
    assert.match(icon.headers.get('content-type') || '', /image\/svg\+xml/);
    assert.match(await icon.text(), /Lórren Asistencia/);
  });
});
