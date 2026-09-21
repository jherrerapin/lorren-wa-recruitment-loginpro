import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  loadDispatchWhatsappOutboundHistoryByDate,
  loadDispatchWhatsappPhoneConversation
} from '../src/services/dispatchWhatsappMonitor.js';
import { runDispatchWhatsappDeliveryWatchdog } from '../src/services/dispatchWhatsappAdminAlerts.js';

const NOW = new Date('2026-09-21T12:00:00.000Z');

function auditRow({ id, phone, status, at, body, source = 'ASSIGNMENT_CONFIRMATION', diagnostic = null, direction = 'OUTBOUND' }) {
  return {
    id: `audit-${id}`,
    entityType: 'DISPATCH_WHATSAPP_MESSAGE',
    entityId: `dispatch-wa:${direction.toLowerCase()}:${id}`,
    entityLabel: phone,
    action: `DISPATCH_WHATSAPP_${direction}`,
    actorSource: source,
    metadata: {
      scope: 'operational',
      direction,
      phone,
      body,
      messageType: direction === 'OUTBOUND' ? 'TEMPLATE' : 'INTERACTIVE',
      messageId: direction === 'INBOUND' ? id : '',
      providerMessageId: direction === 'OUTBOUND' ? id : '',
      providerStatus: direction === 'OUTBOUND' ? status : null,
      providerStatusAt: direction === 'OUTBOUND' ? at : null,
      providerDiagnostic: diagnostic,
      source,
      occurredAt: at
    },
    createdAt: new Date(at)
  };
}

function confirmationRow({ id, providerMessageId, phone, at, status = 'SENT', workerName = 'Auxiliar Histórico', source = 'MANUAL' }) {
  return {
    id,
    phone,
    providerMessageId,
    status,
    alertOwnerUsername: 'operador-prueba',
    createdAt: new Date(at),
    assignment: {
      id: `assignment-${id}`,
      createdByUsername: 'operador-prueba',
      worker: { id: `worker-${id}`, fullName: workerName, phone },
      serviceRequest: {
        id: `request-${id}`,
        source,
        operationPointName: 'Operación mutable que no debe reconstruirse',
        serviceDate: new Date('2026-09-21T00:00:00.000Z'),
        startTime: '23:59',
        address: 'Dirección mutable que no debe aparecer'
      }
    }
  };
}

function historyPrisma({ rows = [], confirmations = [], globalAuditRows = [], auditedLinks = [], workers = [] } = {}) {
  return {
    devAuditEvent: {
      findMany: async (query) => {
        if (query.where?.entityId?.in) return globalAuditRows;
        assert.equal(query.where.entityType, 'DISPATCH_WHATSAPP_MESSAGE');
        assert.equal(query.where.action, 'DISPATCH_WHATSAPP_OUTBOUND');
        assert.deepEqual(query.orderBy, { createdAt: 'desc' });
        return rows.slice(0, query.take);
      }
    },
    dispatchWhatsappConfirmation: {
      findMany: async (query) => {
        if (query.where?.providerMessageId?.in) return auditedLinks;
        if (query.where?.createdAt) return confirmations.slice(0, query.take);
        return [];
      }
    },
    dispatchWorker: {
      findMany: async (query) => {
        assert.ok(Array.isArray(query.where?.OR));
        assert.ok(query.where.OR.length > 0);
        assert.deepEqual(query.select, { fullName: true, phone: true });
        return workers;
      }
    }
  };
}

