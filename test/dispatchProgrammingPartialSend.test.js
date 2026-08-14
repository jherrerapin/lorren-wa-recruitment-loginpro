import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
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
  assert.match(view, /JSON\.stringify\(\{fecha:selectedDate,managedBy:currentManager\(\),includePending,formats\}\)/);
  assert.doesNotMatch(view, /if\(!programmingComplete\)/);
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
  assert.match(route, /metadata: \{ contacts: normalizedRecipients, formats: normalizedFormats \}/);
  assert.match(route, /router\.get\('\/programacion\/formatos'/);
  assert.match(route, /router\.post\('\/programacion\/formatos'/);
  assert.match(route, /saveProgrammingWhatsappFormats\(prisma/);
  assert.match(browser, /fetch\('\/admin\/operaciones\/programacion\/formatos', \{ cache: 'no-store' \}\)/);
  assert.match(browser, /JSON\.stringify\(\{ formats: selected \}\)/);
  assert.match(browser, /let applyingFormats = false/);
  assert.match(browser, /if \(applyingFormats\) return/);
});

test('Programación del día ofrece exactamente PDF, Excel y Ambos', async () => {
  const client = await readFile(new URL('../src/services/dispatchWhatsappCloudClient.js', import.meta.url), 'utf8');
  assert.match(client, /¿En qué formato deseas recibir la programación del día\?/);
  assert.match(client, /dispatch_report:programming_pdf', title: 'PDF'/);
  assert.match(client, /dispatch_report:programming_excel', title: 'Excel'/);
  assert.match(client, /dispatch_report:programming_both', title: 'Ambos'/);
  const formatButtons = client.match(/dispatch_report:programming_(?:pdf|excel|both)'/g) || [];
  assert.equal(formatButtons.length, 3);
});

test('la elección inbound usa el formato pulsado y no los checks persistidos', async () => {
  const webhook = await readFile(new URL('../src/routes/dispatchWhatsappWebhook.js', import.meta.url), 'utf8');
  assert.match(webhook, /dispatch_report:programming_today'\) return 'PROGRAMMING_FORMAT'/);
  assert.match(webhook, /action === 'PROGRAMMING_FORMAT'\) await sendProgrammingFormatMenu/);
  assert.match(webhook, /action === 'PROGRAMMING_PDF'\) await sendProgrammingContactDocuments\(prisma, contact, \['pdf'\]\)/);
  assert.match(webhook, /action === 'PROGRAMMING_EXCEL'\) await sendProgrammingContactDocuments\(prisma, contact, \['excel'\]\)/);
  assert.match(webhook, /action === 'PROGRAMMING_BOTH'\) await sendProgrammingContactDocuments\(prisma, contact, \['pdf', 'excel'\]\)/);
  assert.doesNotMatch(webhook, /settings\.formats/);
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
