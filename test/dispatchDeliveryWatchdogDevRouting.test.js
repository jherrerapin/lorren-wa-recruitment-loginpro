import assert from 'node:assert/strict';
import test from 'node:test';
import { runDispatchDeliveryWatchdog } from '../src/services/dispatchWhatsappAdminAlerts.js';

const NOW = new Date('2026-09-29T12:00:00.000Z');

function deliveryLink({ id, providerMessageId, phone, workerName }) {
  return {
    id,
    assignmentId: `assignment-${id}`,
    phone,
    providerMessageId,
    status: 'SENT',
    createdAt: new Date('2026-09-29T11:30:00.000Z'),
    assignment: {
      id: `assignment-${id}`,
      createdByUsername: 'coordinador-prueba',
      worker: { id: `worker-${id}`, fullName: workerName, phone: phone.slice(-10), isTestProfile: false },
      serviceRequest: { id: `request-${id}`, source: 'MANUAL', serviceDate: new Date('2026-09-30T05:00:00.000Z') }
    }
  };
}

function watchdogPrisma({ audited = true } = {}) {
  const auditedLink = deliveryLink({
    id: 'audited',
    providerMessageId: 'wamid-audited',
    phone: '573001112233',
    workerName: 'Auxiliar Auditado'
  });
  const orphanLink = deliveryLink({
    id: 'orphan',
    providerMessageId: 'wamid-orphan',
    phone: '573004445566',
    workerName: 'Auxiliar Sin Auditoría'
  });
  const links = audited ? [auditedLink, orphanLink] : [orphanLink];
  const messageAudit = {
    id: 'audit-message-1',
    metadata: {
      providerMessageId: 'wamid-audited',
      providerStatus: 'ACCEPTED',
      deliveryWatchdogStatus: null
    }
  };
  const notifications = [];
  const userQueries = [];

  const prismaClient = {
    dispatchWhatsappConfirmation: {
      findMany: async () => links,
      updateMany: async ({ where, data }) => {
        const link = links.find((item) => item.id === where.id);
        if (!link || !['PENDING', 'SENT'].includes(link.status)) return { count: 0 };
        link.status = data.status;
        return { count: 1 };
      }
    },
    appUser: {
      findMany: async (query) => {
        userQueries.push(query);
        return [
          {
            id: 'dev-user-test',
            username: 'dev-prueba',
            role: 'DEV',
            isActive: true,
            dispatchAlertPhone: '3007778899'
          }
        ];
      }
    },
    devAuditEvent: {
      findFirst: async ({ where = {} }) => {
        if (where.entityType === 'DISPATCH_WHATSAPP_MESSAGE') {
          return where.entityId === 'dispatch-wa:outbound:wamid-audited' && audited ? messageAudit : null;
        }
        if (where.entityType === 'DISPATCH_WHATSAPP_NOTIFICATION') {
          return notifications.filter((row) => row.entityId === where.entityId && row.action === where.action).at(-1) || null;
        }
        return null;
      },
      update: async ({ where, data }) => {
        assert.equal(where.id, messageAudit.id);
        messageAudit.metadata = data.metadata;
        return messageAudit;
      },
      create: async ({ data }) => {
        const row = { id: `notification-${notifications.length + 1}`, ...data, createdAt: data.createdAt || NOW };
        notifications.push(row);
        return row;
      }
    }
  };

  return { prismaClient, links, messageAudit, notifications, userQueries };
}

test('watchdog exige evidencia outbound real y envía la alerta de entrega incierta solo a DEV', async () => {
  const state = watchdogPrisma({ audited: true });
  const sent = [];

  const result = await runDispatchDeliveryWatchdog(state.prismaClient, {
    now: NOW,
    sendAdminMessage: async (payload) => {
      sent.push(payload);
      return 'wamid-dev-alert';
    }
  });

  assert.equal(result.checked, 2);
  assert.equal(result.markedUnknown, 1);
  assert.equal(result.skippedWithoutAudit, 1);
  assert.equal(result.alertsSent, 1);
  assert.equal(state.links[0].status, 'DELIVERY_UNKNOWN');
  assert.equal(state.links[1].status, 'SENT');
  assert.equal(state.messageAudit.metadata.deliveryWatchdogStatus, 'DELIVERY_UNKNOWN');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].phone, '573007778899');
  assert.match(sent[0].text, /Auxiliar Auditado/);
  assert.doesNotMatch(sent[0].text, /Auxiliar Sin Auditoría/);
  assert.equal(state.userQueries.length, 1);
  assert.deepEqual(state.userQueries[0].where, {
    role: 'DEV',
    isActive: true,
    dispatchAlertPhone: { not: null }
  });
});

test('watchdog no inventa alerta cuando existe vínculo de confirmación pero falta la auditoría del mensaje', async () => {
  const state = watchdogPrisma({ audited: false });
  const sent = [];

  const result = await runDispatchDeliveryWatchdog(state.prismaClient, {
    now: NOW,
    sendAdminMessage: async (payload) => {
      sent.push(payload);
      return 'wamid-unexpected';
    }
  });

  assert.equal(result.checked, 1);
  assert.equal(result.markedUnknown, 0);
  assert.equal(result.skippedWithoutAudit, 1);
  assert.equal(result.alertsSent, 0);
  assert.equal(state.links[0].status, 'SENT');
  assert.equal(sent.length, 0);
  assert.equal(state.userQueries.length, 0);
});
