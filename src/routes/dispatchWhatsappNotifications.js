import express from 'express';
import {
  getDispatchWhatsappStatusView,
  sendDispatchWhatsappMessage
} from '../services/dispatchWhatsappCloudService.js';
import { loadDispatchWhatsappMonitorHistory } from '../services/dispatchWhatsappMonitor.js';

const OPERATIONAL_API_ERROR = 'La integración oficial de WhatsApp de despacho no está disponible en este momento. Revisa su configuración o contacta al responsable técnico.';
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
  return role(req) === 'dev'
    || Boolean(req.session?.canAccessDispatch || req.canAccessDispatch)
    || Boolean(username?.startsWith('operaciones-despacho'));
}

export function canAccessDispatchWhatsappMonitor(req) {
  return role(req) === 'dev';
}

function requireOps(req, res, next) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  const userRole = role(req);
  if (!userRole) return res.status(401).json({ ok: false, message: 'Debes iniciar sesión.' });
  if (!allowed(req)) return res.status(403).json({ ok: false, message: 'Módulo no habilitado para este usuario.' });
  return next();
}

function requireDevMonitor(req, res, next) {
  if (!canAccessDispatchWhatsappMonitor(req)) {
    return res.status(403).send('Monitor de WhatsApp de Despacho disponible solo para DEV.');
  }
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
  const publicLastError = technicalLastError && !isDev ? OPERATIONAL_API_ERROR : technicalLastError;
  return {
    ...status,
    isDev,
    lastError: publicLastError,
    technicalLastError: isDev ? technicalLastError : null
  };
}

async function getStatusForViewer(req) {
  return viewerStatus(req, await getDispatchWhatsappStatusView({ scope: 'operational' }));
}

function responseStatusCode(error) {
  const statusCode = Number(error?.statusCode || 0);
  if (statusCode >= 400 && statusCode <= 599) return statusCode;
  return 500;
}

export function dispatchWhatsappNotificationsRouter(prisma) {
  const router = express.Router();
  router.use(requireOps);

  router.get('/', async (req, res) => {
    const status = await getStatusForViewer(req);
    res.render('operacionesWhatsappEstado', {
      pageTitle: 'WhatsApp de despacho',
      role: role(req),
      message: normalizeString(req.query?.message),
      whatsappTitle: 'WhatsApp oficial de despacho',
      whatsappEyebrow: 'Operaciones / Despacho',
      whatsappDescription: 'Integración directa con WhatsApp Business Platform de Meta. No usa QR, navegador automatizado ni dispositivos vinculados.',
      whatsappBasePath: '/admin/operaciones/whatsapp',
      whatsappReturnHref: '/admin/operaciones',
      whatsappReturnLabel: 'Volver a Operaciones',
      whatsappAssignmentsHref: '/admin/operaciones/asignaciones',
      whatsappAssignmentsLabel: 'Asignaciones',
      whatsappMonitorHref: role(req) === 'dev' ? '/admin/operaciones/whatsapp/monitor' : null,
      ...status
    });
  });

  router.get('/estado', async (req, res) => {
    res.json({ ok: true, ...await getStatusForViewer(req) });
  });

  router.get('/monitor', requireDevMonitor, async (req, res, next) => {
    try {
      const history = await loadDispatchWhatsappMonitorHistory({ prismaClient: prisma, query: req.query });
      return res.render('operacionesWhatsappMonitor', {
        pageTitle: 'Monitor WhatsApp de Despacho · DEV',
        role: role(req),
        history,
        monitorDataEndpoint: '/admin/operaciones/whatsapp/monitor/datos'
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/monitor/datos', requireDevMonitor, async (req, res, next) => {
    try {
      const history = await loadDispatchWhatsappMonitorHistory({ prismaClient: prisma, query: req.query });
      return res.json({ ok: true, ...history });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/enviar', async (req, res) => {
    try {
      const context = validateAssignmentContext(normalizeContext(req.body?.context));
      const result = await sendDispatchWhatsappMessage({
        phone: req.body?.phone,
        context,
        scope: 'operational',
        actorUsername: normalizeString(req.session?.username || req.username)
      });
      return res.json({
        ok: true,
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        phone: result.phone,
        deliveryMode: result.deliveryMode,
        templateName: result.templateName
      });
    } catch (error) {
      const statusCode = responseStatusCode(error);
      const hideTechnical = statusCode >= 500 && role(req) !== 'dev';
      const message = hideTechnical ? OPERATIONAL_API_ERROR : (error?.message || 'No se pudo enviar el mensaje.');
      return res.status(statusCode).json({ ok: false, message });
    }
  });

  return router;
}
