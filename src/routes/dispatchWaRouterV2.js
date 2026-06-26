import express from 'express';
import { getDispatchWhatsappStatusView, initDispatchWhatsappClient, sendDispatchWhatsappMessage } from '../services/dispatchWhatsappWebServiceV2.js';

const OPERATIONAL_SESSION_ERROR = 'La conexión de WhatsApp de despacho no está disponible en este momento. Actualiza el estado o contacta al responsable técnico.';

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
    messageType: normalizeString(context.messageType)
  };
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

export function dispatchWhatsappNotificationsRouter(_prisma) {
  const router = express.Router();
  router.use(requireOps);

  router.get('/', async (req, res) => {
    initDispatchWhatsappClient();
    const status = viewerStatus(req, await getDispatchWhatsappStatusView({ autoStart: false }));
    res.render('operacionesWhatsappEstado', { pageTitle: 'WhatsApp de despacho', role: role(req), ...status });
  });

  router.get('/estado', async (req, res) => {
    const shouldStart = req.query?.start === '1' || req.query?.start === 'true';
    res.json({ ok: true, ...viewerStatus(req, await getDispatchWhatsappStatusView({ autoStart: shouldStart })) });
  });

  router.post('/enviar', async (req, res) => {
    try {
      const result = await sendDispatchWhatsappMessage({ phone: req.body?.phone, message: req.body?.message, context: normalizeContext(req.body?.context) });
      return res.json({ ok: true, providerMessageId: result.providerMessageId, phone: result.phone });
    } catch (error) {
      const statusCode = error?.statusCode === 503 ? 503 : 400;
      const message = statusCode === 503 && role(req) !== 'dev' ? OPERATIONAL_SESSION_ERROR : (error?.message || 'No se pudo enviar el mensaje.');
      return res.status(statusCode).json({ ok: false, message });
    }
  });

  return router;
}
