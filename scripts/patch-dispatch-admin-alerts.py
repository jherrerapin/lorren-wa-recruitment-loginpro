from pathlib import Path

ROOT = Path('.')

def read(path):
    return (ROOT / path).read_text(encoding='utf-8')

def write(path, content):
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding='utf-8')

def replace_once(path, old, new):
    content = read(path)
    if old not in content:
        raise SystemExit(f'Pattern not found in {path}: {old[:120]!r}')
    if content.count(old) != 1:
        raise SystemExit(f'Pattern is not unique in {path}: count={content.count(old)} {old[:120]!r}')
    write(path, content.replace(old, new, 1))

# 1) Prisma: user-level alert settings, owner on confirmation and persistent contact-window/reminder state.
replace_once('prisma/schema.prisma',
'''  recoveryPhone       String?\n  recoveryEmail       String?\n  createdByUsername   String?''',
'''  recoveryPhone       String?\n  recoveryEmail       String?\n  dispatchAlertPhone  String?\n  dispatchWindowExpiryReminderEnabled Boolean @default(false)\n  createdByUsername   String?''')

replace_once('prisma/schema.prisma',
'''  serviceRequestId  String?\n  phone             String?\n  chatId            String?''',
'''  serviceRequestId  String?\n  phone             String?\n  alertOwnerUsername String?\n  chatId            String?''')

replace_once('prisma/schema.prisma',
'''  @@index([providerMessageId])\n  @@index([status, confirmationReceivedAt], map: "DispatchWaConfirmation_reply_evidence_idx")\n}\n\nmodel DispatchIncident {''',
'''  @@index([providerMessageId])\n  @@index([alertOwnerUsername])\n  @@index([status, confirmationReceivedAt], map: "DispatchWaConfirmation_reply_evidence_idx")\n}\n\nmodel DispatchWhatsappContactWindow {\n  id            String   @id @default(cuid())\n  scope         String\n  phone         String\n  lastInboundAt DateTime\n  createdAt     DateTime @default(now())\n  updatedAt     DateTime @updatedAt\n\n  @@unique([scope, phone])\n  @@index([lastInboundAt])\n}\n\nmodel DispatchWhatsappWindowReminder {\n  id              String    @id @default(cuid())\n  scope           String\n  phone           String\n  appUserId       String\n  windowStartedAt DateTime\n  status          String    @default("PENDING")\n  sentAt          DateTime?\n  lastError       String?\n  createdAt       DateTime  @default(now())\n  updatedAt       DateTime  @updatedAt\n\n  @@unique([scope, phone, appUserId, windowStartedAt])\n  @@index([status, windowStartedAt])\n  @@index([appUserId, createdAt])\n}\n\nmodel DispatchIncident {''')

migration = '''ALTER TABLE "AppUser"\n  ADD COLUMN "dispatchAlertPhone" TEXT,\n  ADD COLUMN "dispatchWindowExpiryReminderEnabled" BOOLEAN NOT NULL DEFAULT false;\n\nALTER TABLE "DispatchWhatsappConfirmation"\n  ADD COLUMN "alertOwnerUsername" TEXT;\n\nCREATE INDEX "DispatchWhatsappConfirmation_alertOwnerUsername_idx"\n  ON "DispatchWhatsappConfirmation"("alertOwnerUsername");\n\nCREATE TABLE "DispatchWhatsappContactWindow" (\n  "id" TEXT NOT NULL,\n  "scope" TEXT NOT NULL,\n  "phone" TEXT NOT NULL,\n  "lastInboundAt" TIMESTAMP(3) NOT NULL,\n  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  "updatedAt" TIMESTAMP(3) NOT NULL,\n  CONSTRAINT "DispatchWhatsappContactWindow_pkey" PRIMARY KEY ("id")\n);\n\nCREATE UNIQUE INDEX "DispatchWhatsappContactWindow_scope_phone_key"\n  ON "DispatchWhatsappContactWindow"("scope", "phone");\nCREATE INDEX "DispatchWhatsappContactWindow_lastInboundAt_idx"\n  ON "DispatchWhatsappContactWindow"("lastInboundAt");\n\nCREATE TABLE "DispatchWhatsappWindowReminder" (\n  "id" TEXT NOT NULL,\n  "scope" TEXT NOT NULL,\n  "phone" TEXT NOT NULL,\n  "appUserId" TEXT NOT NULL,\n  "windowStartedAt" TIMESTAMP(3) NOT NULL,\n  "status" TEXT NOT NULL DEFAULT 'PENDING',\n  "sentAt" TIMESTAMP(3),\n  "lastError" TEXT,\n  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  "updatedAt" TIMESTAMP(3) NOT NULL,\n  CONSTRAINT "DispatchWhatsappWindowReminder_pkey" PRIMARY KEY ("id")\n);\n\nCREATE UNIQUE INDEX "DispatchWhatsappWindowReminder_scope_phone_appUserId_windowStartedAt_key"\n  ON "DispatchWhatsappWindowReminder"("scope", "phone", "appUserId", "windowStartedAt");\nCREATE INDEX "DispatchWhatsappWindowReminder_status_windowStartedAt_idx"\n  ON "DispatchWhatsappWindowReminder"("status", "windowStartedAt");\nCREATE INDEX "DispatchWhatsappWindowReminder_appUserId_createdAt_idx"\n  ON "DispatchWhatsappWindowReminder"("appUserId", "createdAt");\n'''
write('prisma/migrations/20260811232500_add_dispatch_whatsapp_admin_alerts/migration.sql', migration)

