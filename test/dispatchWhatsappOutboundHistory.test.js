import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  loadDispatchWhatsappOutboundHistoryByDate,
  loadDispatchWhatsappPhoneConversation
} from '../src/services/dispatchWhatsappMonitor.js';
import { loadDispatchWhatsappConversationInbox } from '../src/routes/dispatchWhatsappNotifications.js';
import { runDispatchDeliveryWatchdog } from '../src/services/dispatchWhatsappAdminAlerts.js';

const NOW = new Date('2026-09-21T12:00:00.000Z');

function auditRow({ id, phone, status, at, body, source = 'ASSIGNMENT_CONFIRMATION', diagnostic = null, watchdog = null, direction = 'OUTBOUND' }) {
  return {
    id,
    entityType: 'DISPATCH_WHATSAPP_MESSAGE',
    entityId: `dispatch-wa:${direction.toLowerCase()}:${id}`,
    entityLabel: phone,
    action: direction === 'INBOUND' ? 'DISPATCH_WHATSAPP_INBOUND' : 'DISPATCH_WHATSAPP_OUTBOUND',
    actorSource: source,
    metadata: {
      scope: 'operational',
      direction,
      phone,
      body,
      messageType: direction === 'INBOUND' ? 'TEXT' : 'TEMPLATE',
      messageId: direction === 'INBOUND' ? id : '',
      providerMessageId: direction === 'OUTBOUND' ? id : '',
      providerStatus: direction === 'OUTBOUND' ? status : null,
      providerStatusAt: direction === 'OUTBOUND' ? at : null,
      providerDiagnostic: diagnostic,
      deliveryWatchdogStatus: watchdog,
      source,
      occurredAt: at
    },
    createdAt: new Date(at)
  };
}

function historyPrisma({ rows = [], confirmations = [], globallyAuditedProviderIds = [] } = {}) {
  const workerQueries = [];
  return {
    workerQueries,
    devAuditEvent: {
      count: async (query) => {
        assert.equal(query.where.entityType, 'DISPATCH_WHATSAPP_MESSAGE');
        assert.equal(query.where.action, 'DISPATCH_WHATSAPP_OUTBOUND');
        return rows.length;
      },
      findMany: async (query) => {
        if (query.where?.entityId?.in) {
          return globallyAuditedProviderIds.map((id) => ({ entityId: `dispatch-wa:outbound:${id}` }));
        }
        assert.equal(query.where.entityType, 'DISPATCH_WHATSAPP_MESSAGE');
        assert.equal(query.where.action, 'DISPATCH_WHATSAPP_OUTBOUND');
        assert.deepEqual(query.orderBy, { createdAt: 'desc' });
        return rows.slice(0, query.take || rows.length);
      }
    },
    dispatchWhatsappConfirmation: {
      findMany: async () => confirmations
    },
    dispatchWorker: {
      findMany: async (query) => {
        workerQueries.push(query);
        assert.ok(Array.isArray(query.where?.OR));
        assert.ok(query.where.OR.length > 0);
        assert.ok(query.where.OR.every((item) => typeof item.phone?.endsWith === 'string'));
        assert.deepEqual(query.select, { id: true, fullName: true, phone: true });
        return [
          { id: 'worker-one', fullName: 'Auxiliar Uno', phone: '3001112233' },
          { id: 'worker-two', fullName: 'Auxiliar Dos', phone: '3002223344' }
        ];
      }
    }
  };
}

function normalizedPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 10 ? `57${digits}` : digits;
}

