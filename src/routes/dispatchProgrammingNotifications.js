import express from 'express';
import {
  buildProgrammingFilename,
  buildProgrammingPdfBuffer,
  buildProgrammingCompletionSummary,
  loadProgrammingRequests,
  normalizeProgrammingDate,
  normalizeProgrammingIncludePending
} from '../services/dispatchProgrammingPdfService.js';
import { sendDispatchWhatsappMediaMessage } from '../services/dispatchWhatsappCloudService.js';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeRecipient(entry) {
  if (!entry) return null;
  if (typeof entry === 'object') {
    const phone = normalizeString(entry.phone || entry.telefono || entry.number || entry.numero);
    if (!phone) return null;
    return { name: normalizeString(entry.name || entry.nombre) || 'Destinatario', phone };
  }
  const [rawName, rawPhone] = String(entry).split('|');
  const phone = normalizeString(rawPhone || rawName);
  if (!phone) return null;
  return {
    name: normalizeString(rawPhone ? rawName : null) || 'Destinatario',
    phone
  };
}

function parseRecipientList(value) {
  if (Array.isArray(value)) return value.map((entry) => normalizeRecipient(entry)).filter(Boolean);
  const configuredList = normalizeString(value);
  if (!configuredList) return [];
  return configuredList
    .split(/[\n,;]+/)
    .map((entry) => normalizeRecipient(entry))
    .filter(Boolean);
}

function loadProgrammingWhatsappRecipients() {
  return parseRecipientList(process.env.DISPATCH_PROGRAMMING_WHATSAPP_RECIPIENTS);
}

function userRole(req) {
  return req.session?.userRole || req.userRole;
}

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

export function dispatchProgrammingNotificationsRouter(prisma) {
  const router = express.Router();
  router.use(requireOps);

  router.get('/programacion.pdf', async (req, res) => {
    const selectedDate = normalizeProgrammingDate(req.query.fecha || req.query.date);
    const requestId = normalizeString(req.query.requestId);
    const managedBy = normalizeString(req.query.managedBy) || 'Julián Herrera';
    const includePending = normalizeProgrammingIncludePending(req.query.includePending, true);
    const result = await buildProgrammingPdfBuffer(prisma, { fecha: selectedDate, requestId, managedBy, includePending });
    const suffix = requestId ? 'solicitud' : (includePending ? 'con-pendientes' : 'confirmada');
    const filename = buildProgrammingFilename(result.selectedDate, suffix);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(result.buffer);
  });

  router.get('/programacion/estado', async (req, res) => {
    const selectedDate = normalizeProgrammingDate(req.query.fecha || req.query.date);
    const { requests } = await loadProgrammingRequests(prisma, selectedDate);
    res.json({ ok: true, selectedDate, ...buildProgrammingCompletionSummary(requests) });
  });

  router.post('/programacion/whatsapp', async (req, res) => {
    const recipients = loadProgrammingWhatsappRecipients();
    if (!recipients.length) {
      return res.status(503).json({
        ok: false,
        message: 'No hay destinatarios configurados para el envío de programación. Define DISPATCH_PROGRAMMING_WHATSAPP_RECIPIENTS.'
      });
    }

    const selectedDate = normalizeProgrammingDate(req.body?.fecha || req.body?.date);
    const managedBy = normalizeString(req.body?.managedBy) || 'Julián Herrera';
    const includePending = normalizeProgrammingIncludePending(req.body?.includePending, false);
    const pdf = await buildProgrammingPdfBuffer(prisma, { fecha: selectedDate, managedBy, includePending });
    const filename = buildProgrammingFilename(pdf.selectedDate, includePending ? 'con-pendientes' : 'confirmada');
    const templateValues = buildProgrammingTemplateValues({
      selectedDate: pdf.selectedDate,
      summary: pdf.summary,
      includedSummary: pdf.includedSummary,
      managedBy,
      includePending
    });
    const results = [];

    for (const recipient of recipients) {
      try {
        const result = await sendDispatchWhatsappMediaMessage({
          phone: recipient.phone,
          buffer: pdf.buffer,
          filename,
          mimeType: 'application/pdf',
          templateValues,
          scope: 'operational'
        });
        results.push({ name: recipient.name, phone: result.phone, ok: true, providerMessageId: result.providerMessageId });
      } catch (error) {
        results.push({ name: recipient.name, phone: recipient.phone, ok: false, message: error?.message || 'No se pudo enviar.' });
      }
    }

    const failed = results.filter((item) => !item.ok);
    return res.status(failed.length ? 207 : 200).json({
      ok: !failed.length,
      selectedDate: pdf.selectedDate,
      includePending,
      includedRequests: pdf.includedSummary.totalRequests,
      results
    });
  });

  return router;
}
