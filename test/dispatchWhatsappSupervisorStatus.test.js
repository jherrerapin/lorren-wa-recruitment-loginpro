import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadDispatchWhatsappSupervisorAssignmentStatus } from '../src/routes/dispatchWhatsappNotifications.js';

const NOW = new Date('2026-09-21T19:00:00.000Z');

function assignmentLink({
  id,
  assignmentId,
  workerId = `worker-${assignmentId}`,
  workerName,
  phone,
  status = 'SENT',
  providerMessageId = null,
  confirmationReceivedAt = null,
  createdAt = '2026-09-21T18:00:00.000Z',
  updatedAt = createdAt
}) {
  return {
    id,
    assignmentId,
    phone,
    status,
    providerMessageId,
    alertOwnerUsername: 'supervisor-prueba',
    confirmationReceivedAt: confirmationReceivedAt ? new Date(confirmationReceivedAt) : null,
    createdAt: new Date(createdAt),
    updatedAt: new Date(updatedAt),
    assignment: {
      id: assignmentId,
      workerId,
      worker: workerId ? { id: workerId, fullName: workerName, phone } : null,
      serviceRequest: {
        id: `request-${assignmentId}`,
        source: 'MANUAL',
        serviceDate: new Date('2026-09-22T05:00:00.000Z'),
        operationPointName: 'Operación de prueba'
      }
    }
  };
}

function providerAudit(providerMessageId, providerStatus, providerStatusAt, deliveryWatchdogStatus = null) {
  return {
    entityId: `dispatch-wa:outbound:${providerMessageId}`,
    metadata: {
      providerMessageId,
      providerStatus,
      providerStatusAt,
      deliveryWatchdogStatus
    }
  };
}