function inboxPrisma({ rows = [], confirmations = [], workers = [], windows = [] } = {}) {
  const auditGroups = new Map();
  for (const row of rows) {
    const phone = normalizedPhone(row.entityLabel);
    const at = new Date(row.createdAt);
    const previous = auditGroups.get(phone);
    if (!previous || at > previous) auditGroups.set(phone, at);
  }
  const confirmationGroups = new Map();
  for (const row of confirmations) {
    const phone = normalizedPhone(row.phone);
    const previous = confirmationGroups.get(phone) || { createdAt: null, confirmationReceivedAt: null };
    const createdAt = row.createdAt ? new Date(row.createdAt) : null;
    const receivedAt = row.confirmationReceivedAt ? new Date(row.confirmationReceivedAt) : null;
    if (createdAt && (!previous.createdAt || createdAt > previous.createdAt)) previous.createdAt = createdAt;
    if (receivedAt && (!previous.confirmationReceivedAt || receivedAt > previous.confirmationReceivedAt)) previous.confirmationReceivedAt = receivedAt;
    confirmationGroups.set(phone, previous);
  }
  return {
    devAuditEvent: {
      groupBy: async () => [...auditGroups.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([entityLabel, createdAt]) => ({ entityLabel, _max: { createdAt } })),
      findMany: async ({ where = {} } = {}) => {
        const phones = Array.isArray(where.entityLabel?.in) ? where.entityLabel.in.map(normalizedPhone) : null;
        return rows
          .filter((row) => !phones || phones.includes(normalizedPhone(row.entityLabel)))
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      }
    },
    dispatchWhatsappContactWindow: {
      findMany: async () => windows,
      findUnique: async ({ where }) => windows.find((row) => normalizedPhone(row.phone) === normalizedPhone(where.scope_phone.phone)) || null,
      upsert: async () => ({})
    },
    dispatchWhatsappConfirmation: {
      groupBy: async () => [...confirmationGroups.entries()]
        .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0))
        .map(([phone, latest]) => ({
          phone,
          _max: { createdAt: latest.createdAt, confirmationReceivedAt: latest.confirmationReceivedAt }
        })),
      findMany: async ({ where = {} } = {}) => {
        if (typeof where.phone === 'string') {
          return confirmations.filter((row) => normalizedPhone(row.phone) === normalizedPhone(where.phone));
        }
        return confirmations;
      }
    },
    dispatchWorker: {
      findMany: async () => workers
    }
  };
}

test('historial consulta el día exacto de Bogotá, muestra teléfono completo y conserva estados Meta', async () => {
  const rows = [
    auditRow({ id: 'wamid-test-failed', phone: '573003334455', status: 'FAILED', at: '2026-09-21T00:20:00.000Z', body: 'Asignación ficticia C', diagnostic: 'code=131000 error de prueba saneado' }),
    auditRow({ id: 'wamid-test-delivered', phone: '573002223344', status: 'DELIVERED', at: '2026-09-21T00:10:00.000Z', body: 'Asignación ficticia B' }),
    auditRow({ id: 'wamid-test-accepted', phone: '573001112233', status: 'ACCEPTED', at: '2026-09-21T00:05:00.000Z', body: 'Asignación ficticia A' })
  ];
  const prismaClient = historyPrisma({ rows });
  const originalFindMany = prismaClient.devAuditEvent.findMany;
  prismaClient.devAuditEvent.findMany = async (query) => {
    if (!query.where?.entityId?.in) {
      assert.equal(query.where.createdAt.gte.toISOString(), '2026-09-20T05:00:00.000Z');
      assert.equal(query.where.createdAt.lt.toISOString(), '2026-09-21T05:00:00.000Z');
    }
    return originalFindMany(query);
  };

  const history = await loadDispatchWhatsappOutboundHistoryByDate({ prismaClient, dateKey: '2026-09-20', now: NOW });

  assert.equal(history.dateKey, '2026-09-20');
  assert.equal(history.range.start, '2026-09-20T05:00:00.000Z');
  assert.equal(history.range.end, '2026-09-21T05:00:00.000Z');
  assert.equal(history.summary.total, 3);
  assert.equal(history.summary.delivered, 1);
  assert.equal(history.summary.failed, 1);
  assert.equal(history.items[0].providerStatus, 'FAILED');
  assert.equal(history.items[0].providerDiagnostic, 'code=131000 error de prueba saneado');
  assert.equal(history.items[0].phoneDisplay, '+57 300 333 4455');
  assert.equal(history.items[1].workerName, 'Auxiliar Dos');
  assert.equal(history.items[1].workerId, 'worker-two');
  assert.equal(history.items[2].workerName, 'Auxiliar Uno');
  assert.equal(prismaClient.workerQueries.length, 1);
});

