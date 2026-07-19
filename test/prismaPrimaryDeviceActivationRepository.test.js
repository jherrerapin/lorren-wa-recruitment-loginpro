import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createPrismaPrimaryDeviceActivationRepository,
  isPrismaSerializationConflict,
  runSerializableActivationTransaction
} from '../src/modules/dispatch-attendance/infrastructure/prismaPrimaryDeviceActivationRepository.js';

const NOW = new Date('2026-07-19T12:00:00.000Z');
const LATER = new Date('2026-07-19T12:30:00.000Z');

function rootPrisma({ transaction, findActiveWorker } = {}) {
  return {
    dispatchWorker: {
      findFirst: findActiveWorker || (async () => ({ id: 'worker-1', operationalStatus: 'CONTRATADO' }))
    },
    dispatchWorkerActivation: {},
    dispatchWorkerDevice: {},
    $transaction: transaction || (async (operation) => operation({}))
  };
}

test('reconoce exclusivamente conflictos serializables de Prisma', () => {
  assert.equal(isPrismaSerializationConflict({ code: 'P2034' }), true);
  assert.equal(isPrismaSerializationConflict({ code: 'P2002' }), false);
  assert.equal(isPrismaSerializationConflict(null), false);
});

test('reintenta P2034 con aislamiento Serializable y conserva el resultado', async () => {
  const options = [];
  let attempts = 0;
  const prisma = rootPrisma({
    transaction: async (operation, transactionOptions) => {
      options.push(transactionOptions);
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('write conflict'), { code: 'P2034' });
      return operation({ ok: true });
    }
  });

  const result = await runSerializableActivationTransaction(prisma, async (tx) => tx.ok, { maxRetries: 2 });
  assert.equal(result, true);
  assert.equal(attempts, 3);
  assert.deepEqual(options, [
    { isolationLevel: 'Serializable' },
    { isolationLevel: 'Serializable' },
    { isolationLevel: 'Serializable' }
  ]);
});

test('no reintenta errores distintos de P2034', async () => {
  let attempts = 0;
  const prisma = rootPrisma({
    transaction: async () => {
      attempts += 1;
      throw Object.assign(new Error('unique'), { code: 'P2002' });
    }
  });

  await assert.rejects(
    runSerializableActivationTransaction(prisma, async () => null),
    (error) => error.code === 'P2002'
  );
  assert.equal(attempts, 1);
});

test('findActiveWorker admite ACTIVE y CONTRATADO, no cualquier estado', async () => {
  let query;
  const prisma = rootPrisma({
    findActiveWorker: async (input) => {
      query = input;
      return { id: 'worker-1', operationalStatus: 'CONTRATADO' };
    }
  });
  const repository = createPrismaPrimaryDeviceActivationRepository(prisma);

  const worker = await repository.findActiveWorker('worker-1');
  assert.equal(worker.id, 'worker-1');
  assert.deepEqual(query.where.operationalStatus.in, ['ACTIVE', 'CONTRATADO']);
  assert.equal(query.where.id, 'worker-1');
});

test('replacePendingActivation revalida trabajador, revoca pendientes y crea solo el hash', async () => {
  const calls = [];
  const tx = {
    dispatchWorker: {
      findFirst: async (input) => {
        calls.push(['worker', input]);
        return { id: 'worker-1' };
      }
    },
    dispatchWorkerActivation: {
      updateMany: async (input) => {
        calls.push(['revoke', input]);
        return { count: 2 };
      },
      create: async (input) => {
        calls.push(['create', input]);
        return { id: 'activation-2', workerId: 'worker-1', purpose: input.data.purpose, expiresAt: input.data.expiresAt };
      }
    }
  };
  const prisma = rootPrisma({ transaction: async (operation, options) => {
    assert.equal(options.isolationLevel, 'Serializable');
    return operation(tx);
  } });
  const repository = createPrismaPrimaryDeviceActivationRepository(prisma);

  const result = await repository.replacePendingActivation({
    workerId: 'worker-1',
    purpose: 'PRIMARY_DEVICE_ACTIVATION',
    tokenHash: 'a'.repeat(64),
    expiresAt: LATER,
    createdAt: NOW,
    createdByUsername: 'dev'
  });

  assert.equal(result.id, 'activation-2');
  assert.deepEqual(calls.map(([name]) => name), ['worker', 'revoke', 'create']);
  assert.equal(calls[1][1].data.status, 'REVOKED');
  assert.equal(calls[1][1].data.revocationReason, 'REPLACED_BY_NEW_ACTIVATION');
  assert.equal(calls[2][1].data.tokenHash, 'a'.repeat(64));
  assert.equal(Object.hasOwn(calls[2][1].data, 'rawToken'), false);
});

test('una activación vencida no consume token ni toca dispositivos', async () => {
  let deviceWrites = 0;
  const tx = {
    dispatchWorkerActivation: {
      findUnique: async () => ({
        id: 'activation-1', workerId: 'worker-1', purpose: 'PRIMARY_DEVICE_ACTIVATION', status: 'PENDING',
        expiresAt: new Date('2026-07-19T11:59:59.000Z'), consumedAt: null, revokedAt: null
      })
    },
    dispatchWorker: { findFirst: async () => ({ id: 'worker-1' }) },
    dispatchWorkerDevice: {
      updateMany: async () => { deviceWrites += 1; },
      upsert: async () => { deviceWrites += 1; }
    }
  };
  const prisma = rootPrisma({ transaction: async (operation) => operation(tx) });
  const repository = createPrismaPrimaryDeviceActivationRepository(prisma);

  const result = await repository.claimActivationAndAuthorizePrimaryDevice({
    purpose: 'PRIMARY_DEVICE_ACTIVATION', tokenHash: 'b'.repeat(64), installationIdHash: 'c'.repeat(64),
    now: NOW, userAgent: null, platform: null
  });

  assert.equal(result, null);
  assert.equal(deviceWrites, 0);
});

