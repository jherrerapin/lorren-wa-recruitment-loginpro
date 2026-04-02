import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageDirection, MessageType } from '@prisma/client';
import { webhookRouter, saveInboundMessage } from '../src/routes/webhook.js';

function getPostHandler(router) {
  return router.stack.find((layer) => layer.route?.path === '/' && layer.route.methods.post)?.route?.stack?.[0]?.handle;
}

test('saveInboundMessage es idempotente: mismo waMessageId solo inserta una vez', async () => {
  const rows = [];
  let seq = 1;
  const prisma = {
    message: {
      async createMany({ data, skipDuplicates }) {
        assert.equal(skipDuplicates, true);
        const item = data[0];
        const exists = rows.find((row) => row.waMessageId && row.waMessageId === item.waMessageId);
        if (exists) return { count: 0 };
        rows.push({ id: seq++, ...item });
        return { count: 1 };
      },
      async findUnique({ where }) {
        const found = rows.find((row) => row.waMessageId === where.waMessageId);
        return found ? { id: found.id } : null;
      }
    }
  };

  const first = await saveInboundMessage(
    prisma,
    7,
    { id: 'wamid.abc', from: '573001112233', type: 'text' },
    'hola',
    MessageType.TEXT,
    '573001112233'
  );
  const second = await saveInboundMessage(
    prisma,
    7,
    { id: 'wamid.abc', from: '573001112233', type: 'text' },
    'hola',
    MessageType.TEXT,
    '573001112233'
  );

  assert.equal(rows.length, 1);
  assert.equal(first.isNew, true);
  assert.equal(typeof first.id, 'number');
  assert.equal(second.isNew, false);
  assert.equal(second.id, null);
});

test('webhook ignora duplicados sin reprocesar, sin responder y sin reabrir ventana multilinea', async () => {
  let duplicateLogs = 0;
  const originalLog = console.log;
  console.log = (...args) => {
    if (args[0] === '[INBOUND_DUPLICATE_IGNORED]') duplicateLogs += 1;
  };

  const counters = {
    scheduleWindowCalls: 0,
    outboundSaves: 0,
    candidateUpdates: 0,
    processQueries: 0
  };

  const prisma = {
    candidate: {
      async upsert() {
        return { id: 11, phone: '573001112233' };
      },
      async update() {
        counters.candidateUpdates += 1;
        return { id: 11 };
      },
      async findUnique() {
        counters.processQueries += 1;
        return { id: 11, currentStep: 'MENU' };
      },
      async updateMany() {
        counters.scheduleWindowCalls += 1;
        return { count: 1 };
      }
    },
    message: {
      async createMany() {
        return { count: 0 };
      },
      async findUnique() {
        return null;
      },
      async create({ data }) {
        if (data.direction === MessageDirection.OUTBOUND) counters.outboundSaves += 1;
        return { id: 1 };
      },
      async update() {
        throw new Error('No debería actualizar respondedAt en duplicado');
      },
      async updateMany() {
        throw new Error('No debería actualizar batch en duplicado');
      },
      async findMany() {
        throw new Error('No debería leer batch en duplicado');
      }
    }
  };

  const router = webhookRouter(prisma);
  const handler = getPostHandler(router);
  assert.ok(handler, 'No se encontró handler POST del webhook');

  const req = {
    body: {
      entry: [{
        changes: [{
          value: {
            messages: [{
              id: 'wamid.duplicate',
              from: '573001112233',
              type: 'text',
              text: { body: 'hola' }
            }]
          }
        }]
      }]
    }
  };

  const response = { status: null };
  const res = {
    sendStatus(code) {
      response.status = code;
      return code;
    }
  };

  let nextError = null;
  const next = (error) => { nextError = error; };

  await handler(req, res, next);
  console.log = originalLog;

  assert.equal(nextError, null);
  assert.equal(response.status, 200);
  assert.equal(duplicateLogs, 1);
  assert.equal(counters.scheduleWindowCalls, 0);
  assert.equal(counters.outboundSaves, 0);
  assert.equal(counters.candidateUpdates, 0);
  assert.equal(counters.processQueries, 0);
});