test('fecha inválida usa el día actual de Bogotá sin ampliar el rango', async () => {
  const prismaClient = {
    devAuditEvent: {
      count: async () => 0,
      findMany: async (query) => {
        assert.equal(query.where.createdAt.gte.toISOString(), '2026-09-21T05:00:00.000Z');
        assert.equal(query.where.createdAt.lt.toISOString(), '2026-09-22T05:00:00.000Z');
        return [];
      }
    },
    dispatchWhatsappConfirmation: { findMany: async () => [] }
  };
  const history = await loadDispatchWhatsappOutboundHistoryByDate({ prismaClient, dateKey: '2026-99-99', now: NOW });
  assert.equal(history.dateKey, '2026-09-21');
  assert.equal(history.summary.total, 0);
  assert.deepEqual(history.items, []);
});

test('evidencia histórica no reconstruye el texto desde una asignación mutable', async () => {
  const confirmation = {
    id: 'confirmation-historical-1',
    phone: '573004445566',
    providerMessageId: 'wamid-historical-1',
    status: 'SENT',
    createdAt: new Date('2026-09-21T00:08:00.000Z'),
    assignment: {
      id: 'assignment-historical-1',
      workerId: 'worker-historical-1',
      worker: { id: 'worker-historical-1', fullName: 'Auxiliar Histórico', phone: '3004445566' },
      serviceRequest: {
        id: 'request-historical-1',
        source: 'MANUAL',
        operationPointName: 'OPERACIÓN MUTADA DESPUÉS DEL ENVÍO',
        serviceDate: new Date('2026-09-21T00:00:00.000Z'),
        startTime: '23:59',
        address: 'DIRECCIÓN MUTADA'
      }
    }
  };
  const prismaClient = historyPrisma({ confirmations: [confirmation] });

  const history = await loadDispatchWhatsappOutboundHistoryByDate({ prismaClient, dateKey: '2026-09-20', now: NOW });

  assert.equal(history.summary.total, 1);
  assert.equal(history.items[0].providerMessageId, 'wamid-historical-1');
  assert.equal(history.items[0].providerStatus, 'SENT');
  assert.equal(history.items[0].reconstructed, true);
  assert.match(history.items[0].body, /contenido original no quedó almacenado/i);
  assert.doesNotMatch(history.items[0].body, /OPERACIÓN MUTADA|DIRECCIÓN MUTADA|23:59/);
});

test('dedupe histórica busca el wamid globalmente y no solo dentro del día seleccionado', async () => {
  const confirmation = {
    id: 'confirmation-cross-day',
    phone: '573004445566',
    providerMessageId: 'wamid-already-audited-elsewhere',
    status: 'SENT',
    createdAt: new Date('2026-09-21T00:08:00.000Z'),
    assignment: {
      id: 'assignment-cross-day',
      worker: { id: 'worker-cross-day', fullName: 'Auxiliar Cruce', phone: '3004445566' },
      serviceRequest: { source: 'MANUAL' }
    }
  };
  const prismaClient = historyPrisma({
    confirmations: [confirmation],
    globallyAuditedProviderIds: ['wamid-already-audited-elsewhere']
  });
  const history = await loadDispatchWhatsappOutboundHistoryByDate({ prismaClient, dateKey: '2026-09-20', now: NOW });
  assert.equal(history.summary.total, 0);
  assert.deepEqual(history.items, []);
});