test('supervisor ve solo sus auxiliares y el estado visible depende de evidencia real, no del estado interno SENT', async () => {
  const links = [
    assignmentLink({ id: 'link-accepted', assignmentId: 'assignment-accepted', workerName: 'Auxiliar Alfa', phone: '3001112233', status: 'SENT', providerMessageId: 'provider-accepted' }),
    assignmentLink({ id: 'link-sent', assignmentId: 'assignment-sent', workerName: 'Auxiliar Beta', phone: '3002223344', status: 'SENT', providerMessageId: 'provider-sent' }),
    assignmentLink({ id: 'link-delivered', assignmentId: 'assignment-delivered', workerName: 'Auxiliar Gamma', phone: '3003334455', status: 'DELIVERED', providerMessageId: 'provider-delivered' }),
    assignmentLink({ id: 'link-read', assignmentId: 'assignment-read', workerName: 'Auxiliar Delta', phone: '3004445566', status: 'READ', providerMessageId: 'provider-read' }),
    assignmentLink({
      id: 'link-confirmed', assignmentId: 'assignment-confirmed', workerName: 'Auxiliar Épsilon', phone: '3005556677',
      status: 'CONFIRMED_REPLY_PENDING', providerMessageId: 'provider-confirmed', confirmationReceivedAt: '2026-09-21T18:30:00.000Z'
    }),
    assignmentLink({ id: 'link-failed', assignmentId: 'assignment-failed', workerName: 'Auxiliar Zeta', phone: '3006667788', status: 'FAILED' }),
    assignmentLink({ id: 'link-unknown', assignmentId: 'assignment-unknown', workerName: 'Auxiliar Eta', phone: '3007778899', status: 'DELIVERY_UNKNOWN', providerMessageId: 'provider-unknown' }),
    assignmentLink({
      id: 'link-novelty', assignmentId: 'assignment-novelty', workerName: 'Auxiliar Theta', phone: '3008889900',
      status: 'NOVELTY_REPORTED', providerMessageId: 'provider-novelty', confirmationReceivedAt: '2026-09-21T18:35:00.000Z'
    })
  ];
  const audits = [
    providerAudit('provider-accepted', 'ACCEPTED', '2026-09-21T18:01:00.000Z'),
    providerAudit('provider-sent', 'SENT', '2026-09-21T18:02:00.000Z'),
    providerAudit('provider-delivered', 'DELIVERED', '2026-09-21T18:03:00.000Z'),
    providerAudit('provider-read', 'READ', '2026-09-21T18:04:00.000Z'),
    providerAudit('provider-confirmed', 'DELIVERED', '2026-09-21T18:05:00.000Z'),
    providerAudit('provider-unknown', 'SENT', '2026-09-21T18:06:00.000Z', 'DELIVERY_UNKNOWN'),
    providerAudit('provider-novelty', 'DELIVERED', '2026-09-21T18:07:00.000Z')
  ];
  let confirmationQuery = null;
  let auditQuery = null;
  const prismaClient = {
    dispatchWhatsappConfirmation: {
      findMany: async (query) => {
        confirmationQuery = query;
        return links;
      }
    },
    devAuditEvent: {
      findMany: async (query) => {
        auditQuery = query;
        return audits;
      }
    }
  };

  const result = await loadDispatchWhatsappSupervisorAssignmentStatus(prismaClient, {
    ownerUsername: 'supervisor-prueba',
    now: NOW
  });

  assert.equal(confirmationQuery.where.alertOwnerUsername, 'supervisor-prueba');
  assert.equal(confirmationQuery.distinct, undefined);
  assert.equal(confirmationQuery.skip, undefined);
  assert.equal(confirmationQuery.take, undefined);
  assert.deepEqual(confirmationQuery.orderBy, { createdAt: 'desc' });
  assert.equal(confirmationQuery.where.assignment.serviceRequest.source.not, 'DEV_TEST');
  assert.ok(auditQuery.where.entityId.in.includes('dispatch-wa:outbound:provider-accepted'));

  const byAssignment = new Map(result.items.map((item) => [item.assignmentId, item]));
  assert.equal(byAssignment.get('assignment-accepted').statusLabel, 'Recibido por WhatsApp');
  assert.match(byAssignment.get('assignment-accepted').statusDetail, /todavía no ha confirmado que salió/i);
  assert.notEqual(byAssignment.get('assignment-accepted').statusLabel, 'Enviado');
  assert.equal(byAssignment.get('assignment-sent').statusLabel, 'Enviado');
  assert.equal(byAssignment.get('assignment-delivered').statusLabel, 'Entregado');
  assert.equal(byAssignment.get('assignment-read').statusLabel, 'Leído');
  assert.equal(byAssignment.get('assignment-confirmed').statusLabel, 'Confirmado por el auxiliar');
  assert.equal(byAssignment.get('assignment-failed').statusLabel, 'No se pudo enviar');
  assert.match(byAssignment.get('assignment-failed').statusDetail, /botón de esta fila/i);
  assert.equal(byAssignment.get('assignment-failed').serviceRequestId, 'request-assignment-failed');
  assert.equal(byAssignment.get('assignment-failed').phone, '573006667788');
  assert.equal(byAssignment.get('assignment-failed').canResend, true);
  assert.equal(byAssignment.get('assignment-unknown').statusLabel, 'Entrega sin confirmar');
  assert.match(byAssignment.get('assignment-unknown').statusDetail, /WhatsApp no confirmó que el mensaje haya llegado al teléfono/i);
  assert.match(byAssignment.get('assignment-unknown').statusDetail, /botón de esta fila/i);
  assert.doesNotMatch(byAssignment.get('assignment-unknown').statusDetail, /revisa|configuración|wamid|DELIVERY_UNKNOWN/i);
  assert.equal(byAssignment.get('assignment-unknown').canResend, true);
  assert.equal(byAssignment.get('assignment-sent').canResend, false);
  assert.equal(byAssignment.get('assignment-delivered').canResend, false);
  assert.equal(byAssignment.get('assignment-read').canResend, false);
  assert.equal(byAssignment.get('assignment-confirmed').canResend, false);
  assert.equal(byAssignment.get('assignment-novelty').statusLabel, 'Novedad reportada');
  assert.equal(byAssignment.get('assignment-accepted').workerName, 'Auxiliar Alfa');
  assert.equal(byAssignment.get('assignment-accepted').phoneDisplay, '+57 300 111 2233');

  for (const item of result.items) {
    const visibleText = `${item.statusLabel} ${item.statusDetail}`;
    assert.doesNotMatch(visibleText, /\b(?:SENT|DELIVERED|READ|FAILED|DELIVERY_UNKNOWN|UNKNOWN|wamid|Meta)\b/i);
  }
});

test('estado reintentable sin contexto completo no expone reenvío', async () => {
  const incomplete = assignmentLink({
    id: 'link-incomplete-retry',
    assignmentId: 'assignment-incomplete-retry',
    workerId: null,
    workerName: 'Auxiliar sin relación',
    phone: '3001012020',
    status: 'FAILED'
  });
  incomplete.assignment.serviceRequest = null;
  const prismaClient = {
    dispatchWhatsappConfirmation: { findMany: async () => [incomplete] },
    devAuditEvent: { findMany: async () => [] }
  };

  const result = await loadDispatchWhatsappSupervisorAssignmentStatus(prismaClient, {
    ownerUsername: 'supervisor-prueba',
    now: NOW
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].statusKey, 'FAILED');
  assert.equal(result.items[0].canResend, false);
});

