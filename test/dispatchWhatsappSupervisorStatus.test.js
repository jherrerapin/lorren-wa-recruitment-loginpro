import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadDispatchWhatsappConversationInbox } from '../src/routes/dispatchWhatsappNotifications.js';

const NOW = new Date('2026-09-21T19:00:00.000Z');

function auditRow({ phone, providerMessageId, providerStatus, at }) {
  return {
    id: `audit-${providerMessageId}`,
    entityType: 'DISPATCH_WHATSAPP_MESSAGE',
    entityId: `dispatch-wa:outbound:${providerMessageId}`,
    entityLabel: phone,
    action: 'DISPATCH_WHATSAPP_OUTBOUND',
    actorSource: 'ASSIGNMENT_CONFIRMATION',
    metadata: {
      scope: 'operational',
      direction: 'OUTBOUND',
      phone,
      body: 'Mensaje de asignación de prueba',
      messageType: 'TEMPLATE',
      messageId: '',
      providerMessageId,
      providerStatus,
      providerStatusAt: at,
      providerDiagnostic: null,
      deliveryWatchdogStatus: null,
      source: 'ASSIGNMENT_CONFIRMATION',
      occurredAt: at
    },
    createdAt: new Date(at)
  };
}

function confirmation({ id, phone, providerMessageId, status, owner, workerId, workerName, at }) {
  return {
    id,
    assignmentId: `assignment-${id}`,
    serviceRequestId: `request-${id}`,
    phone,
    providerMessageId,
    status,
    alertOwnerUsername: owner,
    confirmationMessageId: null,
    confirmationReceivedAt: null,
    createdAt: new Date(at),
    updatedAt: new Date(at),
    assignment: {
      id: `assignment-${id}`,
      workerId,
      worker: { id: workerId, fullName: workerName, phone: phone.slice(-10) },
      serviceRequest: { id: `request-${id}`, source: 'MANUAL' }
    }
  };
}

function prismaForSupervisor({ links, audits }) {
  return {
    dispatchWhatsappConfirmation: {
      groupBy: async ({ where }) => {
        const selected = links.filter((link) => link.alertOwnerUsername === where.alertOwnerUsername);
        const latestByPhone = new Map();
        for (const link of selected) {
          const current = latestByPhone.get(link.phone);
          if (!current || link.createdAt > current.createdAt) latestByPhone.set(link.phone, link);
        }
        return [...latestByPhone.values()].map((link) => ({
          phone: link.phone,
          _max: { createdAt: link.createdAt, confirmationReceivedAt: link.confirmationReceivedAt }
        }));
      },
      findMany: async ({ where = {} } = {}) => {
        if (where.alertOwnerUsername) {
          return links.filter((link) => link.alertOwnerUsername === where.alertOwnerUsername);
        }
        if (typeof where.phone === 'string') {
          return links.filter((link) => link.phone === where.phone);
        }
        return links;
      }
    },
    dispatchWhatsappContactWindow: {
      findUnique: async () => null,
      upsert: async () => ({})
    },
    devAuditEvent: {
      findMany: async ({ where = {} } = {}) => {
        const phones = Array.isArray(where.entityLabel?.in) ? where.entityLabel.in : [];
        return audits.filter((row) => !phones.length || phones.includes(row.entityLabel));
      }
    },
    dispatchWorker: { findMany: async () => [] }
  };
}

test('supervisor ve solo sus auxiliares y el estado certificado del mensaje de asignación', async () => {
  const own = confirmation({
    id: 'own', phone: '573001010101', providerMessageId: 'wamid-own', status: 'SENT',
    owner: 'supervisor-prueba', workerId: 'worker-own', workerName: 'Auxiliar Propio', at: '2026-09-21T18:55:00.000Z'
  });
  const other = confirmation({
    id: 'other', phone: '573002020202', providerMessageId: 'wamid-other', status: 'DELIVERED',
    owner: 'otro-supervisor', workerId: 'worker-other', workerName: 'Auxiliar Ajeno', at: '2026-09-21T18:56:00.000Z'
  });
  const prismaClient = prismaForSupervisor({
    links: [own, other],
    audits: [
      auditRow({ phone: own.phone, providerMessageId: own.providerMessageId, providerStatus: 'READ', at: '2026-09-21T18:58:00.000Z' }),
      auditRow({ phone: other.phone, providerMessageId: other.providerMessageId, providerStatus: 'DELIVERED', at: '2026-09-21T18:59:00.000Z' })
    ]
  });

  const inbox = await loadDispatchWhatsappConversationInbox(prismaClient, {
    ownerUsername: 'supervisor-prueba',
    now: NOW
  });

  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].workerName, 'Auxiliar Propio');
  assert.equal(inbox.items[0].assignmentMessageState, 'READ');
  assert.equal(inbox.items[0].assignmentMessageProviderId, 'wamid-own');
  assert.equal(inbox.summary.read, 1);
  assert.equal(inbox.items.some((item) => item.workerName === 'Auxiliar Ajeno'), false);
});

test('estado histórico reconstruido no fabrica Enviado, Entregado ni Leído para supervisor', async () => {
  const historical = confirmation({
    id: 'historical', phone: '573003030303', providerMessageId: 'wamid-historical', status: 'SENT',
    owner: 'supervisor-prueba', workerId: 'worker-historical', workerName: 'Auxiliar Histórico', at: '2026-09-21T18:40:00.000Z'
  });
  const prismaClient = prismaForSupervisor({ links: [historical], audits: [] });

  const inbox = await loadDispatchWhatsappConversationInbox(prismaClient, {
    ownerUsername: 'supervisor-prueba',
    now: NOW
  });

  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].workerName, 'Auxiliar Histórico');
  assert.equal(inbox.items[0].assignmentMessageState, null);
  assert.equal(inbox.summary.sent, 0);
  assert.equal(inbox.summary.delivered, 0);
  assert.equal(inbox.summary.read, 0);
});

test('vista de supervisor usa estados claros en español y reserva conversaciones para DEV', () => {
  const view = fs.readFileSync(new URL('../src/views/operacionesWhatsappEstado.ejs', import.meta.url), 'utf8');
  const route = fs.readFileSync(new URL('../src/routes/dispatchWhatsappNotifications.js', import.meta.url), 'utf8');

  assert.match(view, /Estado de mensajes de asignación/);
  assert.match(view, /Auxiliares a quienes has enviado la confirmación de asignación/);
  assert.match(view, /Preparando envío/);
  assert.match(view, /Procesando envío/);
  assert.match(view, /Enviado/);
  assert.match(view, /Entregado/);
  assert.match(view, /Leído/);
  assert.match(view, /Confirmado por el auxiliar/);
  assert.match(view, /No enviado/);
  assert.match(view, /No entregado/);
  assert.match(view, /Sin confirmación de entrega/);
  assert.match(view, /Estado no disponible/);
  assert.match(view, /if \(!isDevView && hasConversationInbox\)/);
  assert.match(view, /if \(isDevView && hasConversationInbox\)/);
  assert.match(view, /setInterval\(refreshSupervisorAssignments,5000\)/);
  assert.match(route, /alertOwnerUsername: normalizedOwner/);
  assert.match(route, /ownerUsername: isDevRequest \? null : viewerUsername/);
  assert.match(route, /message\?\.reconstructed/);
  assert.match(route, /isDevRequest \? loadSelectedWorkerConversation/);
});
