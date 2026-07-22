import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPrismaWorkerPortalSessionRepository } from '../src/modules/dispatch-attendance/infrastructure/prismaWorkerPortalSessionRepository.js';

const NOW = new Date('2026-07-22T17:30:00.000Z');
const ACTIVATION_EXPIRES = new Date('2026-07-22T18:00:00.000Z');
const SESSION_EXPIRES = new Date('2026-07-29T17:30:00.000Z');

function rootPrisma({ transaction, findSession, touchSession } = {}) {
  return {
    dispatchWorker: {},
    dispatchWorkerActivation: {},
    dispatchWorkerDevice: {},
    dispatchWorkerPortalSession: {
      findFirst: findSession || (async () => null),
      updateMany: touchSession || (async () => ({ count: 1 }))
    },
    $transaction: transaction || (async (operation) => operation({}))
  };
}

function validActivation(overrides = {}) {
  return {
    id: 'activation-1',
    workerId: 'worker-1',
    purpose: 'PRIMARY_DEVICE_ACTIVATION',
    status: 'PENDING',
    expiresAt: ACTIVATION_EXPIRES,
    consumedAt: null,
    revokedAt: null,
    ...overrides
  };
}

function activationInput(overrides = {}) {
  return {
    purpose: 'PRIMARY_DEVICE_ACTIVATION',
    activationTokenHash: 'a'.repeat(64),
    installationIdHash: 'b'.repeat(64),
    sessionTokenHash: 'c'.repeat(64),
    sessionExpiresAt: SESSION_EXPIRES,
    now: NOW,
    userAgent: 'Mobile Browser',
    platform: 'Android',
    ipAddress: '203.0.113.10',
    ...overrides
  };
}

test('requiere todos los modelos Prisma de la sesión del portal', () => {
  assert.throws(
    () => createPrismaWorkerPortalSessionRepository({}),
    /worker_portal_session_prisma_dispatchWorker_required/
  );

  const incomplete = rootPrisma();
  delete incomplete.dispatchWorkerPortalSession;
  assert.throws(
    () => createPrismaWorkerPortalSessionRepository(incomplete),
    /worker_portal_session_prisma_dispatchWorkerPortalSession_required/
  );
});

test('una activación vencida no reclama token ni escribe dispositivo o sesión', async () => {
  let writes = 0;
  const tx = {
    dispatchWorkerActivation: {
      findUnique: async () => validActivation({ expiresAt: new Date('2026-07-22T17:29:59.000Z') })
    },
    dispatchWorker: { findFirst: async () => ({ id: 'worker-1' }) },
    dispatchWorkerDevice: {
      updateMany: async () => { writes += 1; },
      upsert: async () => { writes += 1; }
    },
    dispatchWorkerPortalSession: {
      updateMany: async () => { writes += 1; },
      create: async () => { writes += 1; }
    }
  };
  const repository = createPrismaWorkerPortalSessionRepository(rootPrisma({
    transaction: async (operation, options) => {
      assert.equal(options.isolationLevel, 'Serializable');
      return operation(tx);
    }
  }));

  const result = await repository.claimActivationAuthorizeDeviceAndCreateSession(activationInput());
  assert.equal(result, null);
  assert.equal(writes, 0);
});

test('un reclamo condicional perdido evita doble dispositivo y doble sesión', async () => {
  let writesAfterClaim = 0;
  const tx = {
    dispatchWorkerActivation: {
      findUnique: async () => validActivation(),
      updateMany: async () => ({ count: 0 })
    },
    dispatchWorker: { findFirst: async () => ({ id: 'worker-1' }) },
    dispatchWorkerDevice: {
      updateMany: async () => { writesAfterClaim += 1; },
      upsert: async () => { writesAfterClaim += 1; }
    },
    dispatchWorkerPortalSession: {
      updateMany: async () => { writesAfterClaim += 1; },
      create: async () => { writesAfterClaim += 1; }
    }
  };
  const repository = createPrismaWorkerPortalSessionRepository(rootPrisma({
    transaction: async (operation) => operation(tx)
  }));

  const result = await repository.claimActivationAuthorizeDeviceAndCreateSession(activationInput());
  assert.equal(result, null);
  assert.equal(writesAfterClaim, 0);
});

