import express from 'express';
import ExcelJS from 'exceljs';
import { todayIsoDateCO } from '../services/dispatchDate.js';
import {
  buildProgrammingFilename,
  buildProgrammingPdfBuffer,
  buildProgrammingCompletionSummary,
  loadProgrammingRequests,
  normalizeProgrammingDate,
  normalizeProgrammingIncludePending,
  selectProgrammingRequests
} from '../services/dispatchProgrammingPdfService.js';
import {
  confirmedOperationalAssignments,
  deriveDispatchRequestOperationalState,
  operationalAssignments
} from '../services/dispatchOperationalCoverage.js';
import { getDispatchWhatsappContactWindowStatus } from '../services/dispatchWhatsappAdminAlerts.js';
import { normalizeDispatchWhatsappPhone } from '../services/dispatchWhatsappCloudConfig.js';
import {
  sendDispatchWhatsappDocumentMessage,
  sendDispatchWhatsappTextMessage
} from '../services/dispatchWhatsappCloudClient.js';
import { sendDispatchWhatsappMediaMessage } from '../services/dispatchWhatsappCloudService.js';
import { recordDispatchWhatsappMessageAudit } from '../services/dispatchWhatsappMonitor.js';

const PROGRAMMING_FORMATS = new Set(['pdf', 'excel']);
export const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const RANGE_TOKEN_PATTERN = /^(\d{4}-\d{2}-\d{2})\s+a\s+(\d{4}-\d{2}-\d{2})$/;
const PROGRAMMING_CONTACT_CONFIG_ENTITY = 'DISPATCH_PROGRAMMING_CONTACT_CONFIG';
const PROGRAMMING_CONTACT_CONFIG_ID = 'operational';
const PROGRAMMING_CONTACT_CONFIG_ACTION = 'SET_DISPATCH_PROGRAMMING_CONTACTS';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function programmingDateFromInput(value) {
  const raw = normalizeString(value);
  const range = raw?.match(RANGE_TOKEN_PATTERN);
  return normalizeProgrammingDate(range ? range[2] : raw);
}

function normalizeProgrammingContact(entry, { allowAnonymous = false } = {}) {
  if (!entry) return null;
  let name = null;
  let phone = null;
  if (typeof entry === 'object') {
    name = normalizeString(entry.name || entry.nombre);
    phone = normalizeDispatchWhatsappPhone(entry.phone || entry.telefono || entry.number || entry.numero);
  } else {
    const [rawName, rawPhone] = String(entry).split('|');
    name = normalizeString(rawPhone ? rawName : null);
    phone = normalizeDispatchWhatsappPhone(rawPhone || rawName);
  }
  if (!phone || (!name && !allowAnonymous)) return null;
  return { name: name || 'Destinatario', phone };
}

function isCompleteProgrammingContact(entry) {
  return Boolean(normalizeString(entry?.name || entry?.nombre)
    && normalizeDispatchWhatsappPhone(entry?.phone || entry?.telefono || entry?.number || entry?.numero));
}

export function normalizeProgrammingWhatsappRecipients(value, options = {}) {
  let entries = value;
  if (typeof value === 'string') {
    const configured = value.trim();
    if (!configured) return [];
    try {
      const parsed = JSON.parse(configured);
      entries = Array.isArray(parsed) ? parsed : [parsed];
    } catch (_error) {
      entries = configured.split(/[\n,;]+/);
    }
  }
  if (!Array.isArray(entries)) entries = entries ? [entries] : [];
  const recipientsByPhone = new Map();
  for (const entry of entries) {
    const recipient = normalizeProgrammingContact(entry, options);
    if (recipient) recipientsByPhone.set(recipient.phone, recipient);
  }
  return [...recipientsByPhone.values()];
}

export function selectProgrammingWhatsappRecipients(configuredRecipients = [], requestedPhones) {
  const recipients = normalizeProgrammingWhatsappRecipients(configuredRecipients);
  if (requestedPhones === undefined || requestedPhones === null) return recipients;
  const requested = Array.isArray(requestedPhones) ? requestedPhones : [requestedPhones];
  const selectedPhones = new Set(requested.map((phone) => normalizeDispatchWhatsappPhone(phone)).filter(Boolean));
  return recipients.filter((recipient) => selectedPhones.has(recipient.phone));
}