test('reclamo condicional perdido evita doble consumo y no cambia dispositivos', async () => {
  let deviceWrites = 0;
  const tx = {
    dispatchWorkerActivation: {
      findUnique: async () => ({
        id: 'activation-1', workerId: 'worker-1', purpose: 'PRIMARY_DEVICE_ACTIVATION', status: 'PENDING',
        expiresAt: LATER, consumedAt: null, revokedAt: null
      }),
      updateMany: async () => ({ count: 0 })
    },
    dispatchWorker: { findFirst: async () => ({ id: 'worker-1' }) },
    dispatchWorkerDevice: {
      updateMany: async () => { deviceWrites += 1; },
      upsert: async () => { deviceWrites += 1; }
    }
  };
  const prisma = rootPrisma({ transaction: async (operation) => operation(tx) });
  const repository = createPrismaPrimaryDeviceActivationRepository(prisma);

  const result = await repository.claimActivationAndAuthorizePrimaryDevice({
    purpose: 'PRIMARY_DEVICE_ACTIVATION', tokenHash: 'b'.repeat(64), installationIdHash: 'c'.repeat(64),
    now: NOW, userAgent: null, platform: null
  });

  assert.equal(result, null);
  assert.equal(deviceWrites, 0);
});

test('activación exitosa consume, revoca el principal anterior, autoriza y enlaza el nuevo', async () => {
  const calls = [];
  const tx = {
    dispatchWorkerActivation: {
      findUnique: async () => ({
        id: 'activation-1', workerId: 'worker-1', purpose: 'PRIMARY_DEVICE_ACTIVATION', status: 'PENDING',
        expiresAt: LATER, consumedAt: null, revokedAt: null
      }),
      updateMany: async (input) => {
        calls.push(['claim', input]);
        return { count: 1 };
      },
      update: async (input) => {
        calls.push(['link', input]);
        return { id: 'activation-1' };
      }
    },
    dispatchWorker: { findFirst: async () => ({ id: 'worker-1' }) },
    dispatchWorkerDevice: {
      updateMany: async (input) => {
        calls.push(['revoke-device', input]);
        return { count: 1 };
      },
      upsert: async (input) => {
        calls.push(['upsert-device', input]);
        return { id: 'device-2', workerId: 'worker-1', authorizedFrom: NOW };
      }
    }
  };
  const prisma = rootPrisma({ transaction: async (operation, options) => {
    assert.equal(options.isolationLevel, 'Serializable');
    return operation(tx);
  } });
  const repository = createPrismaPrimaryDeviceActivationRepository(prisma);

  const result = await repository.claimActivationAndAuthorizePrimaryDevice({
    purpose: 'PRIMARY_DEVICE_ACTIVATION', tokenHash: 'b'.repeat(64), installationIdHash: 'c'.repeat(64),
    now: NOW, userAgent: 'Browser', platform: 'Android'
  });

  assert.deepEqual(result, { workerId: 'worker-1', deviceId: 'device-2', activatedAt: NOW });
  assert.deepEqual(calls.map(([name]) => name), ['claim', 'revoke-device', 'upsert-device', 'link']);
  assert.equal(calls[0][1].where.expiresAt.gt, NOW);
  assert.equal(calls[1][1].data.status, 'REVOKED');
  assert.equal(calls[1][1].data.revocationReason, 'PRIMARY_DEVICE_REPLACED');
  assert.equal(calls[2][1].create.authorizationType, 'PRIMARY');
  assert.equal(calls[2][1].update.revokedAt, null);
  assert.equal(calls[3][1].data.consumedByDeviceId, 'device-2');
});

test('schema y migración son aditivos y nunca almacenan el token crudo', () => {
  const schema = fs.readFileSync('prisma/schema.prisma', 'utf8');
  const migration = fs.readFileSync(
    'prisma/migrations/20260719043000_add_dispatch_worker_activation/migration.sql',
    'utf8'
  );

  assert.match(schema, /model\s+DispatchWorkerActivation\s*\{/);
  assert.match(schema, /tokenHash\s+String\s+@unique/);
  assert.doesNotMatch(schema, /rawToken|tokenRaw|plainToken/);
  assert.match(migration, /CREATE TABLE "DispatchWorkerActivation"/);
  assert.match(migration, /CREATE UNIQUE INDEX "DispatchWorkerActivation_tokenHash_key"/);
  assert.doesNotMatch(migration, /\b(DROP|TRUNCATE|DELETE FROM|ALTER COLUMN)\b/i);
});

test('el adaptador no contiene rutas, WhatsApp ni llamadas HTTP', () => {
  const source = fs.readFileSync(
    'src/modules/dispatch-attendance/infrastructure/prismaPrimaryDeviceActivationRepository.js',
    'utf8'
  );
  assert.doesNotMatch(source, /express|axios|fetch\s*\(|whatsapp|sendMessage/i);
  assert.doesNotMatch(source, /rawToken/);
  assert.match(source, /isolationLevel:\s*'Serializable'/);
  assert.match(source, /error\?\.code\s*===\s*'P2034'/);
});
