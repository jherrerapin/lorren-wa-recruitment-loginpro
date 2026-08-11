import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildDispatchAssignmentTemplatePayload } from '../src/services/dispatchWhatsappCloudClient.js';

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

test('el dashboard conserva el mensaje canónico real y muestra dos respuestas rápidas', () => {
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
  assert.match(view, />CONFIRMADO<\/span>/);
  assert.match(view, />NO PUEDO<\/span>/);
  assert.match(view, /Enviar WhatsApp a todos/);
});

test('Cloud API usa únicamente las cinco variables del mensaje canónico y dos Quick Replies', () => {
  const payload = buildDispatchAssignmentTemplatePayload({
    config: { assignmentTemplateName: 'dispatch_assignment_confirmation', templateLanguage: 'es' },
    phone: '3001234567',
    assignment: {
      id: 'assignment-test',
      worker: { fullName: 'Auxiliar Prueba' },
      serviceRequest: {
        clientName: 'CLIENTE_QUE_NO_DEBE_VIAJAR',
        operationPointName: 'Operación Prueba',
        address: 'Dirección Prueba',
        cityName: 'CIUDAD_QUE_NO_DEBE_VIAJAR',
        serviceName: 'SERVICIO_QUE_NO_DEBE_VIAJAR',
        serviceDate: '2026-08-12',
        startTime: '07:30'
      }
    }
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
    { index: '1', payload: 'dispatch_decline:assignment-test' }
  ]);
});

test('el webhook convierte NO PUEDO en rechazo operativo sin depender de texto escrito', () => {
  const webhook = read('src/services/dispatchWhatsappWebhookService.js');
  const assignment = read('src/services/dispatchWhatsappAssignmentService.js');
  const config = read('src/services/dispatchWhatsappCloudConfig.js');
  assert.match(webhook, /dispatch_\(confirm\|decline\)/);
  assert.match(webhook, /claimDispatchAssignmentDecline/);
  assert.match(assignment, /status: definition\.declinedAssignmentStatus/);
  assert.match(config, /declinedAssignmentStatus: 'NO_CONFIRMO'/);
  assert.match(config, /TERMINAL_LINK_STATUSES[\s\S]*'DECLINED'/);
});