# 2) User creation: dedicated dispatch alert phone + opt-in reminder checkbox.
replace_once('src/routes/admin.js',
'''function normalizeString(value) {\n  if (typeof value !== 'string') return null;\n  const trimmed = value.trim();\n  return trimmed.length ? trimmed : null;\n}\n''',
'''function normalizeString(value) {\n  if (typeof value !== 'string') return null;\n  const trimmed = value.trim();\n  return trimmed.length ? trimmed : null;\n}\n\nfunction normalizeDispatchAlertPhoneInput(value) {\n  const digits = String(value || '').replace(/\\D+/g, '');\n  if (!digits) return null;\n  const local = digits.startsWith('57') && digits.length === 12 ? digits.slice(2) : digits;\n  return /^3\\d{9}$/.test(local) ? `57${local}` : null;\n}\n''')

replace_once('src/routes/admin.js',
'''    const canAccessMetaAds = req.userRole === 'dev' && req.body.canAccessMetaAds === 'true';\n    const canAccessCvAnalysis = req.userRole === 'dev' && req.body.canAccessCvAnalysis === 'true';\n    const scopeResolution = await resolveRequestedUserScope(prisma, req, req.body);''',
'''    const canAccessMetaAds = req.userRole === 'dev' && req.body.canAccessMetaAds === 'true';\n    const canAccessCvAnalysis = req.userRole === 'dev' && req.body.canAccessCvAnalysis === 'true';\n    const dispatchAlertPhoneRaw = normalizeString(req.body.dispatchAlertPhone);\n    const dispatchAlertPhone = normalizeDispatchAlertPhoneInput(dispatchAlertPhoneRaw);\n    const dispatchWindowExpiryReminderEnabled = req.body.dispatchWindowExpiryReminderEnabled === 'true';\n    if (dispatchAlertPhoneRaw && !dispatchAlertPhone) {\n      return res.redirect('/admin/users?error=' + encodeURIComponent('El WhatsApp de alertas debe ser un celular colombiano válido.'));\n    }\n    if (dispatchWindowExpiryReminderEnabled && !dispatchAlertPhone) {\n      return res.redirect('/admin/users?error=' + encodeURIComponent('Configura el WhatsApp de alertas antes de activar el recordatorio de ventana.'));\n    }\n    const scopeResolution = await resolveRequestedUserScope(prisma, req, req.body);''')

replace_once('src/routes/admin.js',
'''        recoveryPhone: normalizeString(req.body.recoveryPhone),\n        recoveryEmail: normalizeString(req.body.recoveryEmail),\n        createdByUsername: req.username || req.userRole || 'system',''',
'''        recoveryPhone: normalizeString(req.body.recoveryPhone),\n        recoveryEmail: normalizeString(req.body.recoveryEmail),\n        dispatchAlertPhone,\n        dispatchWindowExpiryReminderEnabled,\n        createdByUsername: req.username || req.userRole || 'system',''')

# 3) User editing route.
replace_once('src/routes/locations.js',
'''function normalize(value) {\n  const text = typeof value === 'string' ? value.trim() : '';\n  return text.length ? text : null;\n}\n''',
'''function normalize(value) {\n  const text = typeof value === 'string' ? value.trim() : '';\n  return text.length ? text : null;\n}\n\nfunction normalizeDispatchAlertPhoneInput(value) {\n  const digits = String(value || '').replace(/\\D+/g, '');\n  if (!digits) return null;\n  const local = digits.startsWith('57') && digits.length === 12 ? digits.slice(2) : digits;\n  return /^3\\d{9}$/.test(local) ? `57${local}` : null;\n}\n''')

replace_once('src/routes/locations.js',
'''    const data = {\n      accessScope: accessUpdate.accessScope,\n      scopeCity: accessUpdate.scopeCity,\n      scopeVacancyId: accessUpdate.scopeVacancyId,\n      recoveryPhone: normalize(req.body.recoveryPhone),\n      recoveryEmail: normalize(req.body.recoveryEmail)\n    };''',
'''    const dispatchAlertPhoneRaw = normalize(req.body.dispatchAlertPhone);\n    const dispatchAlertPhone = normalizeDispatchAlertPhoneInput(dispatchAlertPhoneRaw);\n    const dispatchWindowExpiryReminderEnabled = isChecked(req.body.dispatchWindowExpiryReminderEnabled);\n    if (dispatchAlertPhoneRaw && !dispatchAlertPhone) {\n      return res.redirect(usersRedirect('error', 'El WhatsApp de alertas debe ser un celular colombiano válido.', user.username));\n    }\n    if (dispatchWindowExpiryReminderEnabled && !dispatchAlertPhone) {\n      return res.redirect(usersRedirect('error', 'Configura el WhatsApp de alertas antes de activar el recordatorio de ventana.', user.username));\n    }\n\n    const data = {\n      accessScope: accessUpdate.accessScope,\n      scopeCity: accessUpdate.scopeCity,\n      scopeVacancyId: accessUpdate.scopeVacancyId,\n      recoveryPhone: normalize(req.body.recoveryPhone),\n      recoveryEmail: normalize(req.body.recoveryEmail),\n      dispatchAlertPhone,\n      dispatchWindowExpiryReminderEnabled\n    };''')

