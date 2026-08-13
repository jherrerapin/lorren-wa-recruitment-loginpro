import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDispatchWhatsappMonitorHistory } from '../src/services/dispatchWhatsappMonitor.js';

function prismaFixture() {
  const operationalLink = {
    id: 'link-old',
    phone: '3001112233',
    providerMessageId: 'wamid.out.old',
    confirmationMessageId: 'wamid.in.confirm',
    confirmationReceivedAt: new Date('2026-08-12T22:00:00.000Z'),
    status: 'CONFIRMED',
    createdAt: new Date('2026-07-01T15:00:00.000Z'),
    assignment: {
      id: 'assignment-old',
      worker: { id: 'worker-old', fullName: 'Auxiliar Histórico', phone: '3001112233' },
      serviceRequest: {
        source: 'INTERNAL',
        serviceDate: new Date('2026-08-13T00:00:00.000Z'),
        operationPointName: 'Operación Norte',
        serviceName: 'Cargue',
        address: 'Dirección de prueba',
        startTime: '07:30',
        operationPoint: null
      }
    }
  };
  const devLink = {
    ...operationalLink,
    id: 'link-dev',
    phone: '3009990000',
    providerMessageId: 'wamid.dev',
    confirmationMessageId: null,
    confirmationReceivedAt: null,
    status: 'SENT',
    createdAt: new Date('2026-08-12T20:00:00.000Z'),
    assignment: {
      ...operationalLink.assignment,
      id: 'assignment-dev',
      worker: { id: 'worker-dev', fullName: 'Perfil Dev', phone: '3009990000' },
      serviceRequest: { ...operationalLink.assignment.serviceRequest, source: 'DEV_TEST' }
    }
  };
  const incident = {
    id: 'incident-1',
    type: 'WHATSAPP_NOVELTY',
    status: 'OPEN',
    createdAt: new Date('2026-08-12T22:05:00.000Z'),
    worker: { id: 'worker-old', fullName: 'Auxiliar Histórico', phone: '3001112233' },
    assignment: { worker: { id: 'worker-old', fullName: 'Auxiliar Histórico', phone: '3001112233' } }
  };
  const reminder = {
    id: 'reminder-1',
    scope: 'operational',
    phone: '573001112233',
    appUserId: 'user-1',
    status: 'SENT',
    sentAt: new Date('2026-08-12T22:10:00.000Z'),
    createdAt: new Date('2026-08-12T22:09:00.000Z')
  };

  return {
    dispatchWhatsappConfirmation: {
      findMany: async () => [devLink, operationalLink]
    },
    dispatchIncident: {
      findMany: async (query) => {
        assert.equal(query.where.type, 'WHATSAPP_NOVELTY');
        return [incident];
      }
    },
    dispatchWhatsappWindowReminder: {
      findMany: async (query) => {
        assert.equal(query.where.scope, 'operational');
        return [reminder];
      }
    },
    appUser: {
      findMany: async () => [{ id: 'user-1', username: 'operaciones-despacho', dispatchAlertPhone: '3015557788' }]
    }
  };
}

test('monitor recupera histórico anterior sin recortarlo a hoy y excluye DEV_TEST', async () => {
  const history = await loadDispatchWhatsappMonitorHistory({ prismaClient: prismaFixture() });

  assert.equal(history.summary.total, 5);
  assert.equal(history.summary.outbound, 3);
  assert.equal(history.summary.inbound, 2);
  assert.equal(history.summary.reconstructed, 1);
  assert.equal(history.summary.oldestAvailableAt, '2026-07-01T15:00:00.000Z');
  assert.equal(history.items.some((item) => item.phone === '573009990000'), false);
  assert.ok(history.items.some((item) => item.messageId === 'wamid.out.old' && item.kind === 'ASIGNACION'));
  assert.ok(history.items.some((item) => item.messageId === 'wamid.in.confirm' && item.content === 'CONFIRMADO'));
  assert.ok(history.items.some((item) => item.kind === 'RESPUESTA_AUTOMATICA' && item.content === 'Gracias.' && item.evidence === 'RECONSTRUIDO'));
  assert.ok(history.items.some((item) => item.kind === 'NOVEDAD' && item.content === 'REPORTAR NOVEDAD'));
  assert.ok(history.items.some((item) => item.kind === 'RECORDATORIO_24H' && item.phone === '573015557788'));
});

test('monitor filtra por dirección, teléfono y búsqueda sin perder paginación', async () => {
  const history = await loadDispatchWhatsappMonitorHistory({
    prismaClient: prismaFixture(),
    query: { direction: 'inbound', phone: '3001112233', q: 'confirmado', pageSize: '1', page: '9' }
  });

  assert.equal(history.summary.total, 1);
  assert.equal(history.summary.inbound, 1);
  assert.equal(history.summary.outbound, 0);
  assert.equal(history.pagination.page, 1);
  assert.equal(history.pagination.pageSize, 1);
  assert.equal(history.items[0].content, 'CONFIRMADO');
});

test('monitor declara la limitación retroactiva en lugar de inventar mensajes no persistidos', async () => {
  const history = await loadDispatchWhatsappMonitorHistory({ prismaClient: prismaFixture() });
  assert.ok(history.limitations.some((item) => item.includes('Meta Cloud API')));
  assert.ok(history.limitations.some((item) => item.includes('evidencia persistida')));
});