test('historial outbound usa el día Bogotá, teléfono completo y estados Meta sin leer todos los auxiliares', async () => {
  const rows = [
    auditRow({ id: 'wamid-test-failed', phone: '573003334455', status: 'FAILED', at: '2026-09-21T00:20:00.000Z', body: 'Asignación ficticia C', diagnostic: 'code=131000 error saneado' }),
    auditRow({ id: 'wamid-test-delivered', phone: '573002223344', status: 'DELIVERED', at: '2026-09-21T00:10:00.000Z', body: 'Asignación ficticia B' }),
    auditRow({ id: 'wamid-test-accepted', phone: '573001112233', status: 'ACCEPTED', at: '2026-09-21T00:05:00.000Z', body: 'Asignación ficticia A' })
  ];
  const prismaClient = historyPrisma({
    rows,
    workers: [
      { fullName: 'Auxiliar Uno', phone: '3001112233' },
      { fullName: 'Auxiliar Dos', phone: '3002223344' },
      { fullName: 'Auxiliar Tres', phone: '3003334455' }
    ]
  });
  const originalFindMany = prismaClient.devAuditEvent.findMany;
  prismaClient.devAuditEvent.findMany = async (query) => {
    if (!query.where?.entityId?.in) {
      assert.equal(query.where.createdAt.gte.toISOString(), '2026-09-20T05:00:00.000Z');
      assert.equal(query.where.createdAt.lt.toISOString(), '2026-09-21T05:00:00.000Z');
      assert.equal(query.take, 101);
    }
    return originalFindMany(query);
  };

  const history = await loadDispatchWhatsappOutboundHistoryByDate({ prismaClient, dateKey: '2026-09-20', now: NOW });

  assert.equal(history.dateKey, '2026-09-20');
  assert.equal(history.range.start, '2026-09-20T05:00:00.000Z');
  assert.equal(history.range.end, '2026-09-21T05:00:00.000Z');
  assert.equal(history.summary.shown, 3);
  assert.equal(history.summary.accepted, 1);
  assert.equal(history.summary.delivered, 1);
  assert.equal(history.summary.failed, 1);
  assert.equal(history.items[0].providerDiagnostic, 'code=131000 error saneado');
  assert.equal(history.items[0].phone, '573003334455');
  assert.equal(history.items[0].workerName, 'Auxiliar Tres');
  assert.equal(history.items[1].workerName, 'Auxiliar Dos');
  assert.equal(history.items[2].workerName, 'Auxiliar Uno');
  assert.equal(history.pagination.page, 1);
  assert.equal(history.pagination.hasPrevious, false);
});

test('historial pagina sin presentar un total falso ni truncamiento silencioso', async () => {
  const rows = Array.from({ length: 201 }, (_, index) => auditRow({
    id: `wamid-page-${String(index).padStart(3, '0')}`,
    phone: '573001112233',
    status: 'SENT',
    at: new Date(Date.parse('2026-09-20T05:00:00.000Z') + index * 1000).toISOString(),
    body: `Mensaje ${index}`
  })).reverse();
  const prismaClient = historyPrisma({ rows, workers: [{ fullName: 'Auxiliar Paginado', phone: '3001112233' }] });
  const history = await loadDispatchWhatsappOutboundHistoryByDate({ prismaClient, dateKey: '2026-09-20', page: 2, now: NOW });

  assert.equal(history.pagination.page, 2);
  assert.equal(history.pagination.pageSize, 100);
  assert.equal(history.pagination.hasPrevious, true);
  assert.equal(history.pagination.hasMore, true);
  assert.equal(history.summary.shown, 100);
  assert.equal(history.items.length, 100);
  assert.equal(Object.hasOwn(history.summary, 'total'), false);
});

test('fecha inválida usa el día actual de Bogotá', async () => {
  const prismaClient = historyPrisma();
  const history = await loadDispatchWhatsappOutboundHistoryByDate({ prismaClient, dateKey: '2026-99-99', now: NOW });
  assert.equal(history.dateKey, '2026-09-21');
  assert.equal(history.range.start, '2026-09-21T05:00:00.000Z');
  assert.equal(history.range.end, '2026-09-22T05:00:00.000Z');
  assert.equal(history.summary.shown, 0);
});

test('evidencia histórica no inventa el cuerpo desde datos mutables de la asignación', async () => {
  const confirmation = confirmationRow({
    id: 'confirmation-historical-1',
    providerMessageId: 'wamid-historical-1',
    phone: '573004445566',
    at: '2026-09-21T00:08:00.000Z'
  });
  const prismaClient = historyPrisma({ confirmations: [confirmation] });
  const history = await loadDispatchWhatsappOutboundHistoryByDate({ prismaClient, dateKey: '2026-09-20', now: NOW });

  assert.equal(history.summary.shown, 1);
  assert.equal(history.summary.historical, 1);
  assert.equal(history.items[0].workerName, 'Auxiliar Histórico');
  assert.equal(history.items[0].phone, '573004445566');
  assert.equal(history.items[0].providerMessageId, 'wamid-historical-1');
  assert.equal(history.items[0].providerStatus, null);
  assert.equal(history.items[0].source, 'RECONSTRUIDO_ASIGNACION');
  assert.equal(history.items[0].reconstructed, true);
  assert.match(history.items[0].body, /contenido exacto no quedó auditado/i);
  assert.doesNotMatch(history.items[0].body, /Operación mutable|23:59|Dirección mutable/);
});

