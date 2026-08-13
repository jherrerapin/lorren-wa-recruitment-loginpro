import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

function readSource(path) {
  return fs.readFileSync(path, 'utf8');
}

const REMOVED_RUNTIME_PATHS = [
  'src/routes/dispatchWaRouterV2.js',
  'src/services/dispatchWhatsappWebService.js',
  'src/services/dispatchWhatsappWebServiceV6.js',
  'src/services/dispatchWhatsappWebTestService.js',
  'src/services/dispatchWhatsappConfirmationPatch.js'
];

function assignmentFixture() {
  return {
    id: 'assignment-1',
    serviceRequestId: 'request-1',
    worker: { fullName: 'Ana Pérez', phone: '3001234567' },
    serviceRequest: {
      clientName: 'Cliente Uno',
      operationPointName: 'Punto Norte',
      address: 'Calle 1 # 2-3',
      cityName: 'Bogotá',
      serviceDate: new Date('2026-08-12T05:00:00.000Z'),
      startTime: '08:00',
      serviceName: 'Cargue y descargue'
    }
  };
}

test('despacho elimina WhatsApp Web, Chromium, QR y el patch heredado', () => {
  for (const path of REMOVED_RUNTIME_PATHS) {
    assert.equal(fs.existsSync(path), false, `${path} debe estar eliminado`);
  }
  const pkg = JSON.parse(readSource('package.json'));
  assert.equal(pkg.dependencies['whatsapp-web.js'], undefined);
  assert.equal(pkg.dependencies['qrcode-terminal'], undefined);
  assert.equal(pkg.dependencies.qrcode, undefined);
  const env = readSource('.env.example');
  assert.doesNotMatch(env, /DISPATCH_WWEB_|DISPATCH_WA_RECONCILE/);
  assert.match(env, /DISPATCH_META_PHONE_NUMBER_ID/);
  assert.match(env, /DISPATCH_META_ASSIGNMENT_TEMPLATE_NAME/);
});

test('la autoridad de despacho usa Cloud API y la plantilla se arma desde la asignación', async () => {
  const client = await import('../src/services/dispatchWhatsappCloudClient.js');
  const config = {
    assignmentTemplateName: 'dispatch_assignment_confirmation',
    programmingTemplateName: 'dispatch_programming_document',
    templateLanguage: 'es'
  };
  const payload = client.buildDispatchAssignmentTemplatePayload({
    config,
    assignment: assignmentFixture(),
    phone: '3001234567'
  });

  assert.equal(payload.messaging_product, 'whatsapp');
  assert.equal(payload.to, '573001234567');
  assert.equal(payload.type, 'template');
  assert.equal(payload.template.name, 'dispatch_assignment_confirmation');
  assert.equal(payload.template.language.code, 'es');
  const body = payload.template.components.find((component) => component.type === 'body');
  assert.equal(body.parameters.length, 5);
  assert.deepEqual(body.parameters.map((parameter) => parameter.type), Array(5).fill('text'));
  assert.deepEqual(body.parameters.map((parameter) => parameter.text), [
    'Ana Pérez',
    '12/08/2026',
    'Punto Norte',
    'Calle 1 # 2-3',
    '8:00 AM'
  ]);
  const buttons = payload.template.components.filter((component) => component.type === 'button');
  assert.deepEqual(buttons.map((button) => ({ index: button.index, payload: button.parameters[0].payload })), [
    { index: '0', payload: 'dispatch_confirm:assignment-1' },
    { index: '1', payload: 'dispatch_novelty:assignment-1' }
  ]);
});

test('programación usa plantilla oficial con documento en header', async () => {
  const { buildDispatchProgrammingTemplatePayload } = await import('../src/services/dispatchWhatsappCloudClient.js');
  const payload = buildDispatchProgrammingTemplatePayload({
    config: {
      programmingTemplateName: 'dispatch_programming_document',
      templateLanguage: 'es'
    },
    phone: '3001234567',
    mediaId: 'media-1',
    filename: 'programacion.pdf',
    templateValues: {
      selectedDate: '2026-08-12',
      scopeLabel: 'Solo solicitudes completas',
      requestsIncluded: '2',
      completionLabel: '2/2 solicitudes completas',
      workersLabel: '8/8 auxiliares incluidos',
      managedBy: 'LoginPro Operaciones'
    }
  });
  const header = payload.template.components.find((component) => component.type === 'header');
  assert.equal(header.parameters[0].type, 'document');
  assert.equal(header.parameters[0].document.id, 'media-1');
  assert.equal(payload.template.components.find((component) => component.type === 'body').parameters.length, 6);
});

