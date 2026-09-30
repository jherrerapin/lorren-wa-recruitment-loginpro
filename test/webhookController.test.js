import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import express from 'express';
import {
  createMetaVerificationHandler,
  createWebhookController,
  createWebhookJsonParser
} from '../src/routes/webhookController.js';

const SECRET = 'meta-app-secret';

function metaBody(message = null) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: message
      ? { messages: [message] }
      : { statuses: [{ id: 'status-1', status: 'read' }] } }] }]
  };
}

function requestFor(body, { signature } = {}) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const resolvedSignature = signature
    ?? `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
  return {
    body,
    rawBody,
    headers: { 'x-hub-signature-256': resolvedSignature },
    get(name) { return this.headers[name.toLowerCase()]; }
  };
}

function response() {
  return {
    statuses: [],
    sendStatus(status) {
      this.statuses.push(status);
      return this;
    }
  };
}

function actionableMessage() {
  return {
    id: 'wamid.inbound-1',
    from: '573001112233',
    timestamp: '1727100000',
    type: 'text',
    text: { body: 'Hola' }
  };
}

function harness({ enqueueError = null } = {}) {
  const calls = [];
  const errors = [];
  const prisma = { name: 'prisma' };
  const overrides = {
    async enqueueInboundMessage(payload, dependencies) {
      calls.push({ payload, dependencies });
      if (enqueueError) throw enqueueError;
      return { id: 'job-1' };
    }
  };
  const dependencies = {
    prisma,
    secret: SECRET,
    logger: { error(...args) { errors.push(args); } }
  };
  return { calls, errors, overrides, dependencies, prisma };
}

test('rechaza con 401 una firma inválida sin guardar el mensaje', async () => {
  const h = harness();
  const controller = createWebhookController(h.dependencies, h.overrides);
  const res = response();
  await controller(requestFor(metaBody(actionableMessage()), { signature: 'sha256=invalid' }), res);
  assert.deepEqual(res.statuses, [401]);
  assert.deepEqual(h.calls, []);
});

test('responde 200 al ruido de Meta sin crear un trabajo', async () => {
  const h = harness();
  const controller = createWebhookController(h.dependencies, h.overrides);
  const res = response();
  await controller(requestFor(metaBody()), res);
  assert.deepEqual(res.statuses, [200]);
  assert.deepEqual(h.calls, []);
});

test('solo responde 200 después de persistir el mensaje normalizado', async () => {
  const h = harness();
  const res = response();
  h.overrides.enqueueInboundMessage = async (payload, dependencies) => {
    assert.deepEqual(res.statuses, []);
    h.calls.push({ payload, dependencies });
    return { id: 'job-1' };
  };
  const controller = createWebhookController(h.dependencies, h.overrides);
  await controller(requestFor(metaBody(actionableMessage())), res);
  assert.deepEqual(res.statuses, [200]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].payload.messageId, 'wamid.inbound-1');
  assert.equal(h.calls[0].payload.text, 'Hola');
  assert.deepEqual(h.calls[0].dependencies, { prisma: h.prisma });
  assert.deepEqual(h.errors, []);
});

test('devuelve 500 y registra el error cuando PostgreSQL no asegura el mensaje', async () => {
  const h = harness({ enqueueError: new Error('database unavailable') });
  const controller = createWebhookController(h.dependencies, h.overrides);
  const res = response();
  await controller(requestFor(metaBody(actionableMessage())), res);
  assert.deepEqual(res.statuses, [500]);
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0][0].event, 'conversation_webhook.enqueue_error');
  assert.equal(h.errors[0][0].messageId, 'wamid.inbound-1');
  assert.equal(h.errors[0][0].error.message, 'database unavailable');
});

test('sin App Secret responde 503 y registra el fallo de configuración', async () => {
  const h = harness();
  h.dependencies.secret = '';
  const controller = createWebhookController(h.dependencies, h.overrides);
  const res = response();
  await controller(requestFor(metaBody(actionableMessage())), res);
  assert.deepEqual(res.statuses, [503]);
  assert.deepEqual(h.calls, []);
  assert.equal(h.errors[0][0].event, 'conversation_webhook.missing_app_secret');
});

test('la ruta HTTP conserva los bytes firmados y verifica el challenge GET', async () => {
  const h = harness();
  const app = express();
  app.get('/webhook', createMetaVerificationHandler('verify-token'));
  app.post('/webhook', createWebhookJsonParser(), createWebhookController(h.dependencies, h.overrides));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve, reject) => {
      if (server.listening) return resolve();
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const body = JSON.stringify(metaBody(actionableMessage()), null, 2);
    const signature = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
    const valid = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      body
    });
    assert.equal(valid.status, 200);
    assert.equal(h.calls.length, 1);

    const invalid = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      body: `${body} `
    });
    assert.equal(invalid.status, 401);
    assert.equal(h.calls.length, 1);

    const challenge = await fetch(`${baseUrl}/webhook?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=challenge-123`);
    assert.equal(challenge.status, 200);
    assert.equal(await challenge.text(), 'challenge-123');
    const wrongToken = await fetch(`${baseUrl}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge-123`);
    assert.equal(wrongToken.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
