import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  loadDispatchWhatsappTomorrowAssignmentMonitor,
  loadDispatchWhatsappWindowStatusForAssignments,
  tomorrowIsoDateCO
} from '../src/services/dispatchWhatsappMonitor.js';
import { canAccessDispatchWhatsappMonitor } from '../src/routes/dispatchWhatsappNotifications.js';
import {
  DISPATCH_WINDOW_CHECK_BUTTON,
  buildDispatchWindowCheckTemplatePayload
} from '../src/services/dispatchWhatsappCloudClient.js';

const NOW = new Date('2026-08-13T00:30:00.000Z');

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
    }
  ];
}

function prismaFixture() {
  const assignments = assignmentFixture();
  const healed = [];
  return {
    healed,
    dispatchAssignment: { findMany: async (query) => {
      assert.deepEqual(query.where.status.in, ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED']);
      assert.equal(query.where.serviceRequest.source.not, 'DEV_TEST');
      return assignments;
    } },
    dispatchWhatsappContactWindow: {
      findMany: async (query) => {
        assert.equal(query.where.scope, 'operational');
        assert.deepEqual([...query.where.phone.in].sort(), ['573001112233', '573002223344', '573003334455']);
        return [
          { scope: 'operational', phone: '573001112233', lastInboundAt: new Date('2026-08-12T23:10:00.000Z') },
          { scope: 'operational', phone: '573003334455', lastInboundAt: new Date('2026-08-11T20:00:00.000Z') }
        ];
      },
      upsert: async (query) => {
        healed.push(query);
        return query.update;
      }
    },
    dispatchWhatsappConfirmation: { findMany: async (query) => {
      assert.deepEqual([...query.where.phone.in].sort(), ['573001112233', '573002223344', '573003334455']);
      assert.deepEqual(query.where.confirmationReceivedAt, { not: null });
      return [
        // Reproduce el caso real: hubo confirmación inbound, pero faltó/estuvo atrasado el registro de ventana.
        { phone: '573002223344', confirmationReceivedAt: new Date('2026-08-13T00:20:00.000Z') }
      ];
    } }
  };
}

test('fecha objetivo del monitor DEV es mañana en America/Bogota', () => {
  assert.equal(tomorrowIsoDateCO(NOW), '2026-08-13');
});

test('monitor vivo reconcilia confirmación inbound y no deja cerrado a quien ya respondió', async () => {
  const prismaClient = prismaFixture();
  const monitor = await loadDispatchWhatsappTomorrowAssignmentMonitor({ prismaClient, now: NOW });
  assert.equal(monitor.summary.total, 3);
  assert.equal(monitor.summary.open, 2);
  assert.equal(monitor.summary.closed, 1);
  assert.equal(monitor.summary.missingWindow, 1);

  const auxiliarA = monitor.items.find((item) => item.workerName === 'Auxiliar A');
  assert.equal(auxiliarA.isOpen, true);
  assert.equal(auxiliarA.evidenceSource, 'CONTACT_WINDOW');

  const auxiliarB = monitor.items.find((item) => item.workerName === 'Auxiliar B');
  assert.equal(auxiliarB.isOpen, true);
  assert.equal(auxiliarB.lastInboundAt, '2026-08-13T00:20:00.000Z');
  assert.equal(auxiliarB.evidenceSource, 'CONFIRMATION_EVIDENCE');
  assert.equal(prismaClient.healed.length, 1);
  assert.equal(prismaClient.healed[0].where.scope_phone.phone, '573002223344');

  const auxiliarC = monitor.items.find((item) => item.workerName === 'Auxiliar C');
  assert.equal(auxiliarC.isOpen, false);
  assert.equal(auxiliarC.canSendWindowCheck, true);

  // Los cerrados se muestran primero para saber quién falta.
  assert.equal(monitor.items[0].workerName, 'Auxiliar C');
});

test('estado compacto de asignaciones usa la misma autoridad viva', async () => {
  const prismaClient = prismaFixture();
  const states = await loadDispatchWhatsappWindowStatusForAssignments({
    prismaClient,
    assignments: assignmentFixture().slice(0, 2),
    now: NOW
  });
  assert.equal(states['assignment-a'].isOpen, true);
  assert.equal(states['assignment-b'].isOpen, true);
});

test('plantilla de apertura de ventana es independiente de la confirmación de asignación', () => {
  const payload = buildDispatchWindowCheckTemplatePayload({
    config: { windowCheckTemplateName: 'dispatch_window_check', templateLanguage: 'es' },
    assignmentId: 'assignment-a',
    phone: '3001112233'
  });
  assert.equal(payload.template.name, 'dispatch_window_check');
  assert.equal(payload.template.components[0].parameters[0].payload, 'dispatch_window_check:assignment-a');
  assert.equal(DISPATCH_WINDOW_CHECK_BUTTON, 'CONFIRMAR CANAL');
  assert.doesNotMatch(JSON.stringify(payload), /dispatch_confirm:/);
  assert.doesNotMatch(JSON.stringify(payload), /dispatch_novelty:/);
});

test('monitor de WhatsApp Despacho sigue siendo exclusivamente DEV', () => {
  assert.equal(canAccessDispatchWhatsappMonitor({ session: { userRole: 'dev' } }), true);
  assert.equal(canAccessDispatchWhatsappMonitor({ session: { userRole: 'admin', canAccessDispatch: true } }), false);
  assert.equal(canAccessDispatchWhatsappMonitor({ session: { userRole: 'admin', username: 'operaciones-despacho' } }), false);
});

test('UI conserva monitor separado, refresco vivo y check compacto en tarjetas', () => {
  const statusView = fs.readFileSync(new URL('../src/views/operacionesWhatsappEstado.ejs', import.meta.url), 'utf8');
  const monitorView = fs.readFileSync(new URL('../src/views/operacionesWhatsappMonitor.ejs', import.meta.url), 'utf8');
  const assignmentRoute = fs.readFileSync(new URL('../src/routes/dispatchAssignmentConfirmations.js', import.meta.url), 'utf8');
  const whatsappRoute = fs.readFileSync(new URL('../src/routes/dispatchWhatsappNotifications.js', import.meta.url), 'utf8');

  assert.match(monitorView, /href="\/admin\/monitor">Monitor bot/);
  assert.match(monitorView, /Enviar verificación a faltantes/);
  assert.match(monitorView, /window\.setInterval\(refreshMonitor, 5000\)/);
  assert.match(monitorView, /Último mensaje recibido/);
  assert.match(assignmentRoute, /assignment-wa-window-check/);
  assert.match(assignmentRoute, /ventanas-asignaciones/);
  assert.match(whatsappRoute, /monitor\/enviar-verificacion-ventana/);
  assert.match(whatsappRoute, /sendCloudWindowCheckTemplate/);
  assert.match(statusView, /Configuración activa · solo DEV/);
});
