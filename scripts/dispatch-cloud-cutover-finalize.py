from pathlib import Path
import re


ops_path = Path('src/routes/dispatchOpsExtras.js')
ops = ops_path.read_text(encoding='utf-8')
original_ops = ops
ops = ops.replace("const TEMPLATE_KEY = 'DISPATCH_ASSIGNMENT_WHATSAPP';\n", '')
ops = ops.replace("const DEFAULT_ASSIGNMENT_TEMPLATE = 'Hola {{nombre}}, te confirmamos asignacion para {{fecha}} en {{operacion}}. Direccion: {{direccion}}. Horario: {{horaInicio}} - {{horaFin}}. Servicio: {{servicio}}. Cliente: {{cliente}}. Por favor confirma recibido.';\n", '')
ops = re.sub(r"async function getTemplate\(prisma\) \{[^\n]*\}\n", '', ops, count=1)
ops, confirm_count = re.subn(
    r"\n  router\.post\('/asignaciones/confirmar', requireOps, async \(req, res\) => \{[\s\S]*?\n  \}\);(?=\n  router\.post\('/asignaciones/no-confirmado')",
    '',
    ops,
    count=1
)
if confirm_count != 1:
    raise SystemExit('No se encontró exactamente una ruta manual /asignaciones/confirmar para retirar.')
ops = re.sub(r"\n  router\.get\('/api/asignacion-template',[^\n]*\);", '', ops, count=1)
ops = re.sub(r"\n  router\.post\('/asignaciones/template',[^\n]*\);", '', ops, count=1)
for token in [
    'DISPATCH_ASSIGNMENT_WHATSAPP',
    'DEFAULT_ASSIGNMENT_TEMPLATE',
    "'/asignaciones/confirmar'",
    "'/api/asignacion-template'",
    "'/asignaciones/template'",
    'prisma.dispatchMessageTemplate'
]:
    if token in ops:
        raise SystemExit(f'Quedó autoridad antigua en dispatchOpsExtras: {token}')
if ops == original_ops:
    raise SystemExit('dispatchOpsExtras no cambió.')
ops_path.write_text(ops, encoding='utf-8')


view_path = Path('src/views/operacionesAsignacionesConfirmacion.ejs')
view = view_path.read_text(encoding='utf-8')
original_view = view
view, form_count = re.subn(
    r'<form data-async-assignment-action="confirmar"[\s\S]*?</form>',
    '',
    view,
    count=1
)
if form_count != 1:
    raise SystemExit('No se encontró exactamente un formulario manual de confirmación en el tablero.')
view = view.replace(
    "const message=action==='confirmar'?'Confirmación registrada.':action==='no-confirmado'?'Auxiliar marcado como no confirmado.':'Auxiliar retirado de la solicitud.';",
    "const message=action==='no-confirmado'?'Auxiliar marcado como no confirmado.':'Auxiliar retirado de la solicitud.';"
)
view = view.replace(
    "showToast('No hay mensajes individuales para enviar.');",
    "showToast('No hay asignaciones con WhatsApp disponibles para enviar.');"
)
for token in [
    '/asignaciones/confirmar',
    'data-async-assignment-action="confirmar"',
    "action==='confirmar'",
    'Mensaje base para WhatsApp',
    'assignment-message',
    'globalTemplate',
    'waMessage'
]:
    if token in view:
        raise SystemExit(f'Quedó control antiguo en el tablero: {token}')
if view == original_view:
    raise SystemExit('El tablero no cambió.')
view_path.write_text(view, encoding='utf-8')


audit_path = Path('src/services/dispatchAuditMiddleware.js')
audit = audit_path.read_text(encoding='utf-8')
audit = audit.replace("  if (path.includes('/asignaciones/confirmar')) return 'DISPATCH_ASSIGNMENT_CONFIRM';\n", '')
if '/asignaciones/confirmar' in audit or 'DISPATCH_ASSIGNMENT_CONFIRM' in audit:
    raise SystemExit('Quedó auditoría de la ruta manual de confirmación retirada.')
audit_path.write_text(audit, encoding='utf-8')