test('deduplicación histórica consulta el providerMessageId fuera del corte diario', async () => {
  const confirmation = confirmationRow({
    id: 'confirmation-midnight',
    providerMessageId: 'wamid-midnight',
    phone: '573004445566',
    at: '2026-09-21T04:59:59.000Z'
  });
  const prismaClient = historyPrisma({
    confirmations: [confirmation],
    globalAuditRows: [{ entityId: 'dispatch-wa:outbound:wamid-midnight' }]
  });
  const history = await loadDispatchWhatsappOutboundHistoryByDate({ prismaClient, dateKey: '2026-09-20', now: NOW });
  assert.equal(history.items.length, 0);
  assert.equal(history.summary.historical, 0);
});

test('conversación por teléfono conserva inbound/outbound y puede ampliar el límite del monitor', async () => {
  const rows = [
    auditRow({ id: 'wamid-out-1', phone: '573001112233', status: 'DELIVERED', at: '2026-09-20T22:00:00.000Z', body: 'Mensaje de salida' }),
    auditRow({ id: 'wamid-in-1', phone: '573001112233', status: null, at: '2026-09-20T22:01:00.000Z', body: 'Confirmado', source: 'WEBHOOK_INBOUND', direction: 'INBOUND' })
  ];
  const prismaClient = {
    dispatchWhatsappContactWindow: { findUnique: async () => ({ lastInboundAt: new Date('2026-09-20T22:01:00.000Z') }) },
    devAuditEvent: {
      findMany: async (query) => {
        assert.deepEqual(query.where.entityLabel, { in: ['573001112233'] });
        assert.ok(query.take >= 100);
        return rows.slice().reverse();
      }
    },
    dispatchWhatsappConfirmation: {
      findMany: async () => [confirmationRow({
        id: 'conversation-link', providerMessageId: 'wamid-out-1', phone: '573001112233', at: '2026-09-20T22:00:00.000Z', status: 'DELIVERED', workerName: 'Auxiliar Conversación'
      })]
    }
  };
  const conversation = await loadDispatchWhatsappPhoneConversation({ prismaClient, phone: '3001112233', messageLimit: 100, now: NOW });
  assert.equal(conversation.phone, '573001112233');
  assert.deepEqual(conversation.workerNames, ['Auxiliar Conversación']);
  assert.equal(conversation.messageHistory.length, 2);
  assert.equal(conversation.messageHistory[0].direction, 'OUTBOUND');
  assert.equal(conversation.messageHistory[1].direction, 'INBOUND');
});

function watchdogFixture({ providerStatus = 'ACCEPTED' } = {}) {
  const link = {
    id: 'link-watch-1',
    phone: '573001112233',
    providerMessageId: 'wamid-watch-1',
    status: 'SENT',
    alertOwnerUsername: 'operador-prueba',
    createdAt: new Date('2026-09-21T11:40:00.000Z'),
    assignment: {
      id: 'assignment-watch-1',
      createdByUsername: 'operador-prueba',
      worker: { fullName: 'Auxiliar Watch', phone: '3001112233' },
      serviceRequest: { source: 'MANUAL' }
    }
  };
  const notificationEvents = [];
  const prismaClient = {
    dispatchWhatsappConfirmation: {
      findMany: async () => [link],
      updateMany: async ({ where, data }) => {
        if (where.id === link.id && where.status.in.includes(link.status)) {
          link.status = data.status;
          return { count: 1 };
        }
        return { count: 0 };
      }
    },
    devAuditEvent: {
      findMany: async (query) => {
        if (query.where?.entityType === 'DISPATCH_WHATSAPP_MESSAGE') {
          return [{ entityId: 'dispatch-wa:outbound:wamid-watch-1', metadata: { providerStatus } }];
        }
        return [];
      },
      findFirst: async (query) => notificationEvents
        .filter((event) => event.entityType === query.where.entityType && event.entityId === query.where.entityId && event.action === query.where.action)
        .sort((a, b) => b.createdAt - a.createdAt)[0] || null,
      create: async ({ data }) => {
        const row = { id: `notification-${notificationEvents.length + 1}`, ...data };
        notificationEvents.push(row);
        return row;
      }
    },
    appUser: {
      findMany: async (query) => {
        assert.deepEqual(query.where.username, { in: ['operador-prueba'] });
        return [{ id: 'user-watch-1', username: 'operador-prueba', dispatchAlertPhone: '573009998877', isActive: true }];
      }
    }
  };
  return { prismaClient, link, notificationEvents };
}

