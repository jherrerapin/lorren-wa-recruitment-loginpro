import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  loadDispatchWhatsappTomorrowAssignmentMonitor,
  loadDispatchWhatsappWindowStatusForAssignments,
  tomorrowIsoDateCO
} from '../src/services/dispatchWhatsappMonitor.js';
import { canAccessDispatchWhatsappMonitor } from '../src/routes/dispatchWhatsappNotifications.js';

const NOW = new Date('2026-08-13T00:30:00.000Z'); // 12/08/2026 19:30 en Bogotá.

function assignmentFixture() {
  return [
    {
      id: 'assignment-a', serviceRequestId: 'request-a', workerId: 'worker-a', status: 'ASSIGNED', createdAt: new Date('2026-08-12T20:00:00.000Z'),
      worker: { id: 'worker-a', fullName: 'Auxiliar A', phone: '3001112233' },
      serviceRequest: { id: 'request-a', source: 'MANUAL', operationPointName: 'Operación A', serviceDate: new Date('2026-08-13T00:00:00.000Z'), startTime: '07:00', address: 'Dirección A' }
    },
    {
      id: 'assignment-b', serviceRequestId: 'request-b', workerId: 'worker-b', status: 'CONFIRMATION_PENDING', createdAt: new Date('2026-08-12T20:10:00.000Z'),
      worker: { id: 'worker-b', fullName: 'Auxiliar B', phone: '3002223344' },
      serviceRequest: { id: 'request-b', source: 'MANUAL', operationPointName: 'Operación B', serviceDate: new Date('2026-08-13T00:00:00.000Z'), startTime: '08:00', address: 'Dirección B' }
    },
    {
      id: 'assignment-c', serviceRequestId: 'request-c', workerId: 'worker-c', status: 'CONFIRMED', createdAt: new Date('2026-08-12T20:20:00.000Z'),
      worker: { id: 'worker-c', fullName: 'Auxiliar C', phone: '3003334455' },
      serviceRequest: { id: 'request-c', source: 'MANUAL', operationPointName: 'Operación C', serviceDate: new Date('2026-08-13T00:00:00.000Z'), startTime: '09:00', address: 'Dirección C' }
    },
    {
      id: 'assignment-next-day', serviceRequestId: 'request-next-day', workerId: 'worker-next-day', status: 'ASSIGNED', createdAt: new Date('2026-08-12T20:30:00.000Z'),
      worker: { id: 'worker-next-day', fullName: 'Auxiliar Otro Día', phone: '3004445566' },
      serviceRequest: { id: 'request-next-day', source: 'MANUAL', operationPointName: 'Operación Otro Día', serviceDate: new Date('2026-08-14T00:00:00.000Z'), startTime: '10:00', address: 'Dirección D' }
    }
  ];
}

