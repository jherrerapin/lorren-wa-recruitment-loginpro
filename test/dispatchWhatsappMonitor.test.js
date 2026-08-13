import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadDispatchWhatsappTodayWindowMonitor } from '../src/services/dispatchWhatsappMonitor.js';
import { canAccessDispatchWhatsappMonitor } from '../src/routes/dispatchWhatsappNotifications.js';

const NOW = new Date('2026-08-13T00:30:00.000Z'); // 12/08/2026 19:30 en Bogotá.

function prismaFixture() {
  const links = [
    {
      id: 'link-a', phone: '3001112233', providerMessageId: 'wamid.a', confirmationMessageId: 'wamid.in.a',
      confirmationReceivedAt: new Date('2026-08-12T23:10:00.000Z'), status: 'CONFIRMED',
      createdAt: new Date('2026-08-12T22:50:00.000Z'), serviceRequestId: 'request-a',
      assignment: { id: 'assignment-a', serviceRequestId: 'request-a', worker: { id: 'worker-a', fullName: 'Auxiliar A', phone: '3001112233' }, serviceRequest: { source: 'INTERNAL' } }
    },
    {
      id: 'link-b', phone: '3002223344', providerMessageId: 'wamid.b', confirmationMessageId: null,
      confirmationReceivedAt: null, status: 'READ', createdAt: new Date('2026-08-12T23:00:00.000Z'), serviceRequestId: 'request-b',
      assignment: { id: 'assignment-b', serviceRequestId: 'request-b', worker: { id: 'worker-b', fullName: 'Auxiliar B', phone: '3002223344' }, serviceRequest: { source: 'INTERNAL' } }
    },
    {
      id: 'link-c', phone: '3003334455', providerMessageId: 'wamid.c', confirmationMessageId: null,
      confirmationReceivedAt: null, status: 'SENT', createdAt: new Date('2026-08-12T23:15:00.000Z'), serviceRequestId: 'request-c',
      assignment: { id: 'assignment-c', serviceRequestId: 'request-c', worker: { id: 'worker-c', fullName: 'Auxiliar C', phone: '3003334455' }, serviceRequest: { source: 'INTERNAL' } }
    },
    {
      id: 'link-dev', phone: '3009990000', providerMessageId: 'wamid.dev', status: 'SENT', createdAt: new Date('2026-08-12T23:05:00.000Z'),
      assignment: { id: 'assignment-dev', worker: { id: 'worker-dev', fullName: 'Auxiliar DEV', phone: '3009990000' }, serviceRequest: { source: 'DEV_TEST' } }
    }
  ];
  const windows = [
    { id: 'window-a', scope: 'operational', phone: '573001112233', lastInboundAt: new Date('2026-08-12T23:10:00.000Z') },
    // Hubo inbound hoy, pero fue ANTES del envío actual; no debe contarse como apertura de esta línea/mensaje.
    { id: 'window-b', scope: 'operational', phone: '573002223344', lastInboundAt: new Date('2026-08-12T22:40:00.000Z') },
    // Inbound posterior al envío de C: sí abre la ventana.
    { id: 'window-c', scope: 'operational', phone: '573003334455', lastInboundAt: new Date('2026-08-12T23:20:00.000Z') }
  ];
  return {
    dispatchWhatsappContactWindow: { findMany: async (query) => {
      assert.equal(query.where.scope, 'operational');
      assert.equal(query.where.lastInboundAt.gte.toISOString(), '2026-08-12T05:00:00.000Z');
      assert.equal(query.where.lastInboundAt.lte.toISOString(), '2026-08-13T04:59:59.999Z');
      return windows;
    } },
    dispatchWhatsappConfirmation: { findMany: async (query) => {
      assert.equal(query.where.createdAt.gte.toISOString(), '2026-08-12T05:00:00.000Z');
      assert.equal(query.where.createdAt.lte.toISOString(), '2026-08-13T04:59:59.999Z');
      return links;
    } }
  };
}

test('monitor de Despacho muestra solo enviados de hoy y cuenta apertura solo tras el envío', async () => {
  const monitor = await loadDispatchWhatsappTodayWindowMonitor({ prismaClient: prismaFixture(), now: NOW });
  assert.equal(monitor.dateKey, '2026-08-12');
  assert.equal(monitor.summary.total, 3);
  assert.equal(monitor.summary.open, 2);
  assert.equal(monitor.summary.notOpened, 1);
  assert.equal(monitor.summary.assignmentsSentToday, 3);
  assert.equal(monitor.items.some((item) => item.phone === '573009990000'), false);

  const auxiliarA = monitor.items.find((item) => item.workerName === 'Auxiliar A');
  assert.equal(auxiliarA.windowStatus, 'ABIERTA');
  assert.equal(auxiliarA.lastInboundAt, '2026-08-12T23:10:00.000Z');
  assert.equal(auxiliarA.expiresAt, '2026-08-13T23:10:00.000Z');

  const auxiliarB = monitor.items.find((item) => item.workerName === 'Auxiliar B');
  assert.equal(auxiliarB.windowStatus, 'NO_ABIERTA');
  assert.equal(auxiliarB.lastInboundAt, null);

  const auxiliarC = monitor.items.find((item) => item.workerName === 'Auxiliar C');
  assert.equal(auxiliarC.windowStatus, 'ABIERTA');
  assert.equal(auxiliarC.lastInboundAt, '2026-08-12T23:20:00.000Z');
});

test('monitor de ventanas 24 h es exclusivamente DEV aunque el usuario tenga acceso a Despacho', () => {
  assert.equal(canAccessDispatchWhatsappMonitor({ session: { userRole: 'dev' } }), true);
  assert.equal(canAccessDispatchWhatsappMonitor({ session: { userRole: 'admin', canAccessDispatch: true } }), false);
  assert.equal(canAccessDispatchWhatsappMonitor({ session: { userRole: 'admin', username: 'operaciones-despacho' } }), false);
});

test('monitor del bot y monitor de ventanas de Despacho conservan rutas separadas', () => {
  const statusView = fs.readFileSync(new URL('../src/views/operacionesWhatsappEstado.ejs', import.meta.url), 'utf8');
  const windowView = fs.readFileSync(new URL('../src/views/operacionesWhatsappMonitor.ejs', import.meta.url), 'utf8');
  assert.match(statusView, /href="\/admin\/monitor">Monitor bot/);
  assert.match(statusView, /Ventanas 24 h · DEV/);
  assert.match(windowView, /href="\/admin\/monitor">Monitor bot/);
  assert.match(windowView, /Ventanas 24 h Despacho/);
});