export function normalizeProgrammingFormats(value, fallback = ['pdf']) {
  const rawFormats = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/);
  const formats = [...new Set(rawFormats.map((item) => String(item || '').trim().toLowerCase()).filter((item) => PROGRAMMING_FORMATS.has(item)))];
  if (formats.length) return formats;
  return [...fallback].filter((item) => PROGRAMMING_FORMATS.has(item));
}

export async function loadProgrammingWhatsappSettings(prisma) {
  const stored = prisma?.devAuditEvent?.findFirst
    ? await prisma.devAuditEvent.findFirst({
      where: { entityType: PROGRAMMING_CONTACT_CONFIG_ENTITY, entityId: PROGRAMMING_CONTACT_CONFIG_ID, action: PROGRAMMING_CONTACT_CONFIG_ACTION },
      orderBy: { createdAt: 'desc' }
    })
    : null;
  if (stored) {
    return {
      recipients: normalizeProgrammingWhatsappRecipients(stored?.metadata?.contacts || []),
      formats: normalizeProgrammingFormats(stored?.metadata?.formats, ['pdf'])
    };
  }
  return {
    recipients: normalizeProgrammingWhatsappRecipients(process.env.DISPATCH_PROGRAMMING_WHATSAPP_RECIPIENTS, { allowAnonymous: true }),
    formats: ['pdf']
  };
}

export async function loadProgrammingWhatsappRecipients(prisma) {
  return (await loadProgrammingWhatsappSettings(prisma)).recipients;
}

async function persistProgrammingWhatsappSettings(prisma, { recipients, formats, actor = {}, actorSource }) {
  if (!prisma?.devAuditEvent?.create) throw new Error('No está disponible la persistencia de programación.');
  const normalizedRecipients = normalizeProgrammingWhatsappRecipients(recipients);
  const normalizedFormats = normalizeProgrammingFormats(formats, ['pdf']);
  await prisma.devAuditEvent.create({
    data: {
      entityType: PROGRAMMING_CONTACT_CONFIG_ENTITY,
      entityId: PROGRAMMING_CONTACT_CONFIG_ID,
      entityLabel: 'Configuración de programación',
      action: PROGRAMMING_CONTACT_CONFIG_ACTION,
      actorUserId: normalizeString(actor.userId),
      actorUsername: normalizeString(actor.username),
      actorRole: normalizeString(actor.role) || null,
      actorSource,
      metadata: { contacts: normalizedRecipients, formats: normalizedFormats }
    }
  });
  return { recipients: normalizedRecipients, formats: normalizedFormats };
}

export async function saveProgrammingWhatsappRecipients(prisma, { recipients = [], actor = {} } = {}) {
  const current = await loadProgrammingWhatsappSettings(prisma);
  return (await persistProgrammingWhatsappSettings(prisma, {
    recipients, formats: current.formats, actor, actorSource: 'dispatch-programming-contacts'
  })).recipients;
}

export async function saveProgrammingWhatsappFormats(prisma, { formats = [], actor = {} } = {}) {
  const current = await loadProgrammingWhatsappSettings(prisma);
  return (await persistProgrammingWhatsappSettings(prisma, {
    recipients: current.recipients, formats, actor, actorSource: 'dispatch-programming-formats'
  })).formats;
}

function userRole(req) { return req.session?.userRole || req.userRole; }
function isOpsUser(req) {
  const username = normalizeString(req.session?.username || req.username);
  return Boolean(username?.startsWith('operaciones-despacho'));
}
function canUseOps(req) {
  const role = userRole(req);
  const canAccessDispatch = Boolean(req.session?.canAccessDispatch || req.canAccessDispatch);
  return role === 'dev' || canAccessDispatch || isOpsUser(req);
}
function requireOps(req, res, next) {
  const role = userRole(req);
  if (!role) return res.redirect('/login');
  if (!canUseOps(req)) return res.status(403).send('Modulo no habilitado para este usuario');
  return next();
}
function requireDev(req, res, next) {
  if (userRole(req) !== 'dev') return res.status(403).json({ ok: false, message: 'Configuración disponible únicamente para DEV.' });
  return next();
}
function programmingActor(req) {
  return { userId: req.session?.userId || req.userId || null, username: req.session?.username || req.username || null, role: userRole(req) };
}