test('la activación exitosa consume, revoca sesiones y principal anterior, y crea una nueva sesión', async () => {
  const calls = [];
  const tx = {
    dispatchWorkerActivation: {
      findUnique: async () => validActivation(),
      updateMany: async (input) => {
        calls.push(['claim-activation', input]);
        return { count: 1 };
      },
      update: async (input) => {
        calls.push(['link-activation', input]);
        return { id: 'activation-1' };
      }
    },
    dispatchWorker: {
      findFirst: async (input) => {
        calls.push(['worker', input]);
        return { id: 'worker-1' };
      }
    },
    dispatchWorkerPortalSession: {
      updateMany: async (input) => {
        calls.push(['revoke-sessions', input]);
        return { count: 1 };
      },
      create: async (input) => {
        calls.push(['create-session', input]);
        return {
          id: 'session-2',
          workerId: 'worker-1',
          workerDeviceId: 'device-2',
          issuedAt: NOW,
          expiresAt: SESSION_EXPIRES
        };
      }
    },
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
  const repository = createPrismaWorkerPortalSessionRepository(rootPrisma({
    transaction: async (operation, options) => {
      assert.equal(options.isolationLevel, 'Serializable');
      return operation(tx);
    }
  }));

  const result = await repository.claimActivationAuthorizeDeviceAndCreateSession(activationInput());

  assert.deepEqual(result, {
    workerId: 'worker-1',
    deviceId: 'device-2',
    sessionId: 'session-2',
    activatedAt: NOW,
    expiresAt: SESSION_EXPIRES
  });
  assert.deepEqual(calls.map(([name]) => name), [
    'worker',
    'claim-activation',
    'revoke-sessions',
    'revoke-device',
    'upsert-device',
    'create-session',
    'link-activation'
  ]);
  assert.equal(calls[2][1].data.status, 'REVOKED');
  assert.equal(calls[2][1].data.revocationReason, 'REPLACED_BY_NEW_PORTAL_SESSION');
  assert.equal(calls[4][1].create.authorizationType, 'PRIMARY');
  assert.equal(calls[5][1].data.sessionTokenHash, 'c'.repeat(64));
  assert.equal(calls[5][1].data.activationId, 'activation-1');
  assert.equal(Object.hasOwn(calls[5][1].data, 'rawSessionToken'), false);
  assert.equal(calls[6][1].data.consumedByDeviceId, 'device-2');
});

test('resolveActiveSession exige sesión, auxiliar y dispositivo activos', async () => {
  let query;
  let touch;
  const repository = createPrismaWorkerPortalSessionRepository(rootPrisma({
    findSession: async (input) => {
      query = input;
      return {
        id: 'session-1',
        workerId: 'worker-1',
        workerDeviceId: 'device-1',
        expiresAt: SESSION_EXPIRES
      };
    },
    touchSession: async (input) => {
      touch = input;
      return { count: 1 };
    }
  }));

  const result = await repository.resolveActiveSession({
    sessionTokenHash: 'd'.repeat(64),
    now: NOW
  });

  assert.deepEqual(result, {
    workerId: 'worker-1',
    deviceId: 'device-1',
    sessionId: 'session-1',
    expiresAt: SESSION_EXPIRES
  });
  assert.equal(query.where.status, 'ACTIVE');
  assert.equal(query.where.revokedAt, null);
  assert.deepEqual(query.where.worker.is.operationalStatus.in, ['ACTIVE', 'CONTRATADO']);
  assert.equal(query.where.workerDevice.is.authorizationType, 'PRIMARY');
  assert.equal(query.where.workerDevice.is.status, 'ACTIVE');
  assert.equal(touch.data.lastSeenAt, NOW);
});

test('resolveActiveSession devuelve null cuando la sesión desaparece o pierde la carrera', async () => {
  const absentRepository = createPrismaWorkerPortalSessionRepository(rootPrisma({
    findSession: async () => null
  }));
  assert.equal(await absentRepository.resolveActiveSession({ sessionTokenHash: 'e'.repeat(64), now: NOW }), null);

  const racedRepository = createPrismaWorkerPortalSessionRepository(rootPrisma({
    findSession: async () => ({
      id: 'session-1', workerId: 'worker-1', workerDeviceId: 'device-1', expiresAt: SESSION_EXPIRES
    }),
    touchSession: async () => ({ count: 0 })
  }));
  assert.equal(await racedRepository.resolveActiveSession({ sessionTokenHash: 'f'.repeat(64), now: NOW }), null);
});

test('rechaza límites de reintento inválidos', () => {
  assert.throws(
    () => createPrismaWorkerPortalSessionRepository(rootPrisma(), { maxTransactionRetries: 6 }),
    /worker_portal_session_transaction_retries_invalid/
  );
});

test('schema y migración son expansivos y no almacenan tokens crudos', () => {
  const schema = fs.readFileSync('prisma/schema.prisma', 'utf8');
  const migration = fs.readFileSync(
    'prisma/migrations/20260722173000_add_dispatch_worker_portal_session/migration.sql',
    'utf8'
  );

  assert.match(schema, /model\s+DispatchWorkerPortalSession\s*\{/);
  assert.match(schema, /sessionTokenHash\s+String\s+@unique/);
  assert.match(schema, /activationId\s+String\s+@unique/);
  assert.doesNotMatch(schema, /rawSessionToken|plainSessionToken|sessionTokenRaw/);
  assert.match(migration, /CREATE TABLE "DispatchWorkerPortalSession"/);
  assert.match(migration, /CREATE UNIQUE INDEX "DispatchWorkerPortalSession_sessionTokenHash_key"/);
  assert.doesNotMatch(migration, /\b(DROP|TRUNCATE|DELETE FROM|ALTER COLUMN)\b/i);
});

test('el adaptador no expone rutas, cookies ni integraciones externas', () => {
  const source = fs.readFileSync(
    'src/modules/dispatch-attendance/infrastructure/prismaWorkerPortalSessionRepository.js',
    'utf8'
  );
  assert.doesNotMatch(source, /express|res\.cookie|set-cookie|axios|fetch\s*\(|whatsapp|sendMessage/i);
  assert.doesNotMatch(source, /rawSessionToken|rawActivationToken|installationId\b/);
  assert.match(source, /runSerializableActivationTransaction/);
});
