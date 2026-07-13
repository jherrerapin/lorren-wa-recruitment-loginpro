import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
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

test('router Meta Ads queda acotado al gate y responde antes de la ruta heredada', async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.userRole = 'dev';
    req.prisma = {};
    next();
  });

  const legacyRouter = express.Router();
  legacyRouter.post('/campaigns', requireLorenV2, (_req, res) => {
    res.status(500).send('legacy-handler-should-not-run');
  });
  app.use('/admin/estadisticas', legacyRouter);

  const server = await listen(app);
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/admin/estadisticas/campaigns`, {
      method: 'POST',
      redirect: 'manual'
    });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/admin/estadisticas/campaigns');
  } finally {
    await close(server);
  }
});
