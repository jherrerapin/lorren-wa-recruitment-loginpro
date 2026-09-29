import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  acquireMessageLock,
  releaseMessageLock
} from '../src/infrastructure/transport/messageIdempotency.js';

test('retorna true cuando registra un messageId nuevo', async () => {
  const calls = [];
  const dependencies = {
    prisma: {
      webhookEvent: {
        async create(args) {
          calls.push(args);
          return { id: 'event-1', ...args.data };
        }
      }
    }
  };

  assert.equal(await acquireMessageLock('  wamid.new-1  ', dependencies), true);
  assert.deepEqual(calls, [{ data: { messageId: 'wamid.new-1' } }]);
});

test('retorna false únicamente ante una violación única P2002', async () => {
  const dependencies = {
    prisma: {
      webhookEvent: {
        async create() {
          const error = new Error('Unique constraint failed');
          error.code = 'P2002';
          error.meta = { target: ['messageId'] };
          throw error;
        }
      }
    }
  };

  assert.equal(await acquireMessageLock('wamid.duplicate-1', dependencies), false);
});

test('propaga cualquier otro error de base de datos sin ocultarlo', async () => {
  const databaseError = new Error('database unavailable');
  databaseError.code = 'P1001';
  const dependencies = {
    prisma: {
      webhookEvent: {
        async create() {
          throw databaseError;
        }
      }
    }
  };

  await assert.rejects(
    acquireMessageLock('wamid.retry-later', dependencies),
    (error) => error === databaseError
  );
});

test('rechaza identificadores vacíos y dependencias incompletas', async () => {
  await assert.rejects(acquireMessageLock('   ', {}), /messageId must be a non-empty string/);
  await assert.rejects(
    acquireMessageLock('wamid.valid', { prisma: {} }),
    /dependencies\.prisma\.webhookEvent\.create must be a function/
  );
});

test('libera el candado de un intento fallido para permitir el reintento durable', async () => {
  const calls = [];
  await releaseMessageLock(' wamid.retry-1 ', {
    prisma: {
      webhookEvent: {
        async deleteMany(args) {
          calls.push(args);
          return { count: 1 };
        }
      }
    }
  });

  assert.deepEqual(calls, [{ where: { messageId: 'wamid.retry-1' } }]);
});

test('el esquema y la migración declaran la restricción única que da autoridad al lock', async () => {
  const schema = await readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  const migration = await readFile(
    new URL('../prisma/migrations/20260923190000_add_webhook_event_idempotency/migration.sql', import.meta.url),
    'utf8'
  );

  assert.match(schema, /model WebhookEvent\s*{[\s\S]*messageId\s+String\s+@unique/);
  assert.match(migration, /CREATE UNIQUE INDEX "WebhookEvent_messageId_key"/);
});
