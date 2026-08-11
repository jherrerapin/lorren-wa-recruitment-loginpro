from pathlib import Path

MESSAGE = "Hola {{nombre}}, te confirmamos asignación para {{fecha}} en {{operacion}}. Dirección: {{direccion}}. Hora de inicio: {{horaInicio}}. Servicio: {{servicio}}. Cliente: {{cliente}}. Por favor confirma recibido."

# Dashboard: keep the current message literally unchanged and preview two reply options.
view_path = Path('src/views/operacionesAsignacionesConfirmacion.ejs')
view = view_path.read_text(encoding='utf-8')
old_card = '<% if (coverageComplete && !selectedRequestComplete) { %><section class="template-card"><strong>Mensaje por WhatsApp</strong><p class="muted">Se envía desde la línea oficial de despacho mediante la API de Meta. El mensaje aprobado se completa automáticamente con los datos reales de cada asignación.</p><div class="template-actions"><button type="button" class="btn btn-primary" id="sendAllWhatsapp">Enviar WhatsApp a todos</button></div></section><% } %>'
new_card = f'<% if (coverageComplete && !selectedRequestComplete) {{ %><section class="template-card"><strong>Mensaje por WhatsApp</strong><p class="muted">Este es el mensaje actual de asignación. Se conserva sin cambios; las dos opciones de respuesta evitan que el auxiliar tenga que escribir.</p><div class="dispatch-message-preview" id="dispatchAssignmentMessagePreview">{MESSAGE}</div><div class="dispatch-reply-preview" aria-label="Opciones de respuesta del auxiliar"><span>Respuesta del auxiliar</span><div class="dispatch-reply-options"><span class="dispatch-reply-option dispatch-reply-confirm">CONFIRMADO</span><span class="dispatch-reply-option dispatch-reply-decline">NO PUEDO</span></div></div><div class="template-actions"><button type="button" class="btn btn-primary" id="sendAllWhatsapp">Enviar WhatsApp a todos</button></div></section><% }} %>'
if old_card not in view:
    raise SystemExit('No se encontró la tarjeta actual de WhatsApp en el dashboard.')
view = view.replace(old_card, new_card, 1)
css_anchor = '.icon-email{background:var(--navy);color:#fff;border-color:var(--navy)}\n'
css_extra = '.dispatch-message-preview{width:100%;border:1px solid var(--border);border-radius:10px;padding:10px;background:#fff;color:var(--navy);font-size:12px;line-height:1.55;white-space:pre-wrap}.dispatch-reply-preview{display:grid;gap:6px;margin-top:8px}.dispatch-reply-preview>span{font-size:11px;font-weight:900;color:var(--muted);text-transform:uppercase;letter-spacing:.02em}.dispatch-reply-options{display:grid;grid-template-columns:1fr 1fr;gap:7px}.dispatch-reply-option{display:flex;align-items:center;justify-content:center;min-height:36px;border:1px solid #d8dee9;border-radius:9px;background:#fff;font-size:11px;font-weight:900;letter-spacing:.02em}.dispatch-reply-confirm{color:var(--green);border-color:#9ad9c5;background:var(--green-soft)}.dispatch-reply-decline{color:#9f1239;border-color:#fecdd3;background:#fff1f2}@media(max-width:520px){.dispatch-reply-options{grid-template-columns:1fr}}\n'
if css_extra not in view:
    if css_anchor not in view:
        raise SystemExit('No se encontró el ancla CSS del dashboard.')
    view = view.replace(css_anchor, css_anchor + css_extra, 1)
view_path.write_text(view, encoding='utf-8')

# Cloud API request: prepare the second quick-reply payload. This does not alter template body text.
client_path = Path('src/services/dispatchWhatsappCloudClient.js')
client = client_path.read_text(encoding='utf-8')
old_buttons = """        {
          type: 'button', sub_type: 'quick_reply', index: '0',
          parameters: [{ type: 'payload', payload: `dispatch_confirm:${assignment.id}` }]
        }
"""
new_buttons = """        {
          type: 'button', sub_type: 'quick_reply', index: '0',
          parameters: [{ type: 'payload', payload: `dispatch_confirm:${assignment.id}` }]
        },
        {
          type: 'button', sub_type: 'quick_reply', index: '1',
          parameters: [{ type: 'payload', payload: `dispatch_decline:${assignment.id}` }]
        }
"""
if old_buttons not in client:
    raise SystemExit('No se encontró el quick reply CONFIRMADO actual.')
client = client.replace(old_buttons, new_buttons, 1)
client_path.write_text(client, encoding='utf-8')

