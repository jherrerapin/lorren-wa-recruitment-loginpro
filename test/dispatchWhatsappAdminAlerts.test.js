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
  assert.match(dashboard, /Las novedades reportadas por los auxiliares se notifican aunque este check esté apagado/);
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
  assert.deepEqual(payload.interactive.action.buttons.map((button) => button.reply.title), ['CONFIRMADO', 'REPORTAR NOVEDAD']);
  assert.deepEqual(payload.interactive.action.buttons.map((button) => button.reply.id), ['dispatch_confirm:assignment-1', 'dispatch_novelty:assignment-1']);
});

test('alerta de novedad incluye auxiliar, teléfono e instrucción de contacto', async () => {
  const { buildDispatchNoveltyAdminAlertText } = await import('../src/services/dispatchWhatsappAdminAlerts.js');
  const text = buildDispatchNoveltyAdminAlertText(assignmentFixture());
  assert.match(text, /Ana Pérez/);
  assert.match(text, /573001234567/);
  assert.match(text, /Punto Norte/);
  assert.match(text, /Comunícate con el auxiliar/);
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

test('cada inbound reinicia la ventana, Reportar novedad alerta al dueño y Gracias permanece para confirmación', () => {
  const webhook = read('src/services/dispatchWhatsappWebhookService.js');
  const assignment = read('src/services/dispatchWhatsappAssignmentService.js');
  const config = read('src/services/dispatchWhatsappCloudConfig.js');
  assert.match(webhook, /recordDispatchWhatsappInboundWindow/);
  assert.ok(webhook.indexOf('recordDispatchWhatsappInboundWindow') < webhook.indexOf('const buttonAction'));
  assert.match(webhook, /sendDispatchNoveltyAdminAlert/);
  assert.match(webhook, /claimDispatchAssignmentNovelty/);
  assert.match(assignment, /alertOwnerUsername:/);
  assert.match(assignment, /type: 'WHATSAPP_NOVELTY'/);
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

test('horarios automáticos se guardan por usuario y siempre se interpretan en Bogotá', async () => {
  const {
    isDispatchBogotaScheduleDue,
    loadDispatchWhatsappAutomationSettings,
    normalizeDispatchAutomationTime,
    saveDispatchWhatsappAutomationSettings
  } = await import('../src/services/dispatchWhatsappAdminAlerts.js');
  const events = [];
  const prismaClient = {
    devAuditEvent: {
      create: async ({ data }) => { events.push({ ...data, createdAt: new Date('2026-08-13T00:00:00.000Z') }); return data; },
      findFirst: async ({ where }) => events.filter((event) => (
        event.entityType === where.entityType && event.entityId === where.entityId && event.action === where.action
      )).at(-1) || null
    }
  };

  assert.equal(normalizeDispatchAutomationTime('18:05'), '18:05');
  assert.equal(normalizeDispatchAutomationTime('25:00'), null);
  assert.equal(isDispatchBogotaScheduleDue('19:00', new Date('2026-08-13T00:30:00.000Z')), true);
  assert.equal(isDispatchBogotaScheduleDue('20:00', new Date('2026-08-13T00:30:00.000Z')), false);

  await saveDispatchWhatsappAutomationSettings({
    prismaClient,
    userId: 'user-1',
    assignmentAutoSendTime: '18:30',
    pendingConfirmationAlertTime: '19:15'
  });
  assert.deepEqual(await loadDispatchWhatsappAutomationSettings({ prismaClient, userId: 'user-1' }), {
    assignmentAutoSendTime: '18:30',
    pendingConfirmationAlertTime: '19:15'
  });
  assert.deepEqual(await loadDispatchWhatsappAutomationSettings({ prismaClient, userId: 'user-2' }), {
    assignmentAutoSendTime: null,
    pendingConfirmationAlertTime: null
  });
});

test('scheduler envía una vez por asignación y reporta solo pendientes del usuario configurado', async () => {
  const { runDispatchUserAutomationScheduler } = await import('../src/services/dispatchWhatsappAdminAlerts.js');
  const configEvents = [{
    id: 'config-1',
    entityType: 'DISPATCH_WHATSAPP_AUTOMATION_CONFIG',
    entityId: 'user-1',
    action: 'SET_DISPATCH_WHATSAPP_AUTOMATION',
    metadata: { assignmentAutoSendTime: '18:00', pendingConfirmationAlertTime: '19:00' },
    createdAt: new Date('2026-08-12T20:00:00.000Z')
  }];
  const runEvents = [];
  const attemptedAssignments = new Set();
  const assignmentSends = [];
  const adminSends = [];
  const assignable = {
    id: 'assignment-auto',
    serviceRequestId: 'request-auto',
    workerId: 'worker-auto',
    status: 'ASSIGNED',
    createdByUsername: 'coordinador-a',
    createdAt: new Date('2026-08-12T20:00:00.000Z'),
    worker: { id: 'worker-auto', fullName: 'Auxiliar Uno', phone: '3001112233' },
    serviceRequest: { id: 'request-auto', source: 'MANUAL', serviceDate: new Date('2026-08-13T05:00:00.000Z') }
  };
  const stillPending = {
    id: 'assignment-pending',
    serviceRequestId: 'request-pending',
    workerId: 'worker-pending',
    status: 'CONFIRMATION_PENDING',
    createdByUsername: 'coordinador-a',
    createdAt: new Date('2026-08-12T20:10:00.000Z'),
    worker: { id: 'worker-pending', fullName: 'Auxiliar Dos', phone: '3002223344' },
    serviceRequest: { id: 'request-pending', source: 'MANUAL', serviceDate: new Date('2026-08-13T05:00:00.000Z') }
  };

  const prismaClient = {
    devAuditEvent: {
      findMany: async () => configEvents,
      findFirst: async ({ where }) => runEvents.find((event) => (
        event.entityType === where.entityType && event.entityId === where.entityId && event.action === where.action
      )) || null,
      create: async ({ data }) => { runEvents.push({ ...data, id: `run-${runEvents.length + 1}`, createdAt: new Date() }); return data; }
    },
    appUser: {
      findMany: async () => [{ id: 'user-1', username: 'coordinador-a', dispatchAlertPhone: '573009998877', isActive: true }]
    },
    dispatchAssignment: {
      findMany: async ({ where }) => {
        if (where.status.in.length === 1 && where.status.in[0] === 'ASSIGNED') return [assignable];
        return [stillPending];
      }
    },
    dispatchWhatsappConfirmation: {
      findMany: async () => [...attemptedAssignments].map((assignmentId) => ({ assignmentId }))
    }
  };

  const sendAssignmentMessage = async ({ context, phone, actorUsername }) => {
    assignmentSends.push({ assignmentId: context.assignmentId, phone, actorUsername });
    attemptedAssignments.add(context.assignmentId);
    return { providerMessageId: 'wamid-fake' };
  };
  const sendAdminMessage = async ({ phone, text }) => { adminSends.push({ phone, text }); return 'wamid-admin'; };
  const now = new Date('2026-08-13T00:30:00.000Z'); // 19:30 del 12/08 en Bogotá.

  const first = await runDispatchUserAutomationScheduler(prismaClient, { now, sendAssignmentMessage, sendAdminMessage });
  assert.equal(first.targetDateKey, '2026-08-13');
  assert.equal(first.assignmentSent, 1);
  assert.equal(first.pendingAlertsSent, 1);
  assert.deepEqual(assignmentSends, [{ assignmentId: 'assignment-auto', phone: '573001112233', actorUsername: 'coordinador-a' }]);
  assert.equal(adminSends.length, 1);
  assert.equal(adminSends[0].phone, '573009998877');
  assert.match(adminSends[0].text, /Auxiliar Dos/);
  assert.match(adminSends[0].text, /573002223344/);
  assert.doesNotMatch(adminSends[0].text, /Auxiliar Uno/);

  const second = await runDispatchUserAutomationScheduler(prismaClient, { now, sendAssignmentMessage, sendAdminMessage });
  assert.equal(second.assignmentSent, 0);
  assert.equal(second.pendingAlertsSent, 0);
  assert.equal(assignmentSends.length, 1);
  assert.equal(adminSends.length, 1);
});

test('UI de horarios es funcional para usuarios de Despacho sin exponer configuración técnica adicional', () => {
  const route = read('src/routes/dispatchWhatsappNotifications.js');
  const view = read('src/views/operacionesWhatsappEstado.ejs');
  assert.match(route, /router\.post\('\/programacion-automatica'/);
  assert.match(route, /saveDispatchWhatsappAutomationSettings/);
  assert.match(route, /pendingConfirmationAlertTime <= assignmentAutoSendTime/);
  assert.match(view, /Horarios automáticos de confirmación/);
  assert.match(view, /Bogotá · America\/Bogota/);
  assert.match(view, /name="dispatchAssignmentAutoSendTime"/);
  assert.match(view, /name="dispatchPendingConfirmationAlertTime"/);
  assert.match(view, /Mis alertas de despacho por WhatsApp/);
  assert.match(view, /<% if \(isDevView\) \{ %>[\s\S]*Configuración activa · solo DEV/);
});
