import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { addDispatchIsoDays } from '../src/services/dispatchDate.js';
import {
  normalizeProgrammingIncludePending,
  selectProgrammingRequests
} from '../src/services/dispatchProgrammingPdfService.js';

const requests = [
  { id: 'complete', status: 'ASSIGNMENT_COMPLETE' },
  { id: 'confirmation', status: 'PENDING_CONFIRMATION' },
  { id: 'partial', status: 'ASSIGNMENT_PARTIAL' },
  { id: 'unassigned', status: 'PENDING_ASSIGNMENT' }
];

test('programación confirmada selecciona únicamente solicitudes completas', () => {
  const selected = selectProgrammingRequests(requests, { includePending: false });
  assert.deepEqual(selected.map((request) => request.id), ['complete']);
  assert.notEqual(selected, requests);
});

test('programación con pendientes conserva todas las solicitudes del día', () => {
  const selected = selectProgrammingRequests(requests, { includePending: true });
  assert.deepEqual(selected.map((request) => request.id), requests.map((request) => request.id));
  assert.notEqual(selected, requests);
});

test('una descarga individual conserva la solicitud aunque esté pendiente', () => {
  const selected = selectProgrammingRequests([requests[1]], {
    includePending: false,
    requestId: requests[1].id
  });
  assert.deepEqual(selected.map((request) => request.id), ['confirmation']);
});

test('el flag includePending se interpreta de forma explícita', () => {
  assert.equal(normalizeProgrammingIncludePending(true, false), true);
  assert.equal(normalizeProgrammingIncludePending('on', false), true);
  assert.equal(normalizeProgrammingIncludePending('false', true), false);
  assert.equal(normalizeProgrammingIncludePending(undefined, false), false);
});

test('la fecha operativa permite resolver el día siguiente incluso entre años', () => {
  assert.equal(addDispatchIsoDays('2026-08-13', 1), '2026-08-14');
  assert.equal(addDispatchIsoDays('2026-12-31', 1), '2027-01-01');
});

test('el dashboard mantiene el envío flexible y agrega rango y Excel', async () => {
  const view = await readFile(new URL('../src/views/operacionesDashboard.ejs', import.meta.url), 'utf8');
  assert.match(view, /name="fechaDesde"/);
  assert.match(view, /name="fechaHasta"/);
  assert.match(view, /id="includePendingProgramming" type="checkbox"/);
  assert.match(view, /id="programExcelLink"/);
  assert.match(view, /id="sendProgramPdf"/);
  assert.match(view, /id="sendProgramExcel"/);
  assert.match(view, /id="sendProgramWhatsapp">Enviar<\/button>/);
  assert.doesNotMatch(view, /Enviar PDF por WhatsApp/);
  assert.match(view, /JSON\.stringify\(\{fecha:selectedDate,managedBy:currentManager\(\),includePending,formats,recipientPhones\}\)/);
  assert.doesNotMatch(view, /if\(!programmingComplete\)/);
});