test('un mismo auxiliar aparece una sola vez con el estado de su asignación más reciente', async () => {
  const links = [
    assignmentLink({
      id: 'link-worker-new',
      assignmentId: 'assignment-worker-new',
      workerId: 'worker-shared',
      workerName: 'Auxiliar Consolidado',
      phone: '3001234567',
      status: 'SENT',
      providerMessageId: 'provider-worker-new',
      createdAt: '2026-09-21T18:30:00.000Z'
    }),
    assignmentLink({
      id: 'link-worker-old',
      assignmentId: 'assignment-worker-old',
      workerId: 'worker-shared',
      workerName: 'Auxiliar Consolidado',
      phone: '3001234567',
      status: 'DELIVERED',
      providerMessageId: 'provider-worker-old',
      createdAt: '2026-09-21T17:30:00.000Z'
    }),
    assignmentLink({
      id: 'link-other-worker',
      assignmentId: 'assignment-other-worker',
      workerId: 'worker-other',
      workerName: 'Auxiliar Distinto',
      phone: '3007654321',
      status: 'DELIVERED',
      providerMessageId: 'provider-other-worker',
      createdAt: '2026-09-21T18:20:00.000Z'
    })
  ];
  const prismaClient = {
    dispatchWhatsappConfirmation: { findMany: async () => links },
    devAuditEvent: {
      findMany: async () => [
        providerAudit('provider-worker-new', 'SENT', '2026-09-21T18:31:00.000Z'),
        providerAudit('provider-worker-old', 'DELIVERED', '2026-09-21T17:31:00.000Z'),
        providerAudit('provider-other-worker', 'DELIVERED', '2026-09-21T18:21:00.000Z')
      ]
    }
  };

  const result = await loadDispatchWhatsappSupervisorAssignmentStatus(prismaClient, {
    ownerUsername: 'supervisor-prueba',
    now: NOW
  });

  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items.map((item) => item.workerId), ['worker-shared', 'worker-other']);
  const consolidated = result.items.find((item) => item.workerId === 'worker-shared');
  assert.equal(consolidated.assignmentId, 'assignment-worker-new');
  assert.equal(consolidated.statusLabel, 'Enviado');
  assert.equal(result.items.some((item) => item.assignmentId === 'assignment-worker-old'), false);
});

test('si falta workerId, el teléfono normalizado consolida el mismo auxiliar como respaldo', async () => {
  const links = [
    assignmentLink({
      id: 'link-phone-new',
      assignmentId: 'assignment-phone-new',
      workerId: null,
      workerName: 'Auxiliar sin relación',
      phone: '+57 300 555 7788',
      status: 'SENT',
      providerMessageId: 'provider-phone-new',
      createdAt: '2026-09-21T18:30:00.000Z'
    }),
    assignmentLink({
      id: 'link-phone-old',
      assignmentId: 'assignment-phone-old',
      workerId: null,
      workerName: 'Auxiliar sin relación',
      phone: '3005557788',
      status: 'DELIVERED',
      providerMessageId: 'provider-phone-old',
      createdAt: '2026-09-21T17:30:00.000Z'
    })
  ];
  const prismaClient = {
    dispatchWhatsappConfirmation: { findMany: async () => links },
    devAuditEvent: { findMany: async () => [providerAudit('provider-phone-new', 'SENT', '2026-09-21T18:31:00.000Z')] }
  };

  const result = await loadDispatchWhatsappSupervisorAssignmentStatus(prismaClient, {
    ownerUsername: 'supervisor-prueba',
    now: NOW
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].assignmentId, 'assignment-phone-new');
});