# 4) User dashboard fields.
replace_once('src/views/users.ejs',
'''        </div>\n        <div class="form-section">\n          <h3 class="form-section-title">Alcance inicial de reclutamiento</h3>''',
'''        </div>\n        <div class="form-section">\n          <h3 class="form-section-title">Alertas de despacho por WhatsApp</h3>\n          <div class="grid">\n            <div class="field full"><label for="dispatchAlertPhone">WhatsApp del administrador para alertas</label><input id="dispatchAlertPhone" name="dispatchAlertPhone" type="tel" inputmode="numeric" placeholder="3001234567" /><span class="hint">Número independiente del teléfono de recuperación. Recibe novedades operativas como NO PUEDO.</span></div>\n            <div class="field full"><label class="dispatch-row" for="dispatchWindowExpiryReminderEnabled"><input id="dispatchWindowExpiryReminderEnabled" name="dispatchWindowExpiryReminderEnabled" type="checkbox" value="true" /><span><strong>Recordarme antes de que venza la ventana de 24 horas</strong><small>Envía un aviso por WhatsApp aproximadamente 20 minutos antes del vencimiento de la ventana de cada auxiliar gestionado por este usuario.</small></span></label></div>\n          </div>\n          <p class="hint" style="margin-top:10px;">El número de alertas también está sujeto a las reglas de ventana de WhatsApp de Meta para mensajes libres.</p>\n        </div>\n        <div class="form-section">\n          <h3 class="form-section-title">Alcance inicial de reclutamiento</h3>''')

replace_once('src/views/users.ejs',
'''                        <div class="field"><label for="edit-recoveryPhone-<%= user.id %>">Teléfono de recuperación</label><input id="edit-recoveryPhone-<%= user.id %>" name="recoveryPhone" type="text" value="<%= user.recoveryPhone || '' %>" placeholder="3001234567" /></div>\n                        <div class="field full">''',
'''                        <div class="field"><label for="edit-recoveryPhone-<%= user.id %>">Teléfono de recuperación</label><input id="edit-recoveryPhone-<%= user.id %>" name="recoveryPhone" type="text" value="<%= user.recoveryPhone || '' %>" placeholder="3001234567" /></div>\n                        <div class="field"><label for="edit-dispatchAlertPhone-<%= user.id %>">WhatsApp del administrador para alertas</label><input id="edit-dispatchAlertPhone-<%= user.id %>" name="dispatchAlertPhone" type="tel" inputmode="numeric" value="<%= user.dispatchAlertPhone || '' %>" placeholder="3001234567" /></div>\n                        <div class="field full"><label class="dispatch-row" for="edit-dispatchWindowExpiryReminderEnabled-<%= user.id %>"><input id="edit-dispatchWindowExpiryReminderEnabled-<%= user.id %>" name="dispatchWindowExpiryReminderEnabled" type="checkbox" value="true" <%= user.dispatchWindowExpiryReminderEnabled ? 'checked' : '' %> /><span><strong>Recordarme antes de que venza la ventana de 24 horas</strong><small>Alerta por WhatsApp aproximadamente 20 minutos antes del vencimiento.</small></span></label></div>\n                        <div class="field full">''')

replace_once('src/views/users.ejs',
'''                <td>Reclutamiento<% if (user.canAccessDispatch) { %><small>Operaciones / Despacho</small><% } %><% if (user.canAccessAttendance) { %><small>Asistencia operativa</small><% } %><% if (user.canAccessMetaAds) { %><small>Estadísticas: Meta Ads</small><% } %><% if (user.canAccessCvAnalysis) { %><small>Estadísticas: Análisis HV</small><% } %></td>''',
'''                <td>Reclutamiento<% if (user.canAccessDispatch) { %><small>Operaciones / Despacho</small><% } %><% if (user.canAccessAttendance) { %><small>Asistencia operativa</small><% } %><% if (user.canAccessMetaAds) { %><small>Estadísticas: Meta Ads</small><% } %><% if (user.canAccessCvAnalysis) { %><small>Estadísticas: Análisis HV</small><% } %><% if (user.dispatchAlertPhone) { %><small>Alertas despacho: <%= user.dispatchAlertPhone %></small><small>Recordatorio ventana: <%= user.dispatchWindowExpiryReminderEnabled ? 'Activo' : 'Inactivo' %></small><% } %></td>''')

# 5) Base Cloud config no longer requires templates. Templates are only required when their fallback path is used.
replace_once('src/services/dispatchWhatsappCloudConfig.js',
'''  if (!config.appSecret) missing.push(envName(prefix, 'APP_SECRET'));\n  if (!config.assignmentTemplateName) missing.push(envName(prefix, 'ASSIGNMENT_TEMPLATE_NAME'));\n  if (definition.requireProgrammingTemplate && !config.programmingTemplateName) missing.push(envName(prefix, 'PROGRAMMING_TEMPLATE_NAME'));\n  if (!config.templateLanguage) missing.push(envName(prefix, 'TEMPLATE_LANGUAGE'));''',
'''  if (!config.appSecret) missing.push(envName(prefix, 'APP_SECRET'));''')

replace_once('src/services/dispatchWhatsappCloudConfig.js',
'''export function ensureDispatchWhatsappConfigured(scope = 'operational', { programming = false } = {}) {\n  const config = getDispatchWhatsappCloudConfig(scope);\n  const definition = dispatchWhatsappScopeDefinition(scope);\n  const required = [\n    ['GRAPH_VERSION', config.graphVersion],\n    ['ACCESS_TOKEN', config.accessToken],\n    ['PHONE_NUMBER_ID', config.phoneNumberId],\n    ['VERIFY_TOKEN', config.verifyToken],\n    ['APP_SECRET', config.appSecret],\n    ['ASSIGNMENT_TEMPLATE_NAME', config.assignmentTemplateName],\n    ['TEMPLATE_LANGUAGE', config.templateLanguage]\n  ];\n  if (programming) required.push(['PROGRAMMING_TEMPLATE_NAME', config.programmingTemplateName]);''',
'''export function ensureDispatchWhatsappConfigured(scope = 'operational', { programming = false, assignmentTemplate = false } = {}) {\n  const config = getDispatchWhatsappCloudConfig(scope);\n  const definition = dispatchWhatsappScopeDefinition(scope);\n  const required = [\n    ['GRAPH_VERSION', config.graphVersion],\n    ['ACCESS_TOKEN', config.accessToken],\n    ['PHONE_NUMBER_ID', config.phoneNumberId],\n    ['VERIFY_TOKEN', config.verifyToken],\n    ['APP_SECRET', config.appSecret]\n  ];\n  if (assignmentTemplate) required.push(['ASSIGNMENT_TEMPLATE_NAME', config.assignmentTemplateName]);\n  if (programming) required.push(['PROGRAMMING_TEMPLATE_NAME', config.programmingTemplateName]);\n  if (assignmentTemplate || programming) required.push(['TEMPLATE_LANGUAGE', config.templateLanguage]);''')