test('el envío manual permite marcar uno, varios o todos los destinatarios configurados', async () => {
  const view = await readFile(new URL('../src/views/operacionesDashboard.ejs', import.meta.url), 'utf8');
  const route = await readFile(new URL('../src/routes/dispatchProgrammingNotifications.js', import.meta.url), 'utf8');
  assert.match(view, /id="programRecipientChoices"/);
  assert.match(view, /programacion\/destinatarios-envio/);
  assert.match(view, /data-program-recipient/);
  assert.match(view, /input\.checked=true/);
  assert.match(view, /Selecciona al menos un destinatario/);
  assert.match(route, /router\.get\('\/programacion\/destinatarios-envio'/);
  assert.match(route, /selectProgrammingWhatsappRecipients\(eligibleRecipients, req\.body\?\.recipientPhones\)/);
});

test('reclutador-general ve nombre y número en los destinatarios permitidos', async () => {
  const view = await readFile(new URL('../src/views/operacionesDashboard.ejs', import.meta.url), 'utf8');
  const route = await readFile(new URL('../src/routes/dispatchProgrammingNotifications.js', import.meta.url), 'utf8');
  assert.match(route, /function isGeneralRecruiter\(req\) \{[\s\S]*=== 'reclutador-general'/);
  assert.match(route, /showRecipientPhones: userRole\(req\) === 'dev' \|\| isGeneralRecruiter\(req\)/);
  assert.match(view, /data\.showRecipientPhones&&recipient\.phone\?`\$\{recipientName\} · \$\{recipient\.phone\}`:recipientName/);
});

test('backend filtra la selección manual contra los destinatarios configurados', async () => {
  const { selectProgrammingWhatsappRecipients } = await import('../src/routes/dispatchProgrammingNotifications.js');
  const configured = [
    { name: 'Contacto A', phone: '0000000000' },
    { name: 'Contacto B', phone: '0000000001' }
  ];
  const selected = selectProgrammingWhatsappRecipients(configured, ['0000000001', '9999999999']);
  assert.deepEqual(selected.map((recipient) => recipient.name), ['Contacto B']);
  assert.equal(selectProgrammingWhatsappRecipients(configured, undefined).length, 2);
  assert.equal(selectProgrammingWhatsappRecipients(configured, []).length, 0);
});

test('destinatarios Solo DEV no se exponen ni se pueden inyectar en un envío normal', async () => {
  const {
    filterProgrammingWhatsappRecipientsForRole,
    normalizeProgrammingWhatsappRecipients,
    selectProgrammingWhatsappRecipients
  } = await import('../src/routes/dispatchProgrammingNotifications.js');
  const configured = [
    { name: 'Contacto reservado', phone: '0000000000', devOnly: true },
    { name: 'Contacto operativo', phone: '0000000001', devOnly: false }
  ];
  const normalized = normalizeProgrammingWhatsappRecipients(configured);
  assert.equal(normalized[0].devOnly, true);
  assert.equal(normalized[1].devOnly, false);
  assert.deepEqual(filterProgrammingWhatsappRecipientsForRole(configured, 'dev').map((item) => item.name), ['Contacto reservado', 'Contacto operativo']);
  const visibleForAdmin = filterProgrammingWhatsappRecipientsForRole(configured, 'admin');
  assert.deepEqual(visibleForAdmin.map((item) => item.name), ['Contacto operativo']);
  assert.deepEqual(selectProgrammingWhatsappRecipients(visibleForAdmin, ['0000000000']), []);
});

test('Programación se habilita por usuario y DEV siempre conserva acceso', async () => {
  const { resolveProgrammingAccess } = await import('../src/routes/dispatchProgrammingNotifications.js');
  const settings = { userAccess: ['operador-prueba'] };
  assert.equal(resolveProgrammingAccess(settings, { userRole: 'dev', username: 'dev-prueba' }).allowed, true);
  assert.equal(resolveProgrammingAccess(settings, { userRole: 'admin', username: 'operador-prueba' }).allowed, true);
  assert.equal(resolveProgrammingAccess(settings, { userRole: 'admin', username: 'otro-operador' }).allowed, false);
  assert.equal(resolveProgrammingAccess(settings, { userRole: 'admin' }).allowed, false);
});

test('la autoridad de Programación protege rutas y persiste acceso junto a formatos y contactos', async () => {
  const route = await readFile(new URL('../src/routes/dispatchProgrammingNotifications.js', import.meta.url), 'utf8');
  const browser = await readFile(new URL('../src/public/dispatch-programming-contacts.js', import.meta.url), 'utf8');
  assert.match(route, /metadata: \{ contacts: normalizedRecipients, formats: normalizedFormats, userAccess: normalizedUserAccess \}/);
  assert.match(route, /router\.get\('\/programacion\/acceso'/);
  assert.match(route, /router\.post\('\/programacion\/acceso', requireDev/);
  assert.match(route, /String\(req\.path \|\| ''\)\.startsWith\('\/programacion'\)/);
  assert.match(route, /Programación del día no está habilitada para este usuario/);
  assert.match(route, /filterProgrammingWhatsappRecipientsForRole\(settings\.recipients, userRole\(req\)\)/);
  assert.match(browser, /programmingCard\.hidden = true/);
  assert.match(browser, /fetch\('\/admin\/operaciones\/programacion\/acceso', \{ cache: 'no-store' \}\)/);
  assert.match(browser, /body: JSON\.stringify\(\{ username: user\.username, enabled: requested \}\)/);
  assert.match(browser, /data-recipient-dev-only/);
  assert.match(browser, /devOnly: Boolean\(row\.querySelector\('\[data-recipient-dev-only\]'\)\?\.checked\)/);
  assert.match(browser, /Solo DEV/);
});

test('el endpoint conserva incompletas y permite PDF o Excel', async () => {
  const route = await readFile(new URL('../src/routes/dispatchProgrammingNotifications.js', import.meta.url), 'utf8');
  assert.doesNotMatch(route, /if \(!summary\.isComplete\)/);
  assert.match(route, /normalizeProgrammingIncludePending\(req\.body\?\.includePending, false\)/);
  assert.match(route, /router\.get\('\/programacion\.xlsx'/);
  assert.match(route, /normalizeProgrammingFormats\(req\.body\?\.formats, settings\.formats\)/);
  assert.match(route, /formats\.includes\('pdf'\)/);
  assert.match(route, /formats\.includes\('excel'\)/);
  assert.match(route, /selectProgrammingRequests\(loaded\.requests, \{ includePending \}\)/);
});

test('PDF y Excel se persisten como configuración y sobreviven a una recarga', async () => {
  const route = await readFile(new URL('../src/routes/dispatchProgrammingNotifications.js', import.meta.url), 'utf8');
  const browser = await readFile(new URL('../src/public/dispatch-programming-contacts.js', import.meta.url), 'utf8');
  assert.match(route, /metadata: \{ contacts: normalizedRecipients, formats: normalizedFormats, userAccess: normalizedUserAccess \}/);
  assert.match(route, /router\.get\('\/programacion\/formatos'/);
  assert.match(route, /router\.post\('\/programacion\/formatos'/);
  assert.match(route, /saveProgrammingWhatsappFormats\(prisma/);
  assert.match(browser, /fetch\('\/admin\/operaciones\/programacion\/formatos', \{ cache: 'no-store' \}\)/);
  assert.match(browser, /JSON\.stringify\(\{ formats: selected \}\)/);
  assert.match(browser, /let applyingFormats = false/);
  assert.match(browser, /if \(applyingFormats \|\| programmingCard\.hidden\) return/);
});

test('Programación pide Hoy o Mañana antes de preguntar el formato', async () => {
  const {
    buildDispatchProgrammingDateMenuPayload,
    buildDispatchReportMenuPayload
  } = await import('../src/services/dispatchWhatsappCloudClient.js');
  const reportMenu = buildDispatchReportMenuPayload({ phone: '0000000000', name: 'Contacto' });
  const programmingButton = reportMenu.interactive.action.buttons.find((button) => button.reply.title === 'Programación');
  assert.equal(programmingButton?.reply.id, 'dispatch_report:programming_today');
  const dateMenu = buildDispatchProgrammingDateMenuPayload({ phone: '0000000000' });
  assert.deepEqual(
    dateMenu.interactive.action.buttons.map((button) => [button.reply.id, button.reply.title]),
    [
      ['dispatch_report:programming_date_today', 'Hoy'],
      ['dispatch_report:programming_date_tomorrow', 'Mañana']
    ]
  );
});

test('Resumen del día pregunta Hoy o Mañana antes de responder', async () => {
  const {
    buildDispatchReportMenuPayload,
    buildDispatchSummaryDateMenuPayload
  } = await import('../src/services/dispatchWhatsappCloudClient.js');
  const reportMenu = buildDispatchReportMenuPayload({ phone: '0000000000', name: 'Contacto' });
  const summaryButton = reportMenu.interactive.action.buttons.find((button) => button.reply.title === 'Resumen del día');
  assert.equal(summaryButton?.reply.id, 'dispatch_report:summary');
  const dateMenu = buildDispatchSummaryDateMenuPayload({ phone: '0000000000' });
  assert.deepEqual(
    dateMenu.interactive.action.buttons.map((button) => [button.reply.id, button.reply.title]),
    [
      ['dispatch_report:summary_date_today', 'Hoy'],
      ['dispatch_report:summary_date_tomorrow', 'Mañana']
    ]
  );
  const webhook = await readFile(new URL('../src/routes/dispatchWhatsappWebhook.js', import.meta.url), 'utf8');
  assert.match(webhook, /dispatch_report:summary'\) return \{ type: 'SUMMARY_DATE' \}/);
  assert.match(webhook, /dispatch_report:summary_date_today'\) return \{ type: 'SUMMARY', dateChoice: 'today' \}/);
  assert.match(webhook, /dispatch_report:summary_date_tomorrow'\) return \{ type: 'SUMMARY', dateChoice: 'tomorrow' \}/);
  assert.match(webhook, /dispatch_report:summary_today'\) return \{ type: 'SUMMARY', dateChoice: 'today' \}/);
  assert.match(webhook, /sendProgrammingSummary\(prisma, contact, selectedDate\)/);
});

test('cada fecha ofrece exactamente PDF, Excel y Ambos', async () => {
  const client = await readFile(new URL('../src/services/dispatchWhatsappCloudClient.js', import.meta.url), 'utf8');
  for (const dateChoice of ['today', 'tomorrow']) {
    assert.match(client, new RegExp(`dispatch_report:programming_${dateChoice}_pdf`));
    assert.match(client, new RegExp(`dispatch_report:programming_${dateChoice}_excel`));
    assert.match(client, new RegExp(`dispatch_report:programming_${dateChoice}_both`));
  }
  assert.match(client, /¿En qué formato deseas recibir la programación de/);
});

test('la elección inbound transporta fecha y formato sin usar los checks persistidos', async () => {
  const webhook = await readFile(new URL('../src/routes/dispatchWhatsappWebhook.js', import.meta.url), 'utf8');
  assert.match(webhook, /dispatch_report:programming_today'\) return \{ type: 'PROGRAMMING_DATE' \}/);
  assert.match(webhook, /dispatch_report:programming_date_today'\) return \{ type: 'PROGRAMMING_FORMAT', dateChoice: 'today' \}/);
  assert.match(webhook, /dispatch_report:programming_date_tomorrow'\) return \{ type: 'PROGRAMMING_FORMAT', dateChoice: 'tomorrow' \}/);
  assert.match(webhook, /addDispatchIsoDays\(today, 1\)/);
  assert.match(webhook, /sendProgrammingContactDocuments\(prisma, contact, action\.formats, selectedDate\)/);
  assert.doesNotMatch(webhook, /settings\.formats/);
});

test('el envío documental inbound acepta la fecha seleccionada', async () => {
  const route = await readFile(new URL('../src/routes/dispatchProgrammingNotifications.js', import.meta.url), 'utf8');
  assert.match(route, /sendProgrammingContactDocuments\(prisma, contact, formatSelection, selectedDate = todayIsoDateCO\(\)\)/);
  assert.match(route, /normalizeProgrammingDate\(selectedDate \|\| todayIsoDateCO\(\)\)/);
});

test('el envío manual saluda por nombre antes de documentos cuando la ventana está abierta', async () => {
  const route = await readFile(new URL('../src/routes/dispatchProgrammingNotifications.js', import.meta.url), 'utf8');
  assert.match(route, /if \(windowStatus\.isOpen\) \{[\s\S]*const introText = `Hola, \$\{recipient\.name\}\. Te envío la programación del día \$\{dateLabel\}\.`/);
  assert.match(route, /sendDispatchWhatsappTextMessage\(\{ scope: 'operational', phone: recipient\.phone, text: introText \}\)/);
  assert.match(route, /No se enviaron los archivos porque falló el mensaje introductorio/);
});

test('la ayuda DEV separa los checks manuales de la elección inbound', async () => {
  const browser = await readFile(new URL('../src/public/dispatch-programming-contacts.js', import.meta.url), 'utf8');
  assert.match(browser, /Los checks PDF\/Excel se usan para los envíos manuales/);
  assert.match(browser, /se le pregunta si la quiere en PDF, Excel o ambos/);
});

test('el envío manual usa sesión abierta antes de exigir plantilla', async () => {
  const route = await readFile(new URL('../src/routes/dispatchProgrammingNotifications.js', import.meta.url), 'utf8');
  assert.match(route, /getDispatchWhatsappContactWindowStatus/);
  assert.match(route, /windowStatus\.isOpen[\s\S]*sendDispatchWhatsappDocumentMessage[\s\S]*sendDispatchWhatsappMediaMessage/);
  assert.match(route, /deliveryMode: windowStatus\.isOpen \? 'session' : 'template'/);
});

test('programación tiene defaults canónicos de plantilla y lenguaje', async () => {
  const config = await readFile(new URL('../src/services/dispatchWhatsappCloudConfig.js', import.meta.url), 'utf8');
  assert.match(config, /DEFAULT_PROGRAMMING_TEMPLATE_NAME = 'dispatch_programming_document'/);
  assert.match(config, /DEFAULT_TEMPLATE_LANGUAGE = 'es'/);
  assert.match(config, /programmingTemplateName:[\s\S]*DEFAULT_PROGRAMMING_TEMPLATE_NAME/);
  assert.match(config, /templateLanguage:[\s\S]*DEFAULT_TEMPLATE_LANGUAGE/);
});

test('normalización conserva exactamente PDF y Excel cuando ambos se eligen', async () => {
  const { normalizeProgrammingFormats } = await import('../src/routes/dispatchProgrammingNotifications.js');
  assert.deepEqual(normalizeProgrammingFormats(['pdf', 'excel']), ['pdf', 'excel']);
  assert.deepEqual(normalizeProgrammingFormats(['excel']), ['excel']);
  assert.deepEqual(normalizeProgrammingFormats([], ['pdf']), ['pdf']);
});

test('los indicadores cargan y conservan el rango seleccionado', async () => {
  const route = await readFile(new URL('../src/routes/dispatchDashboardMetrics.js', import.meta.url), 'utf8');
  assert.match(route, /function selectedDateRangeFromQuery/);
  assert.match(route, /loadServiceRequestsForRange\(prisma, range\)/);
  assert.match(route, /loadServiceRequestsForDate\(prisma, range\.to\)/);
  assert.match(route, /selectedDate:\s*dateRangeLabel\(range\)/);
});
