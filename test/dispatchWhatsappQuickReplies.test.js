import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildDispatchAssignmentInteractivePayload,
  buildDispatchAssignmentTemplatePayload
} from '../src/services/dispatchWhatsappCloudClient.js';

const CANONICAL_MESSAGE = [
  'Hola *{{nombre}}*,',
  '',
  'Mañana: *{{fecha}}*',
  'Llegar a: *{{operacion}}  - {{direccion}}*',
  'Hora : *{{horaInicio}} por favor.*',
  '',
  '',
  '*Confirmado?*'
].join('\n');
const OBSOLETE_FRAGMENTS = [
  'te confirmamos asignación para {{fecha}}',
  'te confirmamos asignacion para {{fecha}}',
  'Servicio: {{servicio}}. Cliente: {{cliente}}',
  'Por favor confirma recibido.'
];
function read(path) { return fs.readFileSync(path, 'utf8'); }

function assignmentFixture() {
  return {
    id: 'assignment-test',
    serviceRequestId: 'request-test',
    workerId: 'worker-test',
    worker: { id: 'worker-test', fullName: 'Auxiliar Prueba', phone: '3001234567' },
    serviceRequest: {
      clientName: 'CLIENTE_QUE_NO_DEBE_VIAJAR',
      operationPointName: 'Operación Prueba',
      address: 'Dirección Prueba',
      cityName: 'CIUDAD_QUE_NO_DEBE_VIAJAR',
      serviceName: 'SERVICIO_QUE_NO_DEBE_VIAJAR',
      serviceDate: '2026-08-12',
      startTime: '07:30'
    }
  };
}

test('el dashboard conserva el mensaje canónico y elimina la previsualización estática de respuestas', () => {
  const view = read('src/views/operacionesAsignacionesConfirmacion.ejs');
  const legacyView = read('src/views/operacionesAsignaciones.ejs');
  const canonicalSource = read('src/public/assignment-template-sync.js');

  assert.ok(view.includes(CANONICAL_MESSAGE));
  assert.ok(canonicalSource.includes("'Hola *{{nombre}}*,'"));
  assert.ok(canonicalSource.includes("'Mañana: *{{fecha}}*'"));
  assert.ok(canonicalSource.includes("'Llegar a: *{{operacion}}  - {{direccion}}*'"));
  assert.ok(canonicalSource.includes("'Hora : *{{horaInicio}} por favor.*'"));
  assert.ok(canonicalSource.includes("CONFIRMATION_REPLY_TEXT = '*Confirmado?*'"));
  for (const obsolete of OBSOLETE_FRAGMENTS) {
    assert.equal(view.includes(obsolete), false);
    assert.equal(legacyView.includes(obsolete), false);
  }
  assert.doesNotMatch(view, /Respuesta del auxiliar/i);
  assert.doesNotMatch(view, /NO PUEDO/i);
  assert.doesNotMatch(view, /dispatch-reply-preview/);
  assert.match(view, /El auxiliar recibe las opciones de respuesta directamente en WhatsApp/);
  assert.match(canonicalSource, /function removeAssignmentReplyPreview/);
  assert.match(canonicalSource, /querySelectorAll\?\.\('\.dispatch-reply-preview'\)/);
  assert.match(view, /Enviar WhatsApp a todos/);
});

test('mensaje interactivo usa CONFIRMADO y REPORTAR NOVEDAD', () => {
  const payload = buildDispatchAssignmentInteractivePayload({
    assignment: assignmentFixture(),
    phone: '3001234567'
  });
  assert.deepEqual(payload.interactive.action.buttons.map((button) => button.reply.title), [
    'CONFIRMADO',
    'REPORTAR NOVEDAD'
  ]);
  assert.deepEqual(payload.interactive.action.buttons.map((button) => button.reply.id), [
    'dispatch_confirm:assignment-test',
    'dispatch_novelty:assignment-test'
  ]);
});

test('Cloud API usa únicamente las cinco variables del mensaje canónico y dos Quick Replies', () => {
  const payload = buildDispatchAssignmentTemplatePayload({
    config: { assignmentTemplateName: 'dispatch_assignment_confirmation', templateLanguage: 'es' },
    phone: '3001234567',
    assignment: assignmentFixture()
  });

  const body = payload.template.components.find((component) => component.type === 'body');
  const buttons = payload.template.components.filter((component) => component.type === 'button');
  assert.deepEqual(body.parameters.map((parameter) => parameter.text), [
    'Auxiliar Prueba',
    '12/08/2026',
    'Operación Prueba',
    'Dirección Prueba',
    '7:30 AM'
  ]);
  assert.deepEqual(buttons.map((button) => ({ index: button.index, payload: button.parameters[0].payload })), [
    { index: '0', payload: 'dispatch_confirm:assignment-test' },
    { index: '1', payload: 'dispatch_novelty:assignment-test' }
  ]);
});

test('reportar novedad registra evidencia e incidente sin cambiar el estado de la asignación', async () => {
  const { claimDispatchAssignmentNovelty } = await import('../src/services/dispatchWhatsappAssignmentService.js');
  const incidents = [];
  let assignmentMutations = 0;
  const tx = {
    dispatchWhatsappConfirmation: {
      findFirst: async () => null,
      updateMany: async ({ data }) => {
        assert.equal(data.status, 'NOVELTY_REPORTED');
        assert.equal(data.confirmationMessageId, 'wamid-novelty-1');
        return { count: 1 };
      }
    },
    dispatchAssignment: {
      updateMany: async () => {
        assignmentMutations += 1;
        return { count: 1 };
      }
    },
    dispatchIncident: {
      create: async ({ data }) => {
        incidents.push(data);
        return { id: 'incident-1', ...data };
      }
    }
  };
  const prismaClient = { $transaction: async (callback) => callback(tx) };

  const result = await claimDispatchAssignmentNovelty({
    scope: 'operational',
    assignment: assignmentFixture(),
    responseMessageId: 'wamid-novelty-1',
    responseReceivedAt: new Date('2026-08-12T23:00:00.000Z'),
    prismaClient
  });

  assert.deepEqual(result, { noveltyReported: true, duplicate: false });
  assert.equal(assignmentMutations, 0);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].serviceRequestId, 'request-test');
  assert.equal(incidents[0].assignmentId, 'assignment-test');
  assert.equal(incidents[0].workerId, 'worker-test');
  assert.equal(incidents[0].type, 'WHATSAPP_NOVELTY');
  assert.equal(incidents[0].status, 'OPEN');
});

test('el webhook convierte Reportar novedad en alerta sin rechazar la asignación', () => {
  const webhook = read('src/services/dispatchWhatsappWebhookService.js');
  const assignment = read('src/services/dispatchWhatsappAssignmentService.js');
  const config = read('src/services/dispatchWhatsappCloudConfig.js');
  assert.match(webhook, /dispatch_\(confirm\|novelty\|decline\)/);
  assert.match(webhook, /claimDispatchAssignmentNovelty/);
  assert.match(webhook, /sendDispatchNoveltyAdminAlert/);
  assert.match(assignment, /status: 'NOVELTY_REPORTED'/);
  assert.match(assignment, /type: 'WHATSAPP_NOVELTY'/);
  assert.match(config, /INBOUND_LINK_STATUSES[\s\S]*'NOVELTY_REPORTED'/);
  assert.match(config, /ACTIVE_LINK_STATUSES[\s\S]*'NOVELTY_REPORTED'/);
});