test('historial pagina el día sin truncarlo silenciosamente', async () => {
  const rows = Array.from({ length: 120 }, (_, index) => auditRow({
    id: `wamid-page-${String(index).padStart(3, '0')}`,
    phone: '573001112233',
    status: 'DELIVERED',
    at: new Date(Date.UTC(2026, 8, 21, 0, 59, 59) - index * 1000).toISOString(),
    body: `Mensaje ${index}`
  }));
  const prismaClient = historyPrisma({ rows });
  const history = await loadDispatchWhatsappOutboundHistoryByDate({
    prismaClient,
    dateKey: '2026-09-20',
    now: NOW,
    page: 2,
    pageSize: 50
  });
  assert.equal(history.pagination.page, 2);
  assert.equal(history.pagination.total, 120);
  assert.equal(history.pagination.totalPages, 3);
  assert.equal(history.pagination.hasPrevious, true);
  assert.equal(history.pagination.hasNext, true);
  assert.equal(history.items.length, 50);
});

test('conversación por auxiliar reutiliza auditoría de Despacho y conserva direcciones', async () => {
  const persisted = [
    {
      id: 'audit-inbound', entityId: 'dispatch-wa:inbound:wamid-in', entityLabel: '573001112233', action: 'DISPATCH_WHATSAPP_INBOUND',
      metadata: { direction: 'INBOUND', phone: '573001112233', body: 'CONFIRMADO', messageType: 'INTERACTIVE', messageId: 'wamid-in', source: 'WEBHOOK_INBOUND', occurredAt: '2026-09-21T00:10:00.000Z' },
      createdAt: new Date('2026-09-21T00:10:00.000Z')
    },
    auditRow({ id: 'wamid-out', phone: '573001112233', status: 'DELIVERED', at: '2026-09-21T00:05:00.000Z', body: 'Mensaje de prueba' })
  ];
  const prismaClient = {
    dispatchWhatsappContactWindow: { findUnique: async () => ({ phone: '573001112233', lastInboundAt: new Date('2026-09-21T00:10:00.000Z') }) },
    devAuditEvent: { findMany: async () => persisted },
    dispatchWhatsappConfirmation: { findMany: async () => [] }
  };
  const conversation = await loadDispatchWhatsappPhoneConversation({ prismaClient, phone: '3001112233', now: NOW });
  assert.equal(conversation.phoneDisplay, '+57 300 111 2233');
  assert.equal(conversation.messageCount, 2);
  assert.equal(conversation.messageHistory[0].direction, 'OUTBOUND');
  assert.equal(conversation.messageHistory[0].deliveryState, 'DELIVERED');
  assert.equal(conversation.messageHistory[1].direction, 'INBOUND');
  assert.match(conversation.messageHistory[1].body, /CONFIRMADO/);
});

test('bandeja prioriza la asignación ligada al wamid para resolver el auxiliar', async () => {
  const sentAt = '2026-09-21T11:40:00.000Z';
  const rows = [auditRow({
    id: 'wamid-linked-worker',
    phone: '573006667788',
    status: 'SENT',
    at: sentAt,
    body: 'Asignación de prueba'
  })];
  const confirmations = [{
    id: 'link-worker-1',
    phone: '573006667788',
    providerMessageId: 'wamid-linked-worker',
    status: 'SENT',
    createdAt: new Date(sentAt),
    updatedAt: new Date(sentAt),
    confirmationReceivedAt: null,
    assignment: {
      id: 'assignment-linked-1',
      workerId: 'worker-linked-1',
      worker: { id: 'worker-linked-1', fullName: 'Auxiliar Vinculado', phone: '3006667788' },
      serviceRequest: { id: 'request-linked-1', source: 'MANUAL' }
    }
  }];
  const prismaClient = inboxPrisma({ rows, confirmations, workers: [] });

  const inbox = await loadDispatchWhatsappConversationInbox(prismaClient, { now: NOW });

  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].workerId, 'worker-linked-1');
  assert.equal(inbox.items[0].workerName, 'Auxiliar Vinculado');
  assert.equal(inbox.items[0].phoneDisplay, '+57 300 666 7788');
  assert.equal(inbox.items[0].deliveryState, 'SENT');
});