# 6) Official interactive session message + existing template only as fallback.
replace_once('src/services/dispatchWhatsappCloudClient.js',
'''function assignmentTemplateValues(assignment) {\n  const request = assignment.serviceRequest || {};\n  return [\n    parameterText(assignment.worker?.fullName, 'Auxiliar'),\n    parameterText(formatServiceDate(request.serviceDate)),\n    parameterText(request.operationPointName || request.serviceName || 'Operación LoginPro'),\n    parameterText(request.address || request.operationPoint?.address),\n    parameterText(hourLabel(request.startTime))\n  ];\n}\n''',
'''function assignmentTemplateValues(assignment) {\n  const request = assignment.serviceRequest || {};\n  return [\n    parameterText(assignment.worker?.fullName, 'Auxiliar'),\n    parameterText(formatServiceDate(request.serviceDate)),\n    parameterText(request.operationPointName || request.serviceName || 'Operación LoginPro'),\n    parameterText(request.address || request.operationPoint?.address),\n    parameterText(hourLabel(request.startTime))\n  ];\n}\n\nexport function buildDispatchAssignmentMessageBody(assignment) {\n  const [name, date, operation, address, startTime] = assignmentTemplateValues(assignment);\n  return `Hola *${name}*,\\n\\nMañana: *${date}*\\nLlegar a: *${operation}  - ${address}*\\nHora : *${startTime} por favor.*\\n\\n\\n*Confirmado?*`;\n}\n\nexport function buildDispatchAssignmentInteractivePayload({ assignment, phone }) {\n  const normalizedPhone = normalizeDispatchWhatsappPhone(phone);\n  if (!normalizedPhone) throw buildDispatchWhatsappError('Debes indicar un número válido para enviar WhatsApp.', 400, 'dispatch_whatsapp_phone_invalid');\n  return {\n    messaging_product: 'whatsapp',\n    recipient_type: 'individual',\n    to: normalizedPhone,\n    type: 'interactive',\n    interactive: {\n      type: 'button',\n      body: { text: buildDispatchAssignmentMessageBody(assignment) },\n      action: {\n        buttons: [\n          { type: 'reply', reply: { id: `dispatch_confirm:${assignment.id}`, title: 'CONFIRMADO' } },\n          { type: 'reply', reply: { id: `dispatch_decline:${assignment.id}`, title: 'NO PUEDO' } }\n        ]\n      }\n    }\n  };\n}\n''')

replace_once('src/services/dispatchWhatsappCloudClient.js',
'''export async function sendCloudAssignmentTemplate({ scope = 'operational', assignment, phone, axiosClient = axios }) {\n  const config = ensureDispatchWhatsappConfigured(scope);''',
'''export async function sendCloudAssignmentTemplate({ scope = 'operational', assignment, phone, axiosClient = axios }) {\n  const config = ensureDispatchWhatsappConfigured(scope, { assignmentTemplate: true });''')

replace_once('src/services/dispatchWhatsappCloudClient.js',
'''  return { config, providerMessageId };\n}\n\nexport async function sendDispatchWhatsappTextMessage({ scope = 'operational', phone, text, axiosClient = axios }) {''',
'''  return { config, providerMessageId };\n}\n\nexport async function sendCloudAssignmentInteractive({ scope = 'operational', assignment, phone, axiosClient = axios }) {\n  const config = ensureDispatchWhatsappConfigured(scope);\n  const response = await postGraph(config, buildDispatchAssignmentInteractivePayload({ assignment, phone }), axiosClient);\n  const providerMessageId = providerMessageIdFromResponse(response);\n  if (!providerMessageId) {\n    throw buildDispatchWhatsappError('Meta aceptó la solicitud sin devolver un identificador de mensaje.', 502, 'dispatch_whatsapp_provider_message_missing');\n  }\n  return { config, providerMessageId };\n}\n\nexport async function sendDispatchWhatsappTextMessage({ scope = 'operational', phone, text, axiosClient = axios }) {''')