webhook_path = Path('src/services/dispatchWhatsappWebhookService.js')
webhook = webhook_path.read_text(encoding='utf-8')
if "import { sendDispatchCompletionEmail } from './dispatchCompletionEmail.js';" not in webhook:
    webhook = webhook.replace(
        "import { prisma } from '../lib/prisma.js';\n",
        "import { prisma } from '../lib/prisma.js';\nimport { sendDispatchCompletionEmail } from './dispatchCompletionEmail.js';\n"
    )
old_recalc = "  if (claim.assignmentConfirmed && scope === 'operational') {\n    await recalculateDispatchServiceRequestStatus(prismaClient, target.assignment.serviceRequestId);\n  }"
new_recalc = "  if (claim.assignmentConfirmed && scope === 'operational') {\n    const statusResult = await recalculateDispatchServiceRequestStatus(prismaClient, target.assignment.serviceRequestId);\n    if (statusResult?.status === 'ASSIGNMENT_COMPLETE') {\n      const completionEmail = await sendDispatchCompletionEmail(prismaClient, target.assignment.serviceRequestId);\n      if (completionEmail?.error) {\n        console.warn(`[dispatch-wa-cloud] Asignación completa, pero falló el correo de cierre. assignment=${target.assignment.id}.`);\n      }\n    }\n  }"
if old_recalc not in webhook:
    raise SystemExit('No se encontró el bloque esperado de recálculo del webhook.')
webhook = webhook.replace(old_recalc, new_recalc)
webhook_path.write_text(webhook, encoding='utf-8')


confirmation_view_path = Path('src/routes/dispatchAssignmentConfirmations.js')
confirmation_view = confirmation_view_path.read_text(encoding='utf-8')
confirmation_view = confirmation_view.replace(
    '.assignment-message,${FINAL_ASSIGNMENT_CARD_SELECTOR} .whatsapp-link,',
    '${FINAL_ASSIGNMENT_CARD_SELECTOR} .whatsapp-link,'
)
confirmation_view = confirmation_view.replace(
    "'.whatsapp-link,.dispatch-wa-button,.assignment-message,form[data-async-assignment-action=\"confirmar\"],form[data-async-assignment-action=\"no-confirmado\"]'",
    "'.whatsapp-link,.dispatch-wa-button'"
)
confirmation_view = confirmation_view.replace(
    "    .replace(/<textarea\\s+class=\"assignment-message\"[\\s\\S]*?<\\/textarea>/g, '')\n    .replace(/<form[^>]*data-async-assignment-action=\"(?:confirmar|no-confirmado)\"[\\s\\S]*?<\\/form>/g, '');",
    '    ;'
)
confirmation_view_path.write_text(confirmation_view, encoding='utf-8')


test_path = Path('test/dispatchWhatsappCloudCutover.test.js')
test_source = test_path.read_text(encoding='utf-8')
if 'la confirmación operativa queda bajo autoridad del webhook oficial' not in test_source:
    test_source += '''

test('la confirmación operativa queda bajo autoridad del webhook oficial', () => {
  const opsRoutes = read('src/routes/dispatchOpsExtras.js');
  const audit = read('src/services/dispatchAuditMiddleware.js');
  const webhook = read('src/services/dispatchWhatsappWebhookService.js');
  const view = read('src/views/operacionesAsignacionesConfirmacion.ejs');

  assert.doesNotMatch(opsRoutes, /DISPATCH_ASSIGNMENT_WHATSAPP|DEFAULT_ASSIGNMENT_TEMPLATE|dispatchMessageTemplate/);
  assert.doesNotMatch(opsRoutes, /\\/asignaciones\\/confirmar|\\/api\\/asignacion-template|\\/asignaciones\\/template/);
  assert.doesNotMatch(audit, /\\/asignaciones\\/confirmar|DISPATCH_ASSIGNMENT_CONFIRM/);
  assert.doesNotMatch(view, /data-async-assignment-action="confirmar"|\\/asignaciones\\/confirmar/);
  assert.match(webhook, /recalculateDispatchServiceRequestStatus/);
  assert.match(webhook, /sendDispatchCompletionEmail/);
  assert.match(view, /data-async-assignment-action="no-confirmado"/);
});
'''
test_path.write_text(test_source, encoding='utf-8')