test('bandeja no certifica SENT histórico sin auditoría de estado Meta', async () => {
  const sentAt = '2026-09-20T23:20:00.000Z';
  const confirmations = [{
    id: 'link-historical-sent',
    phone: '573006667799',
    providerMessageId: 'wamid-historical-sent',
    status: 'SENT',
    createdAt: new Date(sentAt),
    updatedAt: new Date(sentAt),
    confirmationReceivedAt: null,
    assignment: {
      id: 'assignment-historical-sent',
      workerId: 'worker-historical-sent',
      worker: { id: 'worker-historical-sent', fullName: 'Auxiliar Histórico Envío', phone: '3006667799' },
      serviceRequest: { id: 'request-historical-sent', source: 'MANUAL' }
    }
  }];
  const prismaClient = inboxPrisma({ confirmations });

  const inbox = await loadDispatchWhatsappConversationInbox(prismaClient, { now: NOW });

  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].workerName, 'Auxiliar Histórico Envío');
  assert.equal(inbox.items[0].providerStatus, null);
  assert.equal(inbox.items[0].deliveryState, null);
  assert.equal(inbox.items[0].reconstructed, true);
});

test('bandeja agrupa una sola conversación por teléfono y ordena por último mensaje descendente', async () => {
  const rows = [
    auditRow({ id: 'wamid-old-a', phone: '573001112233', status: 'DELIVERED', at: '2026-09-21T10:00:00.000Z', body: 'Anterior A' }),
    auditRow({ id: 'wamid-new-a', phone: '573001112233', status: 'READ', at: '2026-09-21T11:20:00.000Z', body: 'Reciente A' }),
    auditRow({ id: 'wamid-b', phone: '573002223344', status: 'DELIVERED', at: '2026-09-21T11:30:00.000Z', body: 'Reciente B' })
  ];
  const workers = [
    { id: 'worker-a', fullName: 'Auxiliar A', phone: '3001112233' },
    { id: 'worker-b', fullName: 'Auxiliar B', phone: '3002223344' }
  ];
  const prismaClient = inboxPrisma({ rows, workers });

  const inbox = await loadDispatchWhatsappConversationInbox(prismaClient, { now: NOW });

  assert.equal(inbox.items.length, 2);
  assert.equal(inbox.items[0].workerName, 'Auxiliar B');
  assert.equal(inbox.items[0].lastMessageBody.includes('Reciente B'), true);
  assert.equal(inbox.items[1].workerName, 'Auxiliar A');
  assert.equal(inbox.items[1].lastMessageBody.includes('Reciente A'), true);
  assert.equal(inbox.items[1].messageCount, 2);
});