test('confirmación humana prevalece sobre un estado de entrega anterior', async () => {
  const link = assignmentLink({
    id: 'link-confirmed-priority',
    assignmentId: 'assignment-confirmed-priority',
    workerName: 'Auxiliar Prioridad',
    phone: '3009990011',
    status: 'CONFIRMED',
    providerMessageId: 'provider-confirmed-priority',
    confirmationReceivedAt: '2026-09-21T18:40:00.000Z'
  });
  const prismaClient = {
    dispatchWhatsappConfirmation: { findMany: async () => [link] },
    devAuditEvent: { findMany: async () => [providerAudit('provider-confirmed-priority', 'READ', '2026-09-21T18:20:00.000Z')] }
  };

  const result = await loadDispatchWhatsappSupervisorAssignmentStatus(prismaClient, {
    ownerUsername: 'supervisor-prueba',
    now: NOW
  });

  assert.equal(result.items[0].statusLabel, 'Confirmado por el auxiliar');
  assert.equal(result.items[0].statusKey, 'CONFIRMED');
  assert.equal(result.items[0].canResend, false);
  assert.equal(result.summary.confirmed, 1);
});

test('vista separa supervisor operativo, permite reenvío canónico y mantiene navegación explícita', () => {
  const view = fs.readFileSync(new URL('../src/views/operacionesWhatsappEstado.ejs', import.meta.url), 'utf8');
  const route = fs.readFileSync(new URL('../src/routes/dispatchWhatsappNotifications.js', import.meta.url), 'utf8');

  assert.match(route, /operationalRole\(req\).*SUPERVISOR/s);
  assert.match(route, /devView \? loadDispatchWhatsappConversationInbox\(prisma, \{ page \}\) : null/);
  assert.match(route, /supervisorView \? loadDispatchWhatsappSupervisorAssignmentStatus\(prisma, \{ ownerUsername, page \}\) : null/);
  assert.match(route, /router\.get\('\/estado-mensajes-asignacion', requireSupervisorStatus/);
  assert.match(route, /alertOwnerUsername: owner/);
  assert.match(route, /canResend:\s*\['FAILED', 'DELIVERY_UNKNOWN'\]\.includes\(status\.key\)/);
  assert.match(route, /router\.post\('\/enviar'/);
  assert.match(route, /sendDispatchWhatsappMessage\(\{/);
  assert.doesNotMatch(route, /router\.post\('\/reenviar'/);

  assert.match(view, /const isSupervisorView = !isDevView && operationalRole === 'SUPERVISOR'/);
  assert.match(view, /const hasConversationInbox = isDevView &&/);
  assert.match(view, /const supervisorPage = Math\.max\(1, Number\(supervisorStatus\.pagination\?\.page\) \|\| 1\)/);
  assert.match(view, /Estado de mensajes de asignación/);
  assert.match(view, /únicamente las solicitudes de asignación enviadas por tu usuario/);
  assert.match(view, /Requieren atención/);
  assert.match(view, /data-supervisor-resend/);
  assert.match(view, /Reenviar mensaje/);
  assert.match(view, /function appendSupervisorResendButton/);
  assert.match(view, /async function resendSupervisorAssignment/);
  assert.match(view, /fetch\(`\$\{supervisorBasePath\}\/enviar`/);
  assert.match(view, /messageType:'DISPATCH_ASSIGNMENT_CONFIRMATION_REQUEST'/);
  assert.match(view, /\[data-supervisor-resend\]/);
  assert.doesNotMatch(view, /\$\{supervisorBasePath\}\/reenviar/);
  assert.match(view, /id="supervisorPagination"/);
  assert.match(view, /supervisorPage > 1/);
  assert.match(view, /← Página anterior/);
  assert.match(view, /Ir a página 1/);
  assert.match(view, /Página siguiente →/);
  assert.match(view, /function renderSupervisorPagination\(pagination=\{\}\)/);
  assert.match(view, /if\(page>1\).*← Página anterior.*Ir a página 1/s);
  assert.match(view, /renderSupervisorPagination\(data\.pagination\)/);
  assert.match(view, /setInterval\(refreshSupervisorAssignments,5000\)/);

  const supervisorBlockStart = view.indexOf('<% if (isSupervisorView) { %>');
  const devConversationStart = view.indexOf('<% if (hasConversationInbox) { %>', supervisorBlockStart);
  assert.ok(supervisorBlockStart >= 0 && devConversationStart > supervisorBlockStart);
  const supervisorBlock = view.slice(supervisorBlockStart, devConversationStart);
  assert.doesNotMatch(supervisorBlock, /supervisorStatus\.pagination\?\.hasPrevious/);
  assert.doesNotMatch(supervisorBlock, /Ver mensajes|Conversaciones de Despacho|wamid|Meta reportó|\bSENT\b|\bDELIVERED\b|\bREAD\b|\bFAILED\b|DELIVERY_UNKNOWN/);
});
