from pathlib import Path

# Restaurar funciones operativas que no dependen de whatsapp-web.js.
ops_path = Path('src/routes/dispatchOpsExtras.js')
ops = ops_path.read_text(encoding='utf-8')
if "import { sendDispatchCompletionEmail } from '../services/dispatchCompletionEmail.js';" not in ops:
    ops = ops.replace(
        "import ExcelJS from 'exceljs';\n",
        "import ExcelJS from 'exceljs';\nimport { sendDispatchCompletionEmail } from '../services/dispatchCompletionEmail.js';\n",
        1,
    )

helper_anchor = "async function recalculateServiceRequestStatus(prisma, serviceRequestId) {\n  return recalculateDispatchServiceRequestStatus(prisma, serviceRequestId);\n}\n"
helpers = """async function recalculateServiceRequestStatus(prisma, serviceRequestId) {
  return recalculateDispatchServiceRequestStatus(prisma, serviceRequestId);
}
async function resolveActorEmail(prisma, username) {
  if (!username) return null;
  const user = await prisma.appUser.findUnique({ where: { username }, select: { email: true } });
  return normalizeString(user?.email);
}
async function notifyIfServiceRequestCompleted(prisma, serviceRequestId, actorUsername) {
  const replyTo = await resolveActorEmail(prisma, actorUsername);
  const result = await sendDispatchCompletionEmail(prisma, serviceRequestId, {
    replyTo,
    managedByUsername: actorUsername || null
  });
  if (result?.sent) return ' Solicitud completa: correo enviado al solicitante.';
  if (result?.reason === 'missing_requested_by_email') return ' Solicitud completa: no se envio correo porque no tiene correo del solicitante.';
  if (result?.reason === 'missing_email_config') return ' Solicitud completa: falta configurar correo de salida.';
  if (result?.error) return ' Solicitud completa: no fue posible enviar el correo al solicitante.';
  return '';
}
"""
if 'async function notifyIfServiceRequestCompleted(' not in ops:
    if helper_anchor not in ops:
        raise SystemExit('No se encontró el punto para restaurar helpers de confirmación manual.')
    ops = ops.replace(helper_anchor, helpers, 1)

no_confirm_anchor = "  router.post('/asignaciones/no-confirmado', requireOps, async (req, res) => {"
confirm_route = """  router.post('/asignaciones/confirmar', requireOps, async (req, res) => {
    const assignmentId = normalizeString(req.body.assignmentId);
    const serviceRequestId = normalizeString(req.body.serviceRequestId);
    if (!assignmentId || !serviceRequestId) return res.status(400).send('assignmentId y serviceRequestId son requeridos');
    const actorUsername = normalizeString(req.session?.username || req.username);
    await prisma.dispatchAssignment.update({ where: { id: assignmentId }, data: { status: 'CONFIRMED', notes: normalizeString(req.body.notes) } });
    const statusResult = await recalculateServiceRequestStatus(prisma, serviceRequestId);
    const emailMessage = statusResult?.status === 'ASSIGNMENT_COMPLETE'
      ? await notifyIfServiceRequestCompleted(prisma, serviceRequestId, actorUsername)
      : '';
    return res.redirect(redirectToAssignment(serviceRequestId, `Confirmacion registrada.${emailMessage}`));
  });
"""
if "router.post('/asignaciones/confirmar'" not in ops:
    if no_confirm_anchor not in ops:
        raise SystemExit('No se encontró el punto para restaurar /asignaciones/confirmar.')
    ops = ops.replace(no_confirm_anchor, confirm_route + no_confirm_anchor, 1)
ops_path.write_text(ops, encoding='utf-8')

# Mantener experiencia de mensajería, pero usando el endpoint Cloud API ya migrado.
view_path = Path('src/views/operacionesAsignacionesConfirmacion.ejs')
view = view_path.read_text(encoding='utf-8')
view = view.replace(
    '<strong>WhatsApp oficial de despacho</strong><p class="muted">El contenido se envía con la plantilla Utility aprobada en Meta y se completa automáticamente con los datos reales de cada asignación.</p><div class="template-actions"><button type="button" class="btn btn-primary" id="sendAllWhatsapp">Enviar plantilla a todos</button></div>',
    '<strong>Mensaje por WhatsApp</strong><p class="muted">Se envía desde la línea oficial de despacho mediante la API de Meta. El mensaje aprobado se completa automáticamente con los datos reales de cada asignación.</p><div class="template-actions"><button type="button" class="btn btn-primary" id="sendAllWhatsapp">Enviar WhatsApp a todos</button></div>',
    1,
)
view = view.replace(
    'title="Enviar plantilla oficial de WhatsApp" aria-label="Enviar plantilla oficial de WhatsApp">WA</button>',
    'title="Enviar WhatsApp" aria-label="Enviar WhatsApp">WA</button>',
)
confirm_form = '<form data-async-assignment-action="confirmar" method="post" action="/admin/operaciones/asignaciones/confirmar"><input type="hidden" name="assignmentId" value="<%= assignment.id %>" /><input type="hidden" name="serviceRequestId" value="<%= selectedServiceRequestId %>" /><button class="btn btn-primary" type="submit">Confirmar</button></form>'
no_confirm_form = '<form data-async-assignment-action="no-confirmado" method="post" action="/admin/operaciones/asignaciones/no-confirmado">'
if 'data-async-assignment-action="confirmar"' not in view:
    if no_confirm_form not in view:
        raise SystemExit('No se encontró formulario No confirmó para reinsertar Confirmar.')
    view = view.replace(no_confirm_form, confirm_form + no_confirm_form, 1)