# 7) Persistent contact windows + per-user administrator alerts.
admin_alert_service = r'''import { prisma } from '../lib/prisma.js';
import { dispatchServiceDateKey, todayIsoDateCO } from './dispatchDate.js';
import {
  ACTIVE_LINK_STATUSES,
  normalizeDispatchWhatsappPhone
} from './dispatchWhatsappCloudConfig.js';
import { sendDispatchWhatsappTextMessage } from './dispatchWhatsappCloudClient.js';

export const DISPATCH_WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;
// 30 seconds of safety margin lets the worker warn while at least ~20 minutes remain.
export const DISPATCH_WINDOW_REMINDER_LEAD_MS = (20 * 60 * 1000) + (30 * 1000);

function inboundReceivedAt(message = {}) {
  const timestamp = Number(message.timestamp || 0);
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000) : new Date();
}

export async function recordDispatchWhatsappInboundWindow({ scope = 'operational', message = {}, prismaClient = prisma } = {}) {
  const phone = normalizeDispatchWhatsappPhone(message.from);
  if (!phone) return null;
  const receivedAt = inboundReceivedAt(message);
  const key = { scope_phone: { scope, phone } };
  const current = await prismaClient.dispatchWhatsappContactWindow.findUnique({ where: key });
  if (current && new Date(current.lastInboundAt).getTime() >= receivedAt.getTime()) return current;
  if (current) {
    return prismaClient.dispatchWhatsappContactWindow.update({ where: key, data: { lastInboundAt: receivedAt } });
  }
  try {
    return await prismaClient.dispatchWhatsappContactWindow.create({ data: { scope, phone, lastInboundAt: receivedAt } });
  } catch (error) {
    if (error?.code !== 'P2002') throw error;
    await prismaClient.dispatchWhatsappContactWindow.updateMany({
      where: { scope, phone, lastInboundAt: { lt: receivedAt } },
      data: { lastInboundAt: receivedAt }
    });
    return prismaClient.dispatchWhatsappContactWindow.findUnique({ where: key });
  }
}

export async function getDispatchWhatsappContactWindowStatus({ scope = 'operational', phone, now = new Date(), prismaClient = prisma } = {}) {
  const normalizedPhone = normalizeDispatchWhatsappPhone(phone);
  if (!normalizedPhone) return { isOpen: false, phone: '', lastInboundAt: null, expiresAt: null };
  const row = await prismaClient.dispatchWhatsappContactWindow.findUnique({
    where: { scope_phone: { scope, phone: normalizedPhone } }
  });
  if (!row?.lastInboundAt) return { isOpen: false, phone: normalizedPhone, lastInboundAt: null, expiresAt: null };
  const lastInboundAt = new Date(row.lastInboundAt);
  const expiresAt = new Date(lastInboundAt.getTime() + DISPATCH_WHATSAPP_WINDOW_MS);
  return { isOpen: now.getTime() < expiresAt.getTime(), phone: normalizedPhone, lastInboundAt, expiresAt };
}

function dateLabel(value) {
  const key = dispatchServiceDateKey(value);
  if (!key) return 'fecha por confirmar';
  const [year, month, day] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: '2-digit', year: 'numeric' })
    .format(new Date(Date.UTC(year, month - 1, day, 12, 0, 0)));
}

function declineAlertText(assignment) {
  const request = assignment?.serviceRequest || {};
  const name = assignment?.worker?.fullName || 'Un auxiliar';
  const operation = request.operationPointName || request.serviceName || 'la operación asignada';
  return `⚠️ Novedad de despacho\n${name} indicó *NO PUEDO* para la asignación del ${dateLabel(request.serviceDate)} en ${operation}. Revisa la solicitud para asignar un reemplazo.`;
}

function reminderAlertText(assignment) {
  const name = assignment?.worker?.fullName || 'el auxiliar';
  const phone = normalizeDispatchWhatsappPhone(assignment?.worker?.phone) || 'sin número';
  return `⏰ La ventana de 24 horas con ${name} (${phone}) vence en aproximadamente 20 minutos. Si necesitas enviarle información sin plantilla, hazlo antes del vencimiento.`;
}

async function alertUserByUsername(prismaClient, username) {
  const normalized = String(username || '').trim();
  if (!normalized) return null;
  return prismaClient.appUser.findUnique({
    where: { username: normalized },
    select: {
      id: true,
      username: true,
      isActive: true,
      dispatchAlertPhone: true,
      dispatchWindowExpiryReminderEnabled: true
    }
  });
}

export async function sendDispatchDeclineAdminAlert({ scope = 'operational', link, assignment, prismaClient = prisma, axiosClient } = {}) {
  const ownerUsername = String(link?.alertOwnerUsername || assignment?.createdByUsername || '').trim();
  const user = await alertUserByUsername(prismaClient, ownerUsername);
  if (!user?.isActive || !user.dispatchAlertPhone) return { sent: false, reason: 'admin_alert_not_configured' };
  try {
    await sendDispatchWhatsappTextMessage({ scope, phone: user.dispatchAlertPhone, text: declineAlertText(assignment), axiosClient });
    return { sent: true, userId: user.id };
  } catch (error) {
    console.warn(`[dispatch-wa-cloud] No fue posible enviar alerta NO PUEDO al administrador ${user.username}: ${error?.message || error}`);
    return { sent: false, reason: 'provider_error', error: String(error?.message || error).slice(0, 300) };
  }
}

function eligibleServiceDate(assignment) {
  const key = dispatchServiceDateKey(assignment?.serviceRequest?.serviceDate);
  return Boolean(key && key >= todayIsoDateCO());
}

export async function runDispatchWhatsappWindowReminderDispatcher(prismaClient = prisma, { now = new Date(), axiosClient } = {}) {
  const nowMs = now.getTime();
  const openAfter = new Date(nowMs - DISPATCH_WHATSAPP_WINDOW_MS);
  const reminderDueBefore = new Date(nowMs - (DISPATCH_WHATSAPP_WINDOW_MS - DISPATCH_WINDOW_REMINDER_LEAD_MS));
  const windows = await prismaClient.dispatchWhatsappContactWindow.findMany({
    where: { lastInboundAt: { gt: openAfter, lte: reminderDueBefore } },
    orderBy: { lastInboundAt: 'asc' },
    take: 100
  });
  let sent = 0;
  let failed = 0;

  for (const window of windows) {
    const links = await prismaClient.dispatchWhatsappConfirmation.findMany({
      where: {
        phone: window.phone,
        alertOwnerUsername: { not: null },
        status: { in: [...ACTIVE_LINK_STATUSES, 'CONFIRMED'] },
        createdAt: { gte: new Date(nowMs - (7 * 24 * 60 * 60 * 1000)) }
      },
      orderBy: { createdAt: 'desc' },
      include: { assignment: { include: { worker: true, serviceRequest: true } } }
    });
    const latestByOwner = new Map();
    for (const link of links) {
      if (!eligibleServiceDate(link.assignment)) continue;
      if (!latestByOwner.has(link.alertOwnerUsername)) latestByOwner.set(link.alertOwnerUsername, link);
    }

    for (const [ownerUsername, link] of latestByOwner.entries()) {
      const user = await alertUserByUsername(prismaClient, ownerUsername);
      if (!user?.isActive || !user.dispatchAlertPhone || !user.dispatchWindowExpiryReminderEnabled) continue;

      let reminder;
      try {
        reminder = await prismaClient.dispatchWhatsappWindowReminder.create({
          data: {
            scope: window.scope,
            phone: window.phone,
            appUserId: user.id,
            windowStartedAt: window.lastInboundAt,
            status: 'PENDING'
          }
        });
      } catch (error) {
        if (error?.code === 'P2002') continue;
        throw error;
      }

      try {
        await sendDispatchWhatsappTextMessage({
          scope: window.scope,
          phone: user.dispatchAlertPhone,
          text: reminderAlertText(link.assignment),
          axiosClient
        });
        await prismaClient.dispatchWhatsappWindowReminder.update({
          where: { id: reminder.id },
          data: { status: 'SENT', sentAt: new Date(), lastError: null }
        });
        sent += 1;
      } catch (error) {
        await prismaClient.dispatchWhatsappWindowReminder.update({
          where: { id: reminder.id },
          data: { status: 'FAILED', lastError: String(error?.message || error).slice(0, 400) }
        });
        failed += 1;
        console.warn(`[dispatch-wa-cloud] Falló recordatorio de ventana para ${user.username}: ${error?.message || error}`);
      }
    }
  }
  return { windowsChecked: windows.length, sent, failed };
}
'''
write('src/services/dispatchWhatsappAdminAlerts.js', admin_alert_service)

