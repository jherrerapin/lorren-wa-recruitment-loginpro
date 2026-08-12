import assert from 'node:assert/strict';
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

test('cada usuario configura sus alertas dentro de Despacho y no desde administración de usuarios', () => {
  const schema = read('prisma/schema.prisma');
  const usersView = read('src/views/users.ejs');
  const admin = read('src/routes/admin.js');
  const locations = read('src/routes/locations.js');
  const dashboard = read('src/views/operacionesDashboard.ejs');
  const dashboardRoute = read('src/routes/dispatchDashboardMetrics.js');
  assert.match(schema, /dispatchAlertPhone\s+String\?/);
  assert.match(schema, /dispatchWindowExpiryReminderEnabled\s+Boolean\s+@default\(false\)/);
  assert.doesNotMatch(usersView, /name="dispatchAlertPhone"/);
  assert.doesNotMatch(usersView, /name="dispatchWindowExpiryReminderEnabled"/);
  assert.doesNotMatch(admin, /normalizeDispatchAlertPhoneInput/);
  assert.doesNotMatch(locations, /normalizeDispatchAlertPhoneInput/);
  assert.match(dashboard, /Mis alertas de despacho por WhatsApp/);
  assert.match(dashboard, /action="\/admin\/operaciones\/alertas-whatsapp"/);
  assert.match(dashboard, /name="dispatchAlertPhone"/);
  assert.match(dashboard, /name="dispatchWindowExpiryReminderEnabled"/);
  assert.match(dashboard, /Guardar cambios/);
  assert.match(dashboardRoute, /router\.post\('\/alertas-whatsapp'/);
  assert.match(dashboardRoute, /findCurrentDispatchAppUser/);
  assert.match(dashboardRoute, /prisma\.appUser\.update/);
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

test('recordatorio es persistente, por usuario y conserva al menos veinte minutos de margen', () => {
  const schema = read('prisma/schema.prisma');
  const alerts = read('src/services/dispatchWhatsappAdminAlerts.js');
  const worker = read('src/workers/jobWorker.js');
  assert.match(schema, /model DispatchWhatsappContactWindow/);
  assert.match(schema, /model DispatchWhatsappWindowReminder/);
  assert.match(schema, /@@unique\(\[scope, phone, appUserId, windowStartedAt\]\)/);
  assert.match(alerts, /DISPATCH_WINDOW_REMINDER_LEAD_MS = 25 \* 60 \* 1000/);
  assert.match(alerts, /vence en aproximadamente 25 minutos/);
  assert.match(alerts, /dispatchWindowExpiryReminderEnabled/);
  assert.match(alerts, /dispatchWhatsappWindowReminder\.create/);
  assert.match(worker, /runDispatchWhatsappWindowReminderDispatcher/);
  assert.match(worker, /DISPATCH_WINDOW_REMINDER_SWEEP_MS = 10000/);
});
