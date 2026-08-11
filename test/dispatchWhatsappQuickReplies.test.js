import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

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
const FORBIDDEN_MESSAGE = 'Hola {{nombre}}, te confirmamos asignación para {{fecha}} en {{operacion}}. Dirección: {{direccion}}. Hora de inicio: {{horaInicio}}. Servicio: {{servicio}}. Cliente: {{cliente}}. Por favor confirma recibido.';
const FORBIDDEN_LEGACY_FRAGMENT = 'te confirmamos asignacion para {{fecha}}';
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
  assert.equal(view.includes(FORBIDDEN_MESSAGE), false);
  assert.equal(legacyView.toLowerCase().includes(FORBIDDEN_LEGACY_FRAGMENT), false);
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