# 8) Assignment send path: interactive within 24h, template only after window if configured, and owner attribution.
replace_once('src/services/dispatchWhatsappAssignmentService.js',
'''import { dispatchWhatsappProviderErrorMessage, sendCloudAssignmentTemplate } from './dispatchWhatsappCloudClient.js';''',
'''import {\n  dispatchWhatsappProviderErrorMessage,\n  sendCloudAssignmentInteractive,\n  sendCloudAssignmentTemplate\n} from './dispatchWhatsappCloudClient.js';\nimport { getDispatchWhatsappContactWindowStatus } from './dispatchWhatsappAdminAlerts.js';''')

replace_once('src/services/dispatchWhatsappAssignmentService.js',
'''export async function sendDispatchWhatsappMessage({\n  phone, context, scope = 'operational', axiosClient = axios, prismaClient = prisma\n} = {}) {''',
'''export async function sendDispatchWhatsappMessage({\n  phone, context, scope = 'operational', actorUsername = null, axiosClient = axios, prismaClient = prisma\n} = {}) {''')

replace_once('src/services/dispatchWhatsappAssignmentService.js',
'''  const config = ensureDispatchWhatsappConfigured(scope);\n  const validated = await validateDispatchAssignmentContext({ context, phone, scope, prismaClient });''',
'''  const config = ensureDispatchWhatsappConfigured(scope);\n  const validated = await validateDispatchAssignmentContext({ context, phone, scope, prismaClient });\n  const contactWindow = await getDispatchWhatsappContactWindowStatus({\n    scope, phone: validated.phone, prismaClient\n  });''')

replace_once('src/services/dispatchWhatsappAssignmentService.js',
'''      serviceRequestId: validated.assignment.serviceRequestId,\n      phone: validated.phone,\n      chatId: null,''',
'''      serviceRequestId: validated.assignment.serviceRequestId,\n      phone: validated.phone,\n      alertOwnerUsername: String(actorUsername || validated.assignment.createdByUsername || '').trim() || null,\n      chatId: null,''')

replace_once('src/services/dispatchWhatsappAssignmentService.js',
'''  try {\n    const { providerMessageId } = await sendCloudAssignmentTemplate({\n      scope, assignment: validated.assignment, phone: validated.phone, axiosClient\n    });''',
'''  try {\n    let providerMessageId;\n    let deliveryMode;\n    let templateName = null;\n    if (contactWindow.isOpen) {\n      ({ providerMessageId } = await sendCloudAssignmentInteractive({\n        scope, assignment: validated.assignment, phone: validated.phone, axiosClient\n      }));\n      deliveryMode = 'SESSION_INTERACTIVE';\n    } else if (config.assignmentTemplateName && config.templateLanguage) {\n      ({ providerMessageId } = await sendCloudAssignmentTemplate({\n        scope, assignment: validated.assignment, phone: validated.phone, axiosClient\n      }));\n      deliveryMode = 'TEMPLATE';\n      templateName = config.assignmentTemplateName;\n    } else {\n      throw buildDispatchWhatsappError(\n        'La ventana de 24 horas con este auxiliar está cerrada. Para enviar después del vencimiento será necesaria una plantilla aprobada.',\n        409,\n        'dispatch_whatsapp_window_closed'\n      );\n    }''')

