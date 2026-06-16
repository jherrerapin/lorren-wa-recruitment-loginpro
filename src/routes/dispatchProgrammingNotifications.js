import express from 'express';
import {
  buildProgrammingFilename,
  buildProgrammingPdfBuffer,
  buildProgrammingCompletionSummary,
  loadProgrammingRequests,
  normalizeProgrammingDate
} from '../services/dispatchProgrammingPdfService.js';
import { sendDispatchWhatsappMediaMessage } from '../services/dispatchWhatsappWebService.js';

const PROGRAMMING_WHATSAPP_RECIPIENTS = [
  { name: 'Milton Rodríguez', phone: '3057680685' },
  { name: 'Julie Jaso', phone: '3175868701' }
];

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
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

function buildCaption({ selectedDate, summary, managedBy }) {
  const manager = normalizeString(managedBy) || 'Julián Herrera';
  return [
    'Hola, compartimos la programación operativa completa.',
    '',
    `Fecha de servicio: ${selectedDate}`,
    `Solicitudes completas: ${summary.completedRequests}/${summary.totalRequests}`,
    `Auxiliares asignados: ${summary.assignedWorkers}/${summary.requiredWorkers}`,
    '',
    `Gestionado por: ${manager}`,
    'LoginPro Operaciones'
  ].join('\n');
}

export function dispatchProgrammingNotificationsRouter(prisma) {
  const router = express.Router();
  router.use(requireOps);

  router.get('/programacion.pdf', async (req, res) => {
    const selectedDate = normalizeProgrammingDate(req.query.fecha || req.query.date);
    const requestId = normalizeString(req.query.requestId);
    const managedBy = normalizeString(req.query.managedBy) || 'Julián Herrera';
    const result = await buildProgrammingPdfBuffer(prisma, { fecha: selectedDate, requestId, managedBy });
    const filename = buildProgrammingFilename(result.selectedDate, requestId ? 'solicitud' : 'completa');
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
    const selectedDate = normalizeProgrammingDate(req.body?.fecha || req.body?.date);
    const managedBy = normalizeString(req.body?.managedBy) || 'Julián Herrera';
    const { requests } = await loadProgrammingRequests(prisma, selectedDate);
    const summary = buildProgrammingCompletionSummary(requests);
    if (!summary.isComplete) {
      return res.status(400).json({
        ok: false,
        message: `La programación aún no está completa: ${summary.completedRequests}/${summary.totalRequests} solicitudes completas.`
      });
    }

    const pdf = await buildProgrammingPdfBuffer(prisma, { fecha: selectedDate, managedBy });
    const filename = buildProgrammingFilename(pdf.selectedDate, 'completa');
    const caption = buildCaption({ selectedDate: pdf.selectedDate, summary: pdf.summary, managedBy });
    const results = [];

    for (const recipient of PROGRAMMING_WHATSAPP_RECIPIENTS) {
      try {
        const result = await sendDispatchWhatsappMediaMessage({
          phone: recipient.phone,
          caption: `${recipient.name},\n\n${caption}`,
          buffer: pdf.buffer,
          filename,
          mimeType: 'application/pdf'
        });
        results.push({ name: recipient.name, phone: result.phone, ok: true, providerMessageId: result.providerMessageId });
      } catch (error) {
        results.push({ name: recipient.name, phone: recipient.phone, ok: false, message: error?.message || 'No se pudo enviar.' });
      }
    }

    const failed = results.filter((item) => !item.ok);
    return res.status(failed.length ? 207 : 200).json({ ok: !failed.length, selectedDate: pdf.selectedDate, results });
  });

  return router;
}