function buildProgrammingTemplateValues({ selectedDate, summary, includedSummary, managedBy, includePending }) {
  const manager = normalizeString(managedBy) || 'Julián Herrera';
  return {
    selectedDate,
    scopeLabel: includePending ? 'Completas y pendientes' : 'Solo solicitudes completas',
    requestsIncluded: String(includedSummary.totalRequests),
    completionLabel: `${summary.completedRequests}/${summary.totalRequests} solicitudes completas`,
    workersLabel: `${includedSummary.assignedWorkers}/${includedSummary.requiredWorkers} auxiliares incluidos`,
    managedBy: manager
  };
}

function requestStatusLabel(request) {
  const status = deriveDispatchRequestOperationalState(request).status;
  return ({ PENDING_ASSIGNMENT: 'Pendiente de asignación', ASSIGNMENT_PARTIAL: 'Asignación parcial', PENDING_CONFIRMATION: 'Pendiente de confirmación', ASSIGNMENT_COMPLETE: 'Asignación completa', CANCELLED: 'Cancelada' }[status] || status || 'Pendiente');
}
function assignmentStatusLabel(value) {
  return ({ ASSIGNED: 'Asignado', CONFIRMATION_PENDING: 'Pendiente de confirmación', CONFIRMED: 'Confirmado', NO_CONFIRMO: 'No confirmó', CANCELLED: 'Cancelado' }[value] || value || '-');
}
function buildScheduleLabel(request) { return request.endTime ? `${request.startTime || '-'} - ${request.endTime}` : (request.startTime || '-'); }
function workerDocumentLabel(worker) {
  const documentType = normalizeString(worker?.documentType);
  const documentNumber = normalizeString(worker?.documentNumber);
  if (documentType && documentNumber) return `${documentType} ${documentNumber}`;
  return documentNumber || 'Sin documento registrado';
}
function buildWorkersCell(request) {
  const assignments = operationalAssignments(request);
  if (!assignments.length) return 'Sin auxiliares asignados';
  return assignments.map((assignment, index) => {
    const worker = assignment.worker || {};
    return `${index + 1}. ${worker.fullName || 'Auxiliar'} · ${workerDocumentLabel(worker)} · ${assignmentStatusLabel(assignment.status)}`;
  }).join('\n');
}
function cleanSheetName(value, fallback) {
  const base = normalizeString(value) || fallback;
  return base.replace(/[\/*?:[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || fallback;
}
function groupByClient(requests = []) {
  const grouped = new Map();
  for (const request of requests) {
    const key = request.clientName || 'Sin cliente';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(request);
  }
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right, 'es'));
}

function styleProgrammingWorksheet(sheet, title, subtitle) {
  sheet.mergeCells('A1:I1');
  sheet.getCell('A1').value = title;
  sheet.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E2D3D' } };
  sheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.mergeCells('A2:I2');
  sheet.getCell('A2').value = subtitle;
  sheet.getCell('A2').font = { bold: true, color: { argb: 'FF0D7A6B' } };
  sheet.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };
  const header = sheet.getRow(3);
  header.values = ['Cliente', 'Operación', 'Servicio', 'Horario', 'Requeridos', 'Asignados', 'Confirmados', 'Estado', 'Auxiliares asignados'];
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D7A6B' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  sheet.columns = [{ width: 28 }, { width: 28 }, { width: 24 }, { width: 18 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 22 }, { width: 48 }];
  sheet.views = [{ state: 'frozen', ySplit: 3 }];
  sheet.autoFilter = { from: 'A3', to: 'I3' };
}
function addProgrammingRows(sheet, requests = []) {
  requests.forEach((request, index) => {
    const row = sheet.addRow([
      request.clientName || 'Sin cliente', request.operationPointName || 'Sin operación', request.serviceName || request.service?.name || 'Sin servicio',
      buildScheduleLabel(request), Number(request.requiredWorkers || 0), operationalAssignments(request).length,
      confirmedOperationalAssignments(request).length, requestStatusLabel(request), buildWorkersCell(request)
    ]);
    row.eachCell((cell) => {
      cell.alignment = { vertical: 'top', wrapText: true };
      if (index % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
    });
  });
}

export async function buildProgrammingExcelBuffer(prisma, { selectedDate, managedBy, includePending }) {
  const loaded = await loadProgrammingRequests(prisma, selectedDate);
  const requests = selectProgrammingRequests(loaded.requests, { includePending });
  const summary = buildProgrammingCompletionSummary(loaded.requests);
  const includedSummary = buildProgrammingCompletionSummary(requests);
  const manager = normalizeString(managedBy) || 'LoginPro Operaciones';
  const scope = includePending ? 'Completas y pendientes' : 'Solo solicitudes completas';
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Lórren Dispatch';
  workbook.created = new Date();
  const summarySheet = workbook.addWorksheet('Programación');
  styleProgrammingWorksheet(summarySheet, 'Programación operativa', `Fecha: ${loaded.selectedDate} · ${scope} · Gestionado por: ${manager}`);
  addProgrammingRows(summarySheet, requests);
  for (const [clientName, clientRequests] of groupByClient(requests)) {
    const sheet = workbook.addWorksheet(cleanSheetName(clientName, 'Cliente'));
    styleProgrammingWorksheet(sheet, clientName, `Fecha: ${loaded.selectedDate} · ${scope} · Gestionado por: ${manager}`);
    addProgrammingRows(sheet, clientRequests);
  }
  return { selectedDate: loaded.selectedDate, summary, includedSummary, includePending, buffer: Buffer.from(await workbook.xlsx.writeBuffer()) };
}
export function buildProgrammingExcelFilename(selectedDate, suffix = 'completa') {
  return `programacion-operativa-${suffix}-${selectedDate}.xlsx`.replace(/[^a-zA-Z0-9_.-]/g, '-');
}

export async function sendProgrammingContactDocuments(prisma, contact, formatSelection, selectedDate = todayIsoDateCO()) {
  const reportDate = normalizeProgrammingDate(selectedDate || todayIsoDateCO());
  const formats = normalizeProgrammingFormats(formatSelection, ['pdf']);
  const documents = [];
  if (formats.includes('pdf')) {
    const report = await buildProgrammingPdfBuffer(prisma, { fecha: reportDate, managedBy: 'LoginPro Operaciones', includePending: true });
    documents.push({ format: 'PDF', selectedDate: report.selectedDate, buffer: report.buffer, filename: buildProgrammingFilename(report.selectedDate, 'con-pendientes'), mimeType: 'application/pdf' });
  }
  if (formats.includes('excel')) {
    const report = await buildProgrammingExcelBuffer(prisma, { selectedDate: reportDate, managedBy: 'LoginPro Operaciones', includePending: true });
    documents.push({ format: 'Excel', selectedDate: report.selectedDate, buffer: report.buffer, filename: buildProgrammingExcelFilename(report.selectedDate, 'con-pendientes'), mimeType: XLSX_MIME_TYPE });
  }
  const sent = [];
  for (const document of documents) {
    const caption = `Programación del día — ${document.selectedDate} · ${document.format}`;
    const result = await sendDispatchWhatsappDocumentMessage({ scope: 'operational', phone: contact.phone, buffer: document.buffer, filename: document.filename, mimeType: document.mimeType, caption });
    await recordDispatchWhatsappMessageAudit({
      prismaClient: prisma, scope: 'operational', direction: 'OUTBOUND', phone: contact.phone,
      body: `[DOCUMENTO ${document.format.toUpperCase()}] ${caption}`, messageType: 'DOCUMENT',
      providerMessageId: result.providerMessageId, source: 'PROGRAMMING_CONTACT_REPORT', occurredAt: new Date()
    });
    sent.push({ ...document, caption, providerMessageId: result.providerMessageId });
  }
  return sent;
}

export function dispatchProgrammingNotificationsRouter(prisma) {
  const router = express.Router();
  router.use(requireOps);
  router.get('/programacion.pdf', async (req, res) => {
    const selectedDate = programmingDateFromInput(req.query.fecha || req.query.date);
    const requestId = normalizeString(req.query.requestId);
    const managedBy = normalizeString(req.query.managedBy) || 'Julián Herrera';
    const includePending = normalizeProgrammingIncludePending(req.query.includePending, true);
    const result = await buildProgrammingPdfBuffer(prisma, { fecha: selectedDate, requestId, managedBy, includePending });
    const suffix = requestId ? 'solicitud' : (includePending ? 'con-pendientes' : 'confirmada');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${buildProgrammingFilename(result.selectedDate, suffix)}"`);
    res.send(result.buffer);
  });
  router.get('/programacion.xlsx', async (req, res) => {
    const selectedDate = programmingDateFromInput(req.query.fecha || req.query.date);
    const managedBy = normalizeString(req.query.managedBy) || 'LoginPro Operaciones';
    const includePending = normalizeProgrammingIncludePending(req.query.includePending, true);
    const result = await buildProgrammingExcelBuffer(prisma, { selectedDate, managedBy, includePending });
    const suffix = includePending ? 'con-pendientes' : 'confirmada';
    res.setHeader('Content-Type', XLSX_MIME_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="${buildProgrammingExcelFilename(result.selectedDate, suffix)}"`);
    res.send(result.buffer);
  });
  router.get('/programacion/estado', async (req, res) => {
    const selectedDate = programmingDateFromInput(req.query.fecha || req.query.date);
    const { requests } = await loadProgrammingRequests(prisma, selectedDate);
    res.json({ ok: true, selectedDate, ...buildProgrammingCompletionSummary(requests) });
  });
  router.get('/programacion/formatos', async (_req, res) => {
    const settings = await loadProgrammingWhatsappSettings(prisma);
    return res.json({ ok: true, formats: settings.formats });
  });
  router.post('/programacion/formatos', async (req, res) => {
    const formats = normalizeProgrammingFormats(req.body?.formats, []);
    if (!formats.length) return res.status(400).json({ ok: false, message: 'Selecciona PDF, Excel o ambos.' });
    const saved = await saveProgrammingWhatsappFormats(prisma, { formats, actor: programmingActor(req) });
    return res.json({ ok: true, formats: saved });
  });
  router.get('/programacion/destinatarios-envio', async (_req, res) => {
    const recipients = await loadProgrammingWhatsappRecipients(prisma);
    return res.json({ ok: true, recipients });
  });
  router.get('/programacion/destinatarios', requireDev, async (_req, res) => {
    const settings = await loadProgrammingWhatsappSettings(prisma);
    return res.json({ ok: true, recipients: settings.recipients, formats: settings.formats });
  });
  router.post('/programacion/destinatarios', requireDev, async (req, res) => {
    const submittedRecipients = Array.isArray(req.body?.recipients) ? req.body.recipients : [];
    if (submittedRecipients.some((recipient) => !isCompleteProgrammingContact(recipient))) {
      return res.status(400).json({ ok: false, message: 'Cada destinatario debe tener nombre y teléfono válidos.' });
    }
    const recipients = await saveProgrammingWhatsappRecipients(prisma, { recipients: submittedRecipients, actor: programmingActor(req) });
    return res.json({ ok: true, recipients });
  });
  router.post('/programacion/whatsapp', async (req, res) => {
    const settings = await loadProgrammingWhatsappSettings(prisma);
    if (!settings.recipients.length) return res.status(503).json({ ok: false, message: 'No hay destinatarios configurados para el envío de programación.' });
    const recipients = selectProgrammingWhatsappRecipients(settings.recipients, req.body?.recipientPhones);
    if (!recipients.length) return res.status(400).json({ ok: false, message: 'Selecciona al menos un destinatario configurado.' });
    const selectedDate = programmingDateFromInput(req.body?.fecha || req.body?.date);
    const managedBy = normalizeString(req.body?.managedBy) || 'Julián Herrera';
    const includePending = normalizeProgrammingIncludePending(req.body?.includePending, false);
    const formats = normalizeProgrammingFormats(req.body?.formats, settings.formats);
    if (!formats.length) return res.status(400).json({ ok: false, message: 'Selecciona PDF, Excel o ambos.' });
    await saveProgrammingWhatsappFormats(prisma, { formats, actor: programmingActor(req) });
    const suffix = includePending ? 'con-pendientes' : 'confirmada';
    const documents = [];
    let documentContext = null;
    if (formats.includes('pdf')) {
      const pdf = await buildProgrammingPdfBuffer(prisma, { fecha: selectedDate, managedBy, includePending });
      documentContext ||= pdf;
      documents.push({ format: 'pdf', buffer: pdf.buffer, filename: buildProgrammingFilename(pdf.selectedDate, suffix), mimeType: 'application/pdf' });
    }
    if (formats.includes('excel')) {
      const excel = await buildProgrammingExcelBuffer(prisma, { selectedDate, managedBy, includePending });
      documentContext ||= excel;
      documents.push({ format: 'excel', buffer: excel.buffer, filename: buildProgrammingExcelFilename(excel.selectedDate, suffix), mimeType: XLSX_MIME_TYPE });
    }
    const templateValues = buildProgrammingTemplateValues({ selectedDate: documentContext.selectedDate, summary: documentContext.summary, includedSummary: documentContext.includedSummary, managedBy, includePending });
    const results = [];
    for (const recipient of recipients) {
      const windowStatus = await getDispatchWhatsappContactWindowStatus({ scope: 'operational', phone: recipient.phone, prismaClient: prisma });
      let introError = null;
      if (windowStatus.isOpen) {
        const dateLabel = String(documentContext.selectedDate || '').split('-').reverse().join('/');
        const introText = `Hola, ${recipient.name}. Te envío la programación del día ${dateLabel}.`;
        try {
          const providerMessageId = await sendDispatchWhatsappTextMessage({ scope: 'operational', phone: recipient.phone, text: introText });
          if (!providerMessageId) throw new Error('Meta no devolvió el identificador del mensaje introductorio.');
        } catch (error) {
          introError = error?.message || 'No se pudo enviar el mensaje introductorio.';
        }
      }
      for (const document of documents) {
        if (introError) {
          results.push({
            name: recipient.name,
            phone: recipient.phone,
            format: document.format,
            deliveryMode: 'session',
            ok: false,
            message: `No se enviaron los archivos porque falló el mensaje introductorio: ${introError}`
          });
          continue;
        }
        try {
          const result = windowStatus.isOpen
            ? await sendDispatchWhatsappDocumentMessage({ phone: recipient.phone, buffer: document.buffer, filename: document.filename, mimeType: document.mimeType, caption: `Programación operativa — ${documentContext.selectedDate}`, scope: 'operational' })
            : await sendDispatchWhatsappMediaMessage({ phone: recipient.phone, buffer: document.buffer, filename: document.filename, mimeType: document.mimeType, templateValues, scope: 'operational' });
          results.push({ name: recipient.name, phone: result.phone, format: document.format, deliveryMode: windowStatus.isOpen ? 'session' : 'template', ok: true, providerMessageId: result.providerMessageId });
        } catch (error) {
          results.push({ name: recipient.name, phone: recipient.phone, format: document.format, deliveryMode: windowStatus.isOpen ? 'session' : 'template', ok: false, message: error?.message || 'No se pudo enviar.' });
        }
      }
    }
    const failed = results.filter((item) => !item.ok);
    return res.status(failed.length ? 207 : 200).json({ ok: !failed.length, selectedDate: documentContext.selectedDate, includePending, formats, includedRequests: documentContext.includedSummary.totalRequests, results });
  });
  return router;
}
