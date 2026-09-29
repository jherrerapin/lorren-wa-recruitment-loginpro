import assert from 'node:assert/strict';
import test from 'node:test';
import { runDispatchDeliveryWatchdog } from '../src/services/dispatchWhatsappAdminAlerts.js';

const NOW = new Date('2026-09-29T12:00:00.000Z');

function deliveryLink({ id, providerMessageId, phone, workerName, status = 'FAILED' }) {
  return {
    id,
    assignmentId: `assignment-${id}`,
    phone,
    providerMessageId,
    status,
    createdAt: new Date('2026-09-29T11:30:00.000Z'),
    assignment: {
      id: `assignment-${id}`,
      createdByUsername: 'coordinador-prueba',
      worker: { id: `worker-${id}`, fullName: workerName, phone: phone.slice(-10), isTestProfile: false },
      serviceRequest: { id: `request-${id}`, source: 'MANUAL', serviceDate: new Date('2026-09-30T05:00:00.000Z') }
    }
  };
}

function watchdogPrisma({ includeFailed = true, includeSent = true, includeOrphan = true } = {}) {
  const failedLink = deliveryLink({
    id: 'failed',
    providerMessageId: 'wamid-failed',
    phone: '573001112233',
    workerName: 'Auxiliar Fallo Confirmado'
  });
  const sentLink = deliveryLink({
    id: 'sent',
    providerMessageId: 'wamid-sent',
    phone: '573004445566',
    workerName: 'Auxiliar Solo Enviado',
    status: 'SENT'
  });
  const orphanLink = deliveryLink({
    id: 'orphan',
    providerMessageId: 'wamid-orphan',
    phone: '573007778899',
    workerName: 'Auxiliar Sin Auditoría'
  });
  const links = [
    ...(includeFailed ? [failedLink] : []),
    ...(includeSent ? [sentLink] : []),
    ...(includeOrphan ? [orphanLink] : [])
  ];
  const messageAudits = new Map([
    ['dispatch-wa:outbound:wamid-failed', {
      id: 'audit-failed',
      metadata: {
        providerMessageId: 'wamid-failed',
        providerStatus: 'FAILED',
        providerDiagnostic: 'code=131026 title=Message undeliverable'
      }
    }],
    ['dispatch-wa:outbound:wamid-sent', {
      id: 'audit-sent',
      metadata: {
        providerMessageId: 'wamid-sent',
        providerStatus: 'SENT',
        providerDiagnostic: null
      }
    }]
  ]);
  const notifications = [];
  const userQueries = [];

  const prismaClient = {
    dispatchWhatsappConfirmation: {
      findMany: async ({ where = {} } = {}) => links.filter((link) => {
        if (where.status === 'FAILED' && link.status !== 'FAILED') return false;
        return true;
      })
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
            dispatchAlertPhone: '3001112233'
          }
        ];
      }
    },
    devAuditEvent: {
      findFirst: async ({ where = {} }) => {
        if (where.entityType === 'DISPATCH_WHATSAPP_MESSAGE') {
          return messageAudits.get(where.entityId) || null;
        }
        if (where.entityType === 'DISPATCH_WHATSAPP_NOTIFICATION') {
          return notifications.filter((row) => row.entityId === where.entityId && row.action === where.action).at(-1) || null;
        }
        return null;
      },
      create: async ({ data }) => {
        const row = { id: `notification-${notifications.length + 1}`, ...data, createdAt: data.createdAt || NOW };
        notifications.push(row);
        return row;
      }
    }
  };

  return { prismaClient, links, notifications, userQueries };
}

test('watchdog alerta a DEV solo por FAILED confirmado por Meta y exige auditoría outbound real', async () => {
  const state = watchdogPrisma();
  const sent = [];

  const result = await runDispatchDeliveryWatchdog(state.prismaClient, {
    now: NOW,
    sendAdminMessage: async (payload) => {
      sent.push(payload);
      return 'wamid-dev-alert';
    }
  });

  assert.equal(result.checked, 2);
  assert.equal(result.confirmedFailures, 1);
  assert.equal(result.skippedWithoutAudit, 1);
  assert.equal(result.alertsSent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].phone, '573001112233');
  assert.match(sent[0].text, /Fallo de entrega confirmado por Meta/i);
  assert.match(sent[0].text, /Auxiliar Fallo Confirmado/);
  assert.doesNotMatch(sent[0].text, /Auxiliar Solo Enviado/);
  assert.doesNotMatch(sent[0].text, /Auxiliar Sin Auditoría/);
  assert.equal(state.userQueries.length, 1);
  assert.deepEqual(state.userQueries[0].where, {
    role: 'DEV',
    isActive: true,
    dispatchAlertPhone: { not: null }
  });
});

test('watchdog no convierte SENT sin DELIVERED en fallo ni genera reenvío o alerta por silencio', async () => {
  const state = watchdogPrisma({ includeFailed: false, includeSent: true, includeOrphan: false });
  const sent = [];

  const result = await runDispatchDeliveryWatchdog(state.prismaClient, {
    now: NOW,
    sendAdminMessage: async (payload) => {
      sent.push(payload);
      return 'wamid-unexpected';
    }
  });

  assert.equal(result.checked, 0);
  assert.equal(result.confirmedFailures, 0);
  assert.equal(result.alertsSent, 0);
  assert.equal(state.links[0].status, 'SENT');
  assert.equal(sent.length, 0);
  assert.equal(state.userQueries.length, 0);
});
