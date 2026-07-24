import express from 'express';
import { closeDispatchWhatsappSession, getDispatchWhatsappStatusView, initDispatchWhatsappClient, sendDispatchWhatsappMessage } from '../services/dispatchWhatsappWebService.js';

const OPERATIONAL_SESSION_ERROR = 'La conexión de WhatsApp de despacho no está disponible en este momento. Actualiza el estado o contacta al responsable técnico.';
const ASSIGNMENT_MESSAGE_TYPE = 'DISPATCH_ASSIGNMENT_CONFIRMATION_REQUEST';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function role(req) {
  return req.session?.userRole || req.userRole;
}

function allowed(req) {
  const username = normalizeString(req.session?.username || req.username);
  return role(req) === 'dev' || Boolean(req.session?.canAccessDispatch || req.canAccessDispatch) || Boolean(username?.startsWith('operaciones-despacho'));
}

function requireOps(req, res, next) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  const userRole = role(req);
  if (!userRole) return res.status(401).json({ ok: false, message: 'Debes iniciar sesión.' });
  if (!allowed(req)) return res.status(403).json({ ok: false, message: 'Módulo no habilitado para este usuario.' });
  return next();
}

function normalizeContext(context) {
  if (!context || typeof context !== 'object') return undefined;
  return {
    serviceRequestId: normalizeString(context.serviceRequestId),
    assignmentId: normalizeString(context.assignmentId),
    workerId: normalizeString(context.workerId),
    recipientName: normalizeString(context.recipientName),
    messageType: normalizeString(context.messageType) || ASSIGNMENT_MESSAGE_TYPE
  };
}

function validateAssignmentContext(context) {
  if (!context?.assignmentId || !context?.serviceRequestId || !context?.workerId) {
    const error = new Error('No se envió WhatsApp porque falta el contexto completo de la asignación. Recarga la pantalla e intenta nuevamente.');
    error.statusCode = 400;
    throw error;
  }
  return context;
}

function viewerStatus(req, status) {
  const isDev = role(req) === 'dev';
  const technicalLastError = status.lastError || null;
  return {
    ...status,
    isDev,
    lastError: technicalLastError && !isDev ? OPERATIONAL_SESSION_ERROR : technicalLastError,
    technicalLastError: isDev ? technicalLastError : null
  };
}

async function getStatusForViewer(req, { autoStart = true } = {}) {
  return viewerStatus(req, await getDispatchWhatsappStatusView({ autoStart }));
}

export function dispatchWhatsappNotificationsRouter(_prisma) {
  const router = express.Router();
  router.use(requireOps);

  router.get('/', async (req, res) => {
    initDispatchWhatsappClient();
    const status = await getStatusForViewer(req, { autoStart: false });
    res.render('operacionesWhatsappEstado', { pageTitle: 'WhatsApp de despacho', role: role(req), message: normalizeString(req.query?.message), ...status });
  });

  router.get('/estado', async (req, res) => {
    const shouldStart = req.query?.start === '0' || req.query?.start === 'false' ? false : true;
    res.json({ ok: true, ...await getStatusForViewer(req, { autoStart: shouldStart }) });
  });

  router.post('/cerrar-sesion', async (_req, res) => {
    await closeDispatchWhatsappSession();
    const message = encodeURIComponent('Sesión de WhatsApp despacho cerrada. Escanea un nuevo QR para volver a conectar.');
    return res.redirect(`/admin/operaciones/whatsapp?message=${message}`);
  });

  router.post('/enviar', async (req, res) => {
    try {
      const context = validateAssignmentContext(normalizeContext(req.body?.context));
      const result = await sendDispatchWhatsappMessage({ phone: req.body?.phone, message: req.body?.message, context });
      return res.json({ ok: true, providerMessageId: result.providerMessageId, phone: result.phone });
    } catch (error) {
      const statusCode = error?.statusCode === 503 ? 503 : 400;
      const message = statusCode === 503 && role(req) !== 'dev' ? OPERATIONAL_SESSION_ERROR : (error?.message || 'No se pudo enviar el mensaje.');
      return res.status(statusCode).json({ ok: false, message });
    }
  });

  return router;
}
