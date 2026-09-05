import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isWorkerPortalServiceEnabled,
  isWorkerPortalServiceEnabledAt,
  loadWorkerPortalServiceState,
  setWorkerPortalServiceState
} from '../src/services/workerPortalServiceState.js';

function buildPrisma(seed = []) {
  const events = seed.map((event) => ({ ...event }));
  let sequence = events.length;
  return {
    events,
    devAuditEvent: {
      async findFirst({ where }) {
        return events
          .filter((event) => (
            event.entityType === where.entityType
            && event.entityId === where.entityId
            && event.action === where.action
            && (!where.createdAt?.lte || event.createdAt <= where.createdAt.lte)
          ))
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] || null;
      },
      async create({ data }) {
        sequence += 1;
        const event = {
          id: `state-${sequence}`,
          ...data,
          createdAt: new Date(`2026-09-05T1${sequence}:00:00.000Z`)
        };
        events.push(event);
        return event;
      }
    }
  };
}

function stateEvent(id, enabled, createdAt) {
  return {
    id,
    entityType: 'WORKER_PORTAL_SERVICE_STATE',
    entityId: 'global',
    action: 'WORKER_PORTAL_SERVICE_STATE_CHANGED',
    actorUsername: 'dev',
    metadata: { enabled },
    createdAt: new Date(createdAt)
  };
}

test('el portal queda activo por defecto cuando aún no existe un evento de control', async () => {
  assert.equal(await isWorkerPortalServiceEnabled({}), true);
  assert.deepEqual(await loadWorkerPortalServiceState({}), {
    enabled: true,
    changedAt: null,
    changedBy: null,
    eventId: null
  });
});

test('el estado histórico permite distinguir una marcación capturada durante una suspensión', async () => {
  const prisma = buildPrisma([
    stateEvent('off', false, '2026-09-05T10:00:00.000Z'),
    stateEvent('on', true, '2026-09-05T12:00:00.000Z')
  ]);

  assert.equal(await isWorkerPortalServiceEnabled(prisma), true);
  assert.equal(await isWorkerPortalServiceEnabledAt(prisma, new Date('2026-09-05T09:59:59.000Z')), true);
  assert.equal(await isWorkerPortalServiceEnabledAt(prisma, new Date('2026-09-05T11:00:00.000Z')), false);
  assert.equal(await isWorkerPortalServiceEnabledAt(prisma, new Date('2026-09-05T12:01:00.000Z')), true);
});

test('cambiar el estado deja un evento auditado y no duplica el mismo estado', async () => {
  const prisma = buildPrisma();
  const disabled = await setWorkerPortalServiceState(prisma, {
    enabled: false,
    actorUserId: 'dev-user',
    actorUsername: 'dev',
    actorRole: 'dev',
    ipAddress: '127.0.0.1',
    userAgent: 'test'
  });

  assert.equal(disabled.enabled, false);
  assert.equal(disabled.changed, true);
  assert.equal(prisma.events.length, 1);
  assert.deepEqual(prisma.events[0].fromValue, { enabled: true });
  assert.deepEqual(prisma.events[0].toValue, { enabled: false });
  assert.equal(prisma.events[0].actorUsername, 'dev');

  const unchanged = await setWorkerPortalServiceState(prisma, { enabled: false });
  assert.equal(unchanged.changed, false);
  assert.equal(prisma.events.length, 1);
});