view = view.replace(
    "const message=action==='no-confirmado'?'Auxiliar marcado como no confirmado.':'Auxiliar retirado de la solicitud.';",
    "const message=action==='confirmar'?'Confirmación registrada.':action==='no-confirmado'?'Auxiliar marcado como no confirmado.':'Auxiliar retirado de la solicitud.';",
    1,
)
view_path.write_text(view, encoding='utf-8')

# Restaurar auditoría de la confirmación manual.
audit_path = Path('src/services/dispatchAuditMiddleware.js')
audit = audit_path.read_text(encoding='utf-8')
audit_anchor = "  if (path.includes('/asignaciones/assign')) return 'DISPATCH_ASSIGNMENT_CREATE';\n"
audit_line = "  if (path.includes('/asignaciones/confirmar')) return 'DISPATCH_ASSIGNMENT_CONFIRM';\n"
if audit_line not in audit:
    if audit_anchor not in audit:
        raise SystemExit('No se encontró punto de auditoría para Confirmar.')
    audit = audit.replace(audit_anchor, audit_anchor + audit_line, 1)
audit_path.write_text(audit, encoding='utf-8')

# Ocultar acciones de confirmación una vez una tarjeta ya quedó confirmada.
compact_path = Path('src/routes/dispatchAssignmentConfirmations.js')
compact = compact_path.read_text(encoding='utf-8')
compact = compact.replace(
    "card.querySelectorAll('.whatsapp-link,.dispatch-wa-button').forEach(function(el){ el.remove(); });",
    "card.querySelectorAll('.whatsapp-link,.dispatch-wa-button,form[data-async-assignment-action=\"confirmar\"],form[data-async-assignment-action=\"no-confirmado\"]').forEach(function(el){ el.remove(); });",
    1,
)
compact = compact.replace(
    ".replace(/<button[^>]*class=\"[^\"]*(?:whatsapp-link|dispatch-wa-button)[^\"]*\"[\\s\\S]*?<\\/button>/g, '');",
    ".replace(/<button[^>]*class=\"[^\"]*(?:whatsapp-link|dispatch-wa-button)[^\"]*\"[\\s\\S]*?<\\/button>/g, '')\n    .replace(/<form[^>]*data-async-assignment-action=\"(?:confirmar|no-confirmado)\"[\\s\\S]*?<\\/form>/g, '');",
    1,
)
compact_path.write_text(compact, encoding='utf-8')

# Ajustar regresiones: proteger Cloud API, no prohibir funciones operativas.
test_path = Path('test/dispatchWhatsappCloudCutover.test.js')
test_source = test_path.read_text(encoding='utf-8')
old_test_start = "test('la confirmación operativa queda bajo autoridad del webhook oficial', () => {"
if old_test_start in test_source:
    prefix = test_source.split(old_test_start, 1)[0].rstrip() + '\n\n'
    new_test = """test('la migración conserva la confirmación operativa manual además de la confirmación por webhook', () => {
  const opsRoutes = read('src/routes/dispatchOpsExtras.js');
  const audit = read('src/services/dispatchAuditMiddleware.js');
  const webhook = read('src/services/dispatchWhatsappWebhookService.js');
  const view = read('src/views/operacionesAsignacionesConfirmacion.ejs');

  assert.match(opsRoutes, /\\/asignaciones\\/confirmar/);
  assert.match(audit, /DISPATCH_ASSIGNMENT_CONFIRM/);
  assert.match(view, /data-async-assignment-action="confirmar"/);
  assert.match(webhook, /recalculateDispatchServiceRequestStatus/);
  assert.match(webhook, /sendDispatchCompletionEmail/);
  assert.match(view, /Enviar WhatsApp a todos/);
  assert.match(view, /JSON\\.stringify\\(\\{phone,context\\}\\)/);
});
"""
    test_source = prefix + new_test

test_source = test_source.replace(
    "test('el tablero de asignaciones usa la plantilla oficial y no mensajes libres', () => {",
    "test('el tablero conserva el envío de WhatsApp y usa el transporte oficial de Meta', () => {",
)
test_source = test_source.replace(
    'assert.match(view, /Enviar plantilla a todos/);',
    'assert.match(view, /Enviar WhatsApp a todos/);',
)
test_path.write_text(test_source, encoding='utf-8')