test('servidor monta webhook de despacho antes del parser JSON global', () => {
  const server = readSource('src/server.js');
  const importIndex = server.indexOf("import { dispatchWhatsappWebhookRouter } from './routes/dispatchWhatsappWebhook.js';");
  const webhookIndex = server.indexOf("app.use('/webhook/dispatch', dispatchWhatsappWebhookRouter(prisma));");
  const jsonIndex = server.indexOf("app.use(express.json({ limit: '2mb' }));");
  assert.ok(importIndex >= 0);
  assert.ok(webhookIndex >= 0);
  assert.ok(jsonIndex > webhookIndex);
  assert.match(server, /app\.use\('\/webhook', webhookRouter\(prisma\)\)/);
});

test('webhook valida X-Hub-Signature-256 sobre el cuerpo crudo', async () => {
  const { verifyDispatchWhatsappSignature } = await import('../src/routes/dispatchWhatsappWebhook.js');
  const body = Buffer.from('{"object":"whatsapp_business_account"}');
  const secret = 'test-secret';
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifyDispatchWhatsappSignature(body, signature, secret), true);
  assert.equal(verifyDispatchWhatsappSignature(body, signature, 'other-secret'), false);
});

test('rutas operativas ya no aceptan texto arbitrario del navegador como autoridad del envío', () => {
  const route = readSource('src/routes/dispatchWhatsappNotifications.js');
  const service = readSource('src/services/dispatchWhatsappAssignmentService.js');
  assert.match(route, /sendDispatchWhatsappMessage\(\{/);
  assert.doesNotMatch(route, /message:\s*req\.body\?\.message/);
  assert.match(service, /include: \{ worker: true, serviceRequest: \{ include: \{ operationPoint: true \} \} \}/);
  assert.match(service, /recipientPhone !== assignmentPhone/);
  assert.match(service, /serviceDate < todayIsoDateCO\(\)/);
});

test('confirmaciones entrantes mantienen variantes actuales y no aceptan texto de ausencia', async () => {
  const { isAutomaticConfirmationReply } = await import('../src/services/dispatchWhatsappWebhookService.js');
  assert.equal(isAutomaticConfirmationReply('Confirmado'), true);
  assert.equal(isAutomaticConfirmationReply('Sí, confirmado'), true);
  assert.equal(isAutomaticConfirmationReply('recibido'), true);
  assert.equal(isAutomaticConfirmationReply('No asistiré'), false);
});

test('Reportar novedad conserva la asignación pendiente y el enlace sigue aceptando confirmación posterior', () => {
  const config = readSource('src/services/dispatchWhatsappCloudConfig.js');
  const assignment = readSource('src/services/dispatchWhatsappAssignmentService.js');
  const webhook = readSource('src/services/dispatchWhatsappWebhookService.js');
  assert.match(config, /ACTIVE_LINK_STATUSES[\s\S]*'NOVELTY_REPORTED'/);
  assert.match(config, /INBOUND_LINK_STATUSES[\s\S]*'NOVELTY_REPORTED'/);
  assert.match(assignment, /claimDispatchAssignmentNovelty/);
  assert.match(assignment, /status: 'NOVELTY_REPORTED'/);
  assert.doesNotMatch(assignment, /El auxiliar indicó NO PUEDO/);
  assert.match(webhook, /match\(\/\^dispatch_\(confirm\|novelty\|decline\)/);
  assert.match(webhook, /match\[1\] === 'confirm' \? 'CONFIRM' : 'NOVELTY'/);
});

test('Gracias solo se envía después de evidencia inbound real', () => {
  const assignment = readSource('src/services/dispatchWhatsappAssignmentService.js');
  const webhook = readSource('src/services/dispatchWhatsappWebhookService.js');
  assert.match(assignment, /confirmationMessageId/);
  assert.match(assignment, /confirmationReceivedAt/);
  assert.match(webhook, /claimDispatchAssignmentConfirmation\(\{/);
  assert.match(webhook, /sendDispatchWhatsappTextMessage\(\{ scope, phone: target\.phone, text: AUTOMATIC_CONFIRMATION_REPLY/);
  assert.ok(webhook.indexOf('claimDispatchAssignmentConfirmation({') < webhook.indexOf('sendDispatchWhatsappTextMessage({'));
  assert.doesNotMatch(webhook, /setInterval|reconciliation|getChats|getChatById|message_create/);
});

test('estados Meta se correlacionan por wamid y no degradan estados terminales', () => {
  const webhook = readSource('src/services/dispatchWhatsappWebhookService.js');
  assert.match(webhook, /where: \{ providerMessageId \}/);
  assert.match(webhook, /\['SENT', 'DELIVERED', 'READ', 'FAILED'\]/);
  assert.match(webhook, /TERMINAL_LINK_STATUSES\.has\(link\.status\)/);
  assert.match(webhook, /DELIVERY_RANK/);
});

test('entorno DEV usa configuración oficial separada de la línea operativa', () => {
  const config = readSource('src/services/dispatchWhatsappCloudConfig.js');
  const route = readSource('src/routes/dispatchDevPayrollTest.js');
  assert.match(config, /envPrefix: 'DISPATCH_META'/);
  assert.match(config, /envPrefix: 'DISPATCH_TEST_META'/);
  assert.match(config, /confirmedAssignmentStatus: 'DEV_TEST_CONFIRMED'/);
  assert.match(route, /dispatchWhatsappTestService\.js/);
  assert.doesNotMatch(route, /cerrar-sesion|initDispatchTestWhatsappClient|dispatchWhatsappWebTestService/);
});

test('pantalla de estado representa Cloud API y no una sesión vinculada', () => {
  const view = readSource('src/views/operacionesWhatsappEstado.ejs');
  assert.match(view, /WhatsApp Business Platform/);
  assert.match(view, /Phone Number ID/);
  assert.match(view, /Plantilla de asignación/);
  assert.doesNotMatch(view, /qrImage|Escanea|cerrar-sesion|LocalAuth|Chromium.*QR/);
});

test('programación y asignaciones comparten la misma fachada Cloud', () => {
  const assignmentRouter = readSource('src/routes/dispatchWhatsappNotifications.js');
  const programmingRouter = readSource('src/routes/dispatchProgrammingNotifications.js');
  assert.match(assignmentRouter, /services\/dispatchWhatsappCloudService\.js/);
  assert.match(programmingRouter, /services\/dispatchWhatsappCloudService\.js/);
});

test('la configuración no expone secretos en el estado visible', async () => {
  const previous = {
    phone: process.env.DISPATCH_META_PHONE_NUMBER_ID,
    token: process.env.DISPATCH_META_ACCESS_TOKEN,
    secret: process.env.DISPATCH_META_APP_SECRET
  };
  process.env.DISPATCH_META_PHONE_NUMBER_ID = '123456789012345';
  process.env.DISPATCH_META_ACCESS_TOKEN = 'token-super-secreto';
  process.env.DISPATCH_META_APP_SECRET = 'app-secret-super-secreto';
  const { getDispatchWhatsappStatus } = await import('../src/services/dispatchWhatsappCloudConfig.js');
  const status = getDispatchWhatsappStatus('operational');
  assert.equal(status.phoneNumberIdMasked, '***2345');
  assert.equal('accessToken' in status, false);
  assert.equal('appSecret' in status, false);
  if (previous.phone === undefined) delete process.env.DISPATCH_META_PHONE_NUMBER_ID; else process.env.DISPATCH_META_PHONE_NUMBER_ID = previous.phone;
  if (previous.token === undefined) delete process.env.DISPATCH_META_ACCESS_TOKEN; else process.env.DISPATCH_META_ACCESS_TOKEN = previous.token;
  if (previous.secret === undefined) delete process.env.DISPATCH_META_APP_SECRET; else process.env.DISPATCH_META_APP_SECRET = previous.secret;
});

test('resumen de solicitudes conserva la limpieza existente', () => {
  const view = readSource('src/views/operacionesSolicitudesResumen.ejs');
  assert.doesNotMatch(view, /Ver todas las solicitudes/);
});