function prismaFixture() {
  const assignments = assignmentFixture();
  const windows = [
    { id: 'window-a', scope: 'operational', phone: '573001112233', lastInboundAt: new Date('2026-08-12T23:10:00.000Z') },
    { id: 'window-c', scope: 'operational', phone: '573003334455', lastInboundAt: new Date('2026-08-11T20:00:00.000Z') }
  ];
  const links = [
    { id: 'link-a', assignmentId: 'assignment-a', status: 'SENT', createdAt: new Date('2026-08-12T22:50:00.000Z') },
    { id: 'link-b-old', assignmentId: 'assignment-b', status: 'SENT', createdAt: new Date('2026-08-12T21:00:00.000Z') },
    { id: 'link-b-new', assignmentId: 'assignment-b', status: 'READ', createdAt: new Date('2026-08-12T23:00:00.000Z') }
  ];
  return {
    dispatchAssignment: { findMany: async (query) => {
      assert.deepEqual(query.where.status.in, ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED']);
      assert.equal(query.where.serviceRequest.source.not, 'DEV_TEST');
      assert.equal(query.where.serviceRequest.serviceDate.gte.toISOString(), '2026-08-13T00:00:00.000Z');
      return assignments;
    } },
    dispatchWhatsappContactWindow: { findMany: async (query) => {
      assert.equal(query.where.scope, 'operational');
      assert.deepEqual([...query.where.phone.in].sort(), ['573001112233', '573002223344', '573003334455']);
      return windows;
    } },
    dispatchWhatsappConfirmation: { findMany: async (query) => {
      assert.deepEqual([...query.where.assignmentId.in].sort(), ['assignment-a', 'assignment-b', 'assignment-c']);
      return links;
    } }
  };
}

test('fecha objetivo del monitor DEV es mañana en America/Bogota', () => {
  assert.equal(tomorrowIsoDateCO(NOW), '2026-08-13');
});

test('monitor DEV lista solo los asignados de mañana y calcula ventana actual desde último inbound', async () => {
  const monitor = await loadDispatchWhatsappTomorrowAssignmentMonitor({ prismaClient: prismaFixture(), now: NOW });
  assert.equal(monitor.dateKey, '2026-08-13');
  assert.equal(monitor.summary.total, 3);
  assert.equal(monitor.items.some((item) => item.workerName === 'Auxiliar Otro Día'), false);
  assert.equal(monitor.summary.open, 1);
  assert.equal(monitor.summary.closed, 2);
  assert.equal(monitor.summary.confirmed, 1);
  assert.equal(monitor.summary.pendingConfirmation, 2);

  const auxiliarA = monitor.items.find((item) => item.workerName === 'Auxiliar A');
  assert.equal(auxiliarA.windowStatus, 'ABIERTA');
  assert.equal(auxiliarA.canSendManualMessage, true);
  assert.equal(auxiliarA.canSendConfirmation, true);
  assert.equal(auxiliarA.deliveryModeHint, 'SESSION_INTERACTIVE');
  assert.equal(auxiliarA.expiresAt, '2026-08-13T23:10:00.000Z');

  const auxiliarB = monitor.items.find((item) => item.workerName === 'Auxiliar B');
  assert.equal(auxiliarB.windowStatus, 'CERRADA');
  assert.equal(auxiliarB.canSendManualMessage, false);
  assert.equal(auxiliarB.canSendConfirmation, true);
  assert.equal(auxiliarB.deliveryModeHint, 'TEMPLATE_REQUIRED');
  assert.equal(auxiliarB.lastConfirmationStatus, 'READ');

  const auxiliarC = monitor.items.find((item) => item.workerName === 'Auxiliar C');
  assert.equal(auxiliarC.windowStatus, 'CERRADA');
  assert.equal(auxiliarC.confirmed, true);
  assert.equal(auxiliarC.canSendConfirmation, false);
});

test('estado compacto por asignación usa la misma regla de 24 horas', async () => {
  const assignments = assignmentFixture().slice(0, 2);
  const prismaClient = {
    dispatchWhatsappContactWindow: { findMany: async () => [
      { scope: 'operational', phone: '573001112233', lastInboundAt: new Date('2026-08-12T23:10:00.000Z') }
    ] }
  };
  const states = await loadDispatchWhatsappWindowStatusForAssignments({ prismaClient, assignments, now: NOW });
  assert.equal(states['assignment-a'].isOpen, true);
  assert.equal(states['assignment-b'].isOpen, false);
});

test('monitor de WhatsApp Despacho sigue siendo exclusivamente DEV', () => {
  assert.equal(canAccessDispatchWhatsappMonitor({ session: { userRole: 'dev' } }), true);
  assert.equal(canAccessDispatchWhatsappMonitor({ session: { userRole: 'admin', canAccessDispatch: true } }), false);
  assert.equal(canAccessDispatchWhatsappMonitor({ session: { userRole: 'admin', username: 'operaciones-despacho' } }), false);
});

test('UI conserva separación, envío DEV y check compacto en tarjetas', () => {
  const statusView = fs.readFileSync(new URL('../src/views/operacionesWhatsappEstado.ejs', import.meta.url), 'utf8');
  const monitorView = fs.readFileSync(new URL('../src/views/operacionesWhatsappMonitor.ejs', import.meta.url), 'utf8');
  const assignmentRoute = fs.readFileSync(new URL('../src/routes/dispatchAssignmentConfirmations.js', import.meta.url), 'utf8');
  const whatsappRoute = fs.readFileSync(new URL('../src/routes/dispatchWhatsappNotifications.js', import.meta.url), 'utf8');

  assert.match(monitorView, /href="\/admin\/monitor">Monitor bot/);
  assert.match(monitorView, /Enviar confirmación a pendientes/);
  assert.match(monitorView, /manual-message-button/);
  assert.match(assignmentRoute, /assignment-wa-window-check/);
  assert.match(assignmentRoute, /ventanas-asignaciones/);
  assert.match(whatsappRoute, /monitor\/enviar-confirmaciones-manana/);
  assert.match(whatsappRoute, /monitor\/mensaje/);
  assert.match(statusView, /Configuración activa · solo DEV/);
  assert.match(statusView, /if \(isDevView\)/);
});
