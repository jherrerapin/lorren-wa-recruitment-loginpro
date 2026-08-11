import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const MESSAGE = 'Hola {{nombre}}, te confirmamos asignación para {{fecha}} en {{operacion}}. Dirección: {{direccion}}. Hora de inicio: {{horaInicio}}. Servicio: {{servicio}}. Cliente: {{cliente}}. Por favor confirma recibido.';
function read(path) { return fs.readFileSync(path, 'utf8'); }

test('el dashboard conserva literalmente el mensaje actual y muestra dos respuestas rápidas', () => {
  const view = read('src/views/operacionesAsignacionesConfirmacion.ejs');
  assert.ok(view.includes(MESSAGE));
  assert.match(view, />CONFIRMADO<\/span>/);
  assert.match(view, />NO PUEDO<\/span>/);
  assert.match(view, /Enviar WhatsApp a todos/);
});

test('Cloud API prepara payloads independientes para CONFIRMADO y NO PUEDO', () => {
  const client = read('src/services/dispatchWhatsappCloudClient.js');
  assert.match(client, /index: '0'[\s\S]*dispatch_confirm:/);
  assert.match(client, /index: '1'[\s\S]*dispatch_decline:/);
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