replace_once('src/services/dispatchWhatsappAssignmentService.js',
'''    console.info(`[dispatch-wa-cloud] Plantilla enviada. scope=${scope} assignment=${validated.assignment.id} providerMessage=yes.`);\n    return { phone: validated.phone, providerMessageId, templateName: config.assignmentTemplateName, provider: 'META_CLOUD_API' };''',
'''    console.info(`[dispatch-wa-cloud] Mensaje de asignación enviado. scope=${scope} assignment=${validated.assignment.id} mode=${deliveryMode}.`);\n    return { phone: validated.phone, providerMessageId, templateName, deliveryMode, provider: 'META_CLOUD_API' };''')

# 9) Route binds a send to the logged-in administrator.
replace_once('src/routes/dispatchWhatsappNotifications.js',
'''      const result = await sendDispatchWhatsappMessage({\n        phone: req.body?.phone,\n        context,\n        scope: 'operational'\n      });''',
'''      const result = await sendDispatchWhatsappMessage({\n        phone: req.body?.phone,\n        context,\n        scope: 'operational',\n        actorUsername: normalizeString(req.session?.username || req.username)\n      });''')

replace_once('src/routes/dispatchWhatsappNotifications.js',
'''        phone: result.phone,\n        templateName: result.templateName''',
'''        phone: result.phone,\n        deliveryMode: result.deliveryMode,\n        templateName: result.templateName''')

# 10) Every inbound restarts its own contact window; decline alerts owner; Gracias remains untouched.
replace_once('src/services/dispatchWhatsappWebhookService.js',
'''import { dispatchWhatsappProviderErrorMessage, sendDispatchWhatsappTextMessage } from './dispatchWhatsappCloudClient.js';''',
'''import { dispatchWhatsappProviderErrorMessage, sendDispatchWhatsappTextMessage } from './dispatchWhatsappCloudClient.js';\nimport {\n  recordDispatchWhatsappInboundWindow,\n  sendDispatchDeclineAdminAlert\n} from './dispatchWhatsappAdminAlerts.js';''')

replace_once('src/services/dispatchWhatsappWebhookService.js',
'''export async function processDispatchWhatsappInboundMessage({\n  scope = 'operational', message = {}, prismaClient = prisma, axiosClient = axios\n} = {}) {\n  const buttonAction = assignmentActionFromInboundPayload(message);''',
'''export async function processDispatchWhatsappInboundMessage({\n  scope = 'operational', message = {}, prismaClient = prisma, axiosClient = axios\n} = {}) {\n  await recordDispatchWhatsappInboundWindow({ scope, message, prismaClient });\n  const buttonAction = assignmentActionFromInboundPayload(message);''')

replace_once('src/services/dispatchWhatsappWebhookService.js',
'''    if (decline.assignmentDeclined && scope === 'operational') {\n      await recalculateDispatchServiceRequestStatus(prismaClient, target.assignment.serviceRequestId);\n    }\n    setDispatchWhatsappRuntimeState(scope, { lastInboundAt: new Date().toISOString(), lastError: null });\n    console.info(`[dispatch-wa-cloud] Respuesta NO PUEDO procesada. scope=${scope} assignment=${target.assignment.id} changed=${decline.assignmentDeclined ? 'yes' : 'no'}.`);\n    return { handled: decline.assignmentDeclined || decline.duplicate, duplicate: decline.duplicate, assignmentDeclined: decline.assignmentDeclined, replySent: false };''',
'''    if (decline.assignmentDeclined && scope === 'operational') {\n      await recalculateDispatchServiceRequestStatus(prismaClient, target.assignment.serviceRequestId);\n    }\n    let adminAlertSent = false;\n    if (decline.assignmentDeclined) {\n      const adminAlert = await sendDispatchDeclineAdminAlert({\n        scope, link: target.link, assignment: target.assignment, prismaClient, axiosClient\n      }).catch((error) => ({ sent: false, error }));\n      adminAlertSent = Boolean(adminAlert?.sent);\n    }\n    setDispatchWhatsappRuntimeState(scope, { lastInboundAt: new Date().toISOString(), lastError: null });\n    console.info(`[dispatch-wa-cloud] Respuesta NO PUEDO procesada. scope=${scope} assignment=${target.assignment.id} changed=${decline.assignmentDeclined ? 'yes' : 'no'} adminAlert=${adminAlertSent ? 'sent' : 'not-sent'}.`);\n    return { handled: decline.assignmentDeclined || decline.duplicate, duplicate: decline.duplicate, assignmentDeclined: decline.assignmentDeclined, adminAlertSent, replySent: false };''')

# 11) Persistent worker sweep. It runs every 10s so the 30s margin keeps the alert at >=20 minutes in normal operation.
replace_once('src/workers/jobWorker.js',
'''import { ensureSupervisorWindowOpen } from '../services/adminSupervisor.js';\n''',
'''import { ensureSupervisorWindowOpen } from '../services/adminSupervisor.js';\nimport { runDispatchWhatsappWindowReminderDispatcher } from '../services/dispatchWhatsappAdminAlerts.js';\n''')

replace_once('src/workers/jobWorker.js',
'''const POLL_MS = Number.parseInt(process.env.JOB_WORKER_POLL_MS || '5000', 10);\n''',
'''const POLL_MS = Number.parseInt(process.env.JOB_WORKER_POLL_MS || '5000', 10);\nconst DISPATCH_WINDOW_REMINDER_SWEEP_MS = 10000;\nlet lastDispatchWindowReminderSweepAt = 0;\n''')