test('watchdog marca DELIVERY_UNKNOWN y alerta una sola vez sin reenviar la asignación', async () => {
  const { prismaClient, link } = watchdogFixture({ providerStatus: 'ACCEPTED' });
  const sentAlerts = [];
  const sendAdminMessage = async (payload) => { sentAlerts.push(payload); return 'wamid-alert-test'; };

  const first = await runDispatchWhatsappDeliveryWatchdog(prismaClient, { now: NOW, sendAdminMessage });
  assert.equal(link.status, 'DELIVERY_UNKNOWN');
  assert.equal(first.deliveryUnknown, 1);
  assert.equal(first.alertsSent, 1);
  assert.equal(first.linksNotified, 1);
  assert.equal(sentAlerts.length, 1);
  assert.match(sentAlerts[0].text, /no reenvió estos mensajes automáticamente/i);

  const second = await runDispatchWhatsappDeliveryWatchdog(prismaClient, { now: NOW, sendAdminMessage });
  assert.equal(second.alertsSent, 0);
  assert.equal(sentAlerts.length, 1);
});

test('watchdog repara DELIVERED desde la auditoría Meta y no genera alerta', async () => {
  const { prismaClient, link } = watchdogFixture({ providerStatus: 'DELIVERED' });
  let sends = 0;
  const result = await runDispatchWhatsappDeliveryWatchdog(prismaClient, {
    now: NOW,
    sendAdminMessage: async () => { sends += 1; }
  });
  assert.equal(link.status, 'DELIVERED');
  assert.equal(result.reconciled, 1);
  assert.equal(result.deliveryUnknown, 0);
  assert.equal(result.alertsSent, 0);
  assert.equal(sends, 0);
});

test('pantalla, ruta y autoridades comparten historial, conversación y watchdog sin duplicar envío', () => {
  const view = fs.readFileSync(new URL('../src/views/operacionesWhatsappEstado.ejs', import.meta.url), 'utf8');
  const route = fs.readFileSync(new URL('../src/routes/dispatchWhatsappNotifications.js', import.meta.url), 'utf8');
  const assignmentService = fs.readFileSync(new URL('../src/services/dispatchWhatsappAssignmentService.js', import.meta.url), 'utf8');
  const alerts = fs.readFileSync(new URL('../src/services/dispatchWhatsappAdminAlerts.js', import.meta.url), 'utf8');

  assert.match(view, /historyAvailable/);
  assert.match(view, /displayPhone\(item\.phone\)/);
  assert.match(view, /Ver conversación/);
  assert.match(view, /id="dispatchConversation"/);
  assert.match(view, /Entrega no confirmada/);
  assert.match(view, /Página siguiente/);
  assert.match(route, /loadDispatchWhatsappPhoneConversation/);
  assert.match(route, /conversationPhone/);
  assert.match(route, /page:\s*historyPage/);
  assert.doesNotMatch(route, /auditAssignmentSend/);
  assert.match(assignmentService, /await recordDispatchWhatsappMessageAudit\(\{/);
  assert.match(alerts, /runDispatchWhatsappDeliveryWatchdog/);
  assert.match(alerts, /data:\s*\{ status: 'DELIVERY_UNKNOWN' \}/);
  assert.match(alerts, /no reenvió estos mensajes automáticamente/i);
});