# Scope definitions: define the status used when the worker selects NO PUEDO.
config_path = Path('src/services/dispatchWhatsappCloudConfig.js')
config = config_path.read_text(encoding='utf-8')
config = config.replace("export const TERMINAL_LINK_STATUSES = new Set(['CONFIRMED', 'EXPIRED', 'FAILED']);", "export const TERMINAL_LINK_STATUSES = new Set(['CONFIRMED', 'DECLINED', 'EXPIRED', 'FAILED']);", 1)
config = config.replace("    confirmedAssignmentStatus: 'CONFIRMED',\n    requestSource: null,", "    confirmedAssignmentStatus: 'CONFIRMED',\n    declinedAssignmentStatus: 'NO_CONFIRMO',\n    requestSource: null,", 1)
config = config.replace("    confirmedAssignmentStatus: 'DEV_TEST_CONFIRMED',\n    requestSource: 'DEV_TEST',", "    confirmedAssignmentStatus: 'DEV_TEST_CONFIRMED',\n    declinedAssignmentStatus: 'DEV_TEST_NO_CONFIRMO',\n    requestSource: 'DEV_TEST',", 1)
config_path.write_text(config, encoding='utf-8')

# Assignment authority: record a negative reply atomically and make the slot available again.
assignment_path = Path('src/services/dispatchWhatsappAssignmentService.js')
assignment = assignment_path.read_text(encoding='utf-8')
append_decline = r'''

export async function claimDispatchAssignmentDecline({
  scope = 'operational', assignment, responseMessageId = '', responseReceivedAt = null, prismaClient = prisma
} = {}) {
  const definition = dispatchWhatsappScopeDefinition(scope);
  const evidenceMessageId = String(responseMessageId || '').trim();
  const evidenceReceivedAt = responseReceivedAt instanceof Date
    ? responseReceivedAt
    : new Date(responseReceivedAt || Number.NaN);
  if (!assignment?.id || !evidenceMessageId || Number.isNaN(evidenceReceivedAt.getTime())) {
    return { assignmentDeclined: false, duplicate: false };
  }

  return prismaClient.$transaction(async (tx) => {
    const duplicate = await tx.dispatchWhatsappConfirmation.findFirst({
      where: { confirmationMessageId: evidenceMessageId }, select: { id: true }
    });
    if (duplicate) return { assignmentDeclined: false, duplicate: true };

    const updated = await tx.dispatchAssignment.updateMany({
      where: { id: assignment.id, status: { in: definition.pendingAssignmentStatuses } },
      data: { status: definition.declinedAssignmentStatus, notes: 'El auxiliar indicó NO PUEDO desde WhatsApp.' }
    });
    if (!updated.count) return { assignmentDeclined: false, duplicate: false };

    await tx.dispatchWhatsappConfirmation.updateMany({
      where: { assignmentId: assignment.id, status: { in: INBOUND_LINK_STATUSES } },
      data: {
        status: 'DECLINED',
        confirmationMessageId: evidenceMessageId,
        confirmationReceivedAt: evidenceReceivedAt
      }
    });
    return { assignmentDeclined: true, duplicate: false };
  });
}
'''
if 'export async function claimDispatchAssignmentDecline(' not in assignment:
    assignment = assignment.rstrip() + append_decline + '\n'
assignment_path.write_text(assignment, encoding='utf-8')

# Webhook: distinguish CONFIRMADO and NO PUEDO by button payload; keep typed confirmation as fallback.
webhook_path = Path('src/services/dispatchWhatsappWebhookService.js')
webhook = webhook_path.read_text(encoding='utf-8')
webhook = webhook.replace(
    "import { claimDispatchAssignmentConfirmation } from './dispatchWhatsappAssignmentService.js';",
    "import { claimDispatchAssignmentConfirmation, claimDispatchAssignmentDecline } from './dispatchWhatsappAssignmentService.js';",
    1
)
old_payload_fn = r'''function assignmentIdFromInboundPayload(message = {}) {
  return inboundPayload(message).trim().match(/^dispatch_confirm:([A-Za-z0-9_-]+)$/)?.[1] || null;
}
'''
new_payload_fn = r'''function assignmentActionFromInboundPayload(message = {}) {
  const match = inboundPayload(message).trim().match(/^dispatch_(confirm|decline):([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  return { action: match[1] === 'decline' ? 'DECLINE' : 'CONFIRM', assignmentId: match[2] };
}

function assignmentIdFromInboundPayload(message = {}) {
  return assignmentActionFromInboundPayload(message)?.assignmentId || null;
}

function isAutomaticDeclineReply(value) {
  const text = normalizeConfirmationText(value);
  return ['no puedo', 'no puedo asistir'].includes(text);
}
'''
if old_payload_fn not in webhook:
    raise SystemExit('No se encontró el parser de payload actual.')