test('watchdog marca entrega incierta, actualiza auditoría y alerta una sola vez sin reenviar', async () => {
  const link = {
    id: 'link-watchdog-1',
    assignmentId: 'assignment-watchdog-1',
    phone: '573005556677',
    providerMessageId: 'wamid-watchdog-1',
    status: 'SENT',
    createdAt: new Date('2026-09-21T11:30:00.000Z'),
    assignment: {
      id: 'assignment-watchdog-1',
      createdByUsername: 'coordinador-prueba',
      worker: { id: 'worker-watchdog-1', fullName: 'Auxiliar Watchdog', phone: '3005556677' },
      serviceRequest: { source: 'MANUAL', serviceDate: new Date('2026-09-22T00:00:00.000Z') }
    }
  };
  const auditRowState = {
    id: 'audit-watchdog-1',
    metadata: { providerMessageId: 'wamid-watchdog-1', providerStatus: 'SENT', deliveryWatchdogStatus: null }
  };
  const notificationRows = [];
  const sentAlerts = [];
  const prismaClient = {
    dispatchWhatsappConfirmation: {
      findMany: async () => [link],
      updateMany: async ({ where, data }) => {
        if (where.id === link.id && ['PENDING', 'SENT'].includes(link.status)) {
          link.status = data.status;
          return { count: 1 };
        }
        return { count: 0 };
      }
    },
    appUser: {
      findMany: async () => [{ id: 'user-coord-1', username: 'coordinador-prueba', dispatchAlertPhone: '3007008899', isActive: true }]
    },
    devAuditEvent: {
      findFirst: async ({ where }) => {
        if (where.entityType === 'DISPATCH_WHATSAPP_MESSAGE') return auditRowState;
        const matches = notificationRows.filter((row) => row.entityType === where.entityType && row.entityId === where.entityId && row.action === where.action);
        return matches.at(-1) || null;
      },
      update: async ({ data }) => {
        auditRowState.metadata = data.metadata;
        return auditRowState;
      },
      create: async ({ data }) => {
        const row = { id: `notification-${notificationRows.length + 1}`, ...data };
        notificationRows.push(row);
        return row;
      }
    }
  };
  const sendAdminMessage = async (payload) => {
    sentAlerts.push(payload);
    return 'wamid-admin-alert';
  };

  const first = await runDispatchDeliveryWatchdog(prismaClient, { now: NOW, sendAdminMessage });
  assert.equal(first.checked, 1);
  assert.equal(first.markedUnknown, 1);
  assert.equal(first.alertsSent, 1);
  assert.equal(link.status, 'DELIVERY_UNKNOWN');
  assert.equal(auditRowState.metadata.providerStatus, 'SENT');
  assert.equal(auditRowState.metadata.deliveryWatchdogStatus, 'DELIVERY_UNKNOWN');
  assert.equal(sentAlerts.length, 1);
  assert.match(sentAlerts[0].text, /No se reenviaron mensajes automáticamente/);
  assert.match(sentAlerts[0].text, /Auxiliar Watchdog/);

  const second = await runDispatchDeliveryWatchdog(prismaClient, { now: NOW, sendAdminMessage });
  assert.equal(second.checked, 1);
  assert.equal(second.markedUnknown, 0);
  assert.equal(second.alertsSent, 0);
  assert.equal(sentAlerts.length, 1);
});

test('pantalla usa bandeja sin selector diario y representa los estados Meta sin inventar entrega', () => {
  const view = fs.readFileSync(new URL('../src/views/operacionesWhatsappEstado.ejs', import.meta.url), 'utf8');
  const route = fs.readFileSync(new URL('../src/routes/dispatchWhatsappNotifications.js', import.meta.url), 'utf8');
  const monitor = fs.readFileSync(new URL('../src/services/dispatchWhatsappMonitor.js', import.meta.url), 'utf8');
  const alerts = fs.readFileSync(new URL('../src/services/dispatchWhatsappAdminAlerts.js', import.meta.url), 'utf8');

  assert.match(view, /Conversaciones de Despacho/);
  assert.match(view, /item\.phoneDisplay \|\| item\.phone/);
  assert.match(view, /Ver conversación/);
  assert.match(view, /conversation\.messageHistory/);
  assert.match(view, /✓ Enviado/);
  assert.match(view, /✓✓ Entregado/);
  assert.match(view, /✓✓ Leído/);
  assert.match(view, /Sin estado Meta histórico/);
  assert.match(view, /DELIVERY_UNKNOWN/);
  assert.match(view, /Meta reportó fallo/);
  assert.doesNotMatch(view, /type="date"/);
  assert.doesNotMatch(view, /dispatchHistoryDate/);
  assert.match(route, /loadDispatchWhatsappConversationInbox/);
  assert.match(route, /linkedByProviderId/);
  assert.match(route, /const workerId = linkedWorker\?\.id/);
  assert.match(route, /historicalSent/);
  assert.doesNotMatch(route, /loadDispatchWhatsappOutboundHistoryByDate/);
  assert.doesNotMatch(route, /req\.query\?\.date/);
  assert.match(monitor, /contenido original no quedó almacenado/);
  assert.doesNotMatch(monitor, /buildDispatchAssignmentMessageBody/);
  assert.match(alerts, /runDispatchDeliveryWatchdog/);
  assert.match(alerts, /No se reenviaron mensajes automáticamente/);
});
