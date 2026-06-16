import express from 'express';
import {
  getDispatchWhatsappStatus,
  initDispatchWhatsappClient,
  sendDispatchWhatsappMessage
} from '../services/dispatchWhatsappWebService.js';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function setNoStore(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

function isOpsUser(req) {
  const username = normalizeString(req.session?.username || req.username);
  return Boolean(username?.startsWith('operaciones-despacho'));
}

function canUseOps(req) {
  const role = req.session?.userRole || req.userRole;
  const canAccessDispatch = Boolean(req.session?.canAccessDispatch || req.canAccessDispatch);
  return role === 'dev' || canAccessDispatch || isOpsUser(req);
}

function requireOps(req, res, next) {
  setNoStore(res);
  const role = req.session?.userRole || req.userRole;
  if (!role) return res.status(401).json({ ok: false, message: 'Debes iniciar sesión.' });
  if (!canUseOps(req)) return res.status(403).json({ ok: false, message: 'Módulo no habilitado para este usuario.' });
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

export function dispatchWhatsappNotificationsRouter(_prisma) {
  initDispatchWhatsappClient();
  const router = express.Router();
  router.use(requireOps);

  router.get('/estado', (_req, res) => {
    res.json({ ok: true, ...getDispatchWhatsappStatus() });
  });

  router.post('/enviar', async (req, res) => {
    try {
      const result = await sendDispatchWhatsappMessage({
        phone: req.body?.phone,
        message: req.body?.message,
        context: normalizeContext(req.body?.context)
      });
      return res.json({ ok: true, providerMessageId: result.providerMessageId, phone: result.phone });
    } catch (error) {
      const statusCode = error?.statusCode === 503 ? 503 : 400;
      return res.status(statusCode).json({ ok: false, message: error?.message || 'No se pudo enviar el mensaje.' });
    }
  });

  return router;
}