webhook = webhook.replace(old_payload_fn, new_payload_fn, 1)
old_process_head = r'''  const assignmentId = assignmentIdFromInboundPayload(message);
  if (!assignmentId && !isAutomaticConfirmationReply(inboundText(message))) {
    return { handled: false, reason: 'not_confirmation' };
  }
  const target = await findConfirmationTarget({ scope, message, prismaClient });
  if (!target) return { handled: false, reason: 'no_pending_assignment' };
  const confirmationMessageId = String(message.id || '').trim();
  if (!confirmationMessageId) return { handled: false, reason: 'missing_message_id' };

  const claim = await claimDispatchAssignmentConfirmation({
'''
new_process_head = r'''  const buttonAction = assignmentActionFromInboundPayload(message);
  const inbound = inboundText(message);
  const inferredAction = buttonAction?.action
    || (isAutomaticDeclineReply(inbound) ? 'DECLINE' : isAutomaticConfirmationReply(inbound) ? 'CONFIRM' : null);
  if (!inferredAction) return { handled: false, reason: 'not_assignment_response' };
  const target = await findConfirmationTarget({ scope, message, prismaClient });
  if (!target) return { handled: false, reason: 'no_pending_assignment' };
  const confirmationMessageId = String(message.id || '').trim();
  if (!confirmationMessageId) return { handled: false, reason: 'missing_message_id' };

  if (inferredAction === 'DECLINE') {
    const decline = await claimDispatchAssignmentDecline({
      scope,
      assignment: target.assignment,
      responseMessageId: confirmationMessageId,
      responseReceivedAt: inboundReceivedAt(message),
      prismaClient
    });
    if (decline.assignmentDeclined && scope === 'operational') {
      await recalculateDispatchServiceRequestStatus(prismaClient, target.assignment.serviceRequestId);
    }
    setDispatchWhatsappRuntimeState(scope, { lastInboundAt: new Date().toISOString(), lastError: null });
    console.info(`[dispatch-wa-cloud] Respuesta NO PUEDO procesada. scope=${scope} assignment=${target.assignment.id} changed=${decline.assignmentDeclined ? 'yes' : 'no'}.`);
    return { handled: decline.assignmentDeclined || decline.duplicate, duplicate: decline.duplicate, assignmentDeclined: decline.assignmentDeclined, replySent: false };
  }

  const claim = await claimDispatchAssignmentConfirmation({
'''
if old_process_head not in webhook:
    raise SystemExit('No se encontró el inicio del procesamiento inbound actual.')
webhook = webhook.replace(old_process_head, new_process_head, 1)
webhook_path.write_text(webhook, encoding='utf-8')

# Regression test: literal message + two buttons + both backend payloads.
test_path = Path('test/dispatchWhatsappQuickReplies.test.js')
test_path.write_text(f'''import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const MESSAGE = {MESSAGE!r};
function read(path) {{ return fs.readFileSync(path, 'utf8'); }}

test('el dashboard conserva literalmente el mensaje actual y muestra dos respuestas rápidas', () => {{
  const view = read('src/views/operacionesAsignacionesConfirmacion.ejs');
  assert.ok(view.includes(MESSAGE));
  assert.match(view, />CONFIRMADO<\/span>/);
  assert.match(view, />NO PUEDO<\/span>/);
  assert.match(view, /Enviar WhatsApp a todos/);
}});

test('Cloud API prepara payloads independientes para CONFIRMADO y NO PUEDO', () => {{
  const client = read('src/services/dispatchWhatsappCloudClient.js');
  assert.match(client, /index: '0'[\\s\\S]*dispatch_confirm:/);
  assert.match(client, /index: '1'[\\s\\S]*dispatch_decline:/);
}});

test('el webhook convierte NO PUEDO en rechazo operativo sin depender de texto escrito', () => {{
  const webhook = read('src/services/dispatchWhatsappWebhookService.js');
  const assignment = read('src/services/dispatchWhatsappAssignmentService.js');
  const config = read('src/services/dispatchWhatsappCloudConfig.js');
  assert.match(webhook, /dispatch_\\(confirm\\|decline\\)/);
  assert.match(webhook, /claimDispatchAssignmentDecline/);
  assert.match(assignment, /status: definition\.declinedAssignmentStatus/);
  assert.match(config, /declinedAssignmentStatus: 'NO_CONFIRMO'/);
  assert.match(config, /TERMINAL_LINK_STATUSES[\\s\\S]*'DECLINED'/);
}});
''', encoding='utf-8')