replace_once('src/workers/jobWorker.js',
'''  await runReminderDispatcher(prisma, { now });\n}\n''',
'''  await runReminderDispatcher(prisma, { now });\n\n  if (now.getTime() - lastDispatchWindowReminderSweepAt >= DISPATCH_WINDOW_REMINDER_SWEEP_MS) {\n    lastDispatchWindowReminderSweepAt = now.getTime();\n    await runDispatchWhatsappWindowReminderDispatcher(prisma, { now }).catch((error) =>\n      console.warn('[DISPATCH_WINDOW_REMINDER_ERROR]', error?.message || error)\n    );\n  }\n}\n''')

# 12) Permanent regression coverage.
test_content = r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function read(path) { return fs.readFileSync(path, 'utf8'); }

function assignmentFixture() {
  return {
    id: 'assignment-1',
    worker: { fullName: 'Ana Pérez', phone: '3001234567' },
    serviceRequest: {
      serviceDate: new Date('2026-08-12T05:00:00.000Z'),
      operationPointName: 'Punto Norte',
      address: 'Calle 1 # 2-3',
      startTime: '08:00'
    }
  };
}

test('usuario tiene WhatsApp de alertas y check independiente de recordatorio de ventana', () => {
  const schema = read('prisma/schema.prisma');
  const view = read('src/views/users.ejs');
  const admin = read('src/routes/admin.js');
  const locations = read('src/routes/locations.js');
  assert.match(schema, /dispatchAlertPhone\s+String\?/);
  assert.match(schema, /dispatchWindowExpiryReminderEnabled\s+Boolean\s+@default\(false\)/);
  assert.match(view, /name="dispatchAlertPhone"/);
  assert.match(view, /name="dispatchWindowExpiryReminderEnabled"/);
  assert.match(view, /Recordarme antes de que venza la ventana de 24 horas/);
  assert.match(admin, /dispatchAlertPhone,/);
  assert.match(admin, /dispatchWindowExpiryReminderEnabled,/);
  assert.match(locations, /dispatchAlertPhone,/);
  assert.match(locations, /dispatchWindowExpiryReminderEnabled/);
});

test('mensaje normal de asignación conserva literalmente el cuerpo canónico y usa dos botones', async () => {
  const client = await import('../src/services/dispatchWhatsappCloudClient.js');
  const payload = client.buildDispatchAssignmentInteractivePayload({ assignment: assignmentFixture(), phone: '3001234567' });
  assert.equal(payload.type, 'interactive');
  assert.equal(payload.interactive.type, 'button');
  assert.equal(payload.interactive.body.text,
    'Hola *Ana Pérez*,\n\nMañana: *12/08/2026*\nLlegar a: *Punto Norte  - Calle 1 # 2-3*\nHora : *8:00 AM por favor.*\n\n\n*Confirmado?*');
  assert.deepEqual(payload.interactive.action.buttons.map((button) => button.reply.title), ['CONFIRMADO', 'NO PUEDO']);
  assert.deepEqual(payload.interactive.action.buttons.map((button) => button.reply.id), ['dispatch_confirm:assignment-1', 'dispatch_decline:assignment-1']);
});

test('envío prioriza ventana de 24h y deja plantilla solo como fallback', () => {
  const assignment = read('src/services/dispatchWhatsappAssignmentService.js');
  const config = read('src/services/dispatchWhatsappCloudConfig.js');
  assert.match(assignment, /getDispatchWhatsappContactWindowStatus/);
  assert.match(assignment, /contactWindow\.isOpen/);
  assert.match(assignment, /sendCloudAssignmentInteractive/);
  assert.match(assignment, /deliveryMode = 'SESSION_INTERACTIVE'/);
  assert.match(assignment, /deliveryMode = 'TEMPLATE'/);
  assert.match(assignment, /dispatch_whatsapp_window_closed/);
  assert.match(config, /assignmentTemplate = false/);
});

test('cada inbound reinicia la ventana, NO PUEDO alerta al dueño y Gracias permanece', () => {
  const webhook = read('src/services/dispatchWhatsappWebhookService.js');
  const assignment = read('src/services/dispatchWhatsappAssignmentService.js');
  const config = read('src/services/dispatchWhatsappCloudConfig.js');
  assert.match(webhook, /recordDispatchWhatsappInboundWindow/);
  assert.ok(webhook.indexOf('recordDispatchWhatsappInboundWindow') < webhook.indexOf('const buttonAction'));
  assert.match(webhook, /sendDispatchDeclineAdminAlert/);
  assert.match(assignment, /alertOwnerUsername:/);
  assert.match(config, /AUTOMATIC_CONFIRMATION_REPLY = 'Gracias\.'/);
  assert.match(webhook, /AUTOMATIC_CONFIRMATION_REPLY/);
});

test('recordatorio es persistente, por usuario y se barre con margen superior a 20 minutos', () => {
  const schema = read('prisma/schema.prisma');
  const alerts = read('src/services/dispatchWhatsappAdminAlerts.js');
  const worker = read('src/workers/jobWorker.js');
  assert.match(schema, /model DispatchWhatsappContactWindow/);
  assert.match(schema, /model DispatchWhatsappWindowReminder/);
  assert.match(schema, /@@unique\(\[scope, phone, appUserId, windowStartedAt\]\)/);
  assert.match(alerts, /DISPATCH_WINDOW_REMINDER_LEAD_MS = \(20 \* 60 \* 1000\) \+ \(30 \* 1000\)/);
  assert.match(alerts, /dispatchWindowExpiryReminderEnabled/);
  assert.match(alerts, /dispatchWhatsappWindowReminder\.create/);
  assert.match(worker, /runDispatchWhatsappWindowReminderDispatcher/);
  assert.match(worker, /DISPATCH_WINDOW_REMINDER_SWEEP_MS = 10000/);
});
'''
write('test/dispatchWhatsappAdminAlerts.test.js', test_content)

print('Dispatch admin alerts patch applied.')
