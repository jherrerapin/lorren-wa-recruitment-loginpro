import express from 'express';
import {
  getDispatchWhatsappStatusView,
  sendDispatchWhatsappMessage
} from '../services/dispatchWhatsappCloudService.js';
import {
  loadDispatchWhatsappTomorrowAssignmentMonitor,
  loadDispatchWhatsappWindowStatusForAssignments
} from '../services/dispatchWhatsappMonitor.js';
import {
  dispatchWhatsappProviderErrorMessage,
  sendDispatchWhatsappTextMessage
} from '../services/dispatchWhatsappCloudClient.js';

const OPERATIONAL_API_ERROR = 'La integración oficial de WhatsApp de despacho no está disponible en este momento. Revisa su configuración o contacta al responsable técnico.';
const ASSIGNMENT_MESSAGE_TYPE = 'DISPATCH_ASSIGNMENT_CONFIRMATION_REQUEST';
const MAX_ASSIGNMENT_WINDOW_IDS = 100;
const MAX_MANUAL_MESSAGE_LENGTH = 1200;

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
  const publicLastError = technicalLastError ? OPERATIONAL_API_ERROR : null;
  if (!isDev) {
    return {
      ready: Boolean(status.ready),
      isDev: false,
      lastError: publicLastError
    };
  }
  return {
    ...status,
    isDev: true,
    lastError: technicalLastError,
    technicalLastError
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

function assignmentIdsFromQuery(value) {
  return [...new Set(String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean))]
    .slice(0, MAX_ASSIGNMENT_WINDOW_IDS);
}

function manualMessageText(value) {
  const message = normalizeString(value);
  if (!message) return null;
  return message.slice(0, MAX_MANUAL_MESSAGE_LENGTH);
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
      whatsappTitle: role(req) === 'dev' ? 'WhatsApp oficial de despacho' : 'WhatsApp de despacho',
      whatsappEyebrow: 'Operaciones / Despacho',
      whatsappDescription: role(req) === 'dev'
        ? 'Integración directa con WhatsApp Business Platform de Meta. No usa QR, navegador automatizado ni dispositivos vinculados.'
        : 'Estado general del canal de WhatsApp usado por Despacho.',
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

  router.get('/ventanas-asignaciones', async (req, res, next) => {
    try {
      const assignmentIds = assignmentIdsFromQuery(req.query?.assignmentIds);
      if (!assignmentIds.length) return res.json({ ok: true, windows: [] });
      const assignments = await prisma.dispatchAssignment.findMany({
        where: { id: { in: assignmentIds } },
        include: { worker: true }
      });
      const statuses = await loadDispatchWhatsappWindowStatusForAssignments({ prismaClient: prisma, assignments });
      const windows = assignments.map((assignment) => {
        const status = statuses[assignment.id] || {};
        return {
          assignmentId: assignment.id,
          isOpen: Boolean(status.isOpen),
          expiresAt: status.expiresAt || null
        };
      });
      return res.json({ ok: true, windows });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/monitor', requireDevMonitor, async (req, res, next) => {
    try {
      const [monitor, status] = await Promise.all([
        loadDispatchWhatsappTomorrowAssignmentMonitor({ prismaClient: prisma }),
        getDispatchWhatsappStatusView({ scope: 'operational' })
      ]);
      return res.render('operacionesWhatsappMonitor', {
        pageTitle: 'Asignados de mañana · WhatsApp Despacho · DEV',
        role: role(req),
        monitor,
        assignmentTemplateName: status.assignmentTemplateName || null,
        monitorDataEndpoint: '/admin/operaciones/whatsapp/monitor/datos',
        bulkSendEndpoint: '/admin/operaciones/whatsapp/monitor/enviar-confirmaciones-manana',
        manualSendEndpoint: '/admin/operaciones/whatsapp/monitor/mensaje'
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/monitor/datos', requireDevMonitor, async (_req, res, next) => {
    try {
      const monitor = await loadDispatchWhatsappTomorrowAssignmentMonitor({ prismaClient: prisma });
      return res.json({ ok: true, ...monitor });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/monitor/enviar-confirmaciones-manana', requireDevMonitor, async (req, res, next) => {
    try {
      const monitor = await loadDispatchWhatsappTomorrowAssignmentMonitor({ prismaClient: prisma });
      const pending = monitor.items.filter((item) => item.canSendConfirmation);
      const results = [];
      const actorUsername = normalizeString(req.session?.username || req.username);

      for (const item of pending) {
        try {
          const result = await sendDispatchWhatsappMessage({
            phone: item.phone,
            context: {
              assignmentId: item.assignmentId,
              serviceRequestId: item.serviceRequestId,
              workerId: item.workerId,
              recipientName: item.workerName,
              messageType: ASSIGNMENT_MESSAGE_TYPE
            },
            scope: 'operational',
            actorUsername
          });
          results.push({
            assignmentId: item.assignmentId,
            workerName: item.workerName,
            ok: true,
            deliveryMode: result.deliveryMode,
            templateName: result.templateName || null
          });
        } catch (error) {
          results.push({
            assignmentId: item.assignmentId,
            workerName: item.workerName,
            ok: false,
            message: error?.message || 'No fue posible enviar la confirmación.'
          });
        }
      }

      const sent = results.filter((item) => item.ok).length;
      const failed = results.length - sent;
      return res.json({
        ok: failed === 0,
        dateKey: monitor.dateKey,
        attempted: results.length,
        sent,
        failed,
        skippedConfirmed: monitor.summary.confirmed,
        results
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/monitor/mensaje', requireDevMonitor, async (req, res) => {
    try {
      const assignmentId = normalizeString(req.body?.assignmentId);
      const message = manualMessageText(req.body?.message);
      if (!assignmentId || !message) {
        return res.status(400).json({ ok: false, message: 'Selecciona un auxiliar e indica el mensaje.' });
      }
      const monitor = await loadDispatchWhatsappTomorrowAssignmentMonitor({ prismaClient: prisma });
      const item = monitor.items.find((candidate) => candidate.assignmentId === assignmentId);
      if (!item) return res.status(404).json({ ok: false, message: 'La asignación ya no corresponde a mañana.' });
      if (!item.isOpen) {
        return res.status(409).json({
          ok: false,
          message: 'La ventana de 24 horas está cerrada. No se puede enviar texto libre hasta que el auxiliar responda o exista una plantilla aprobada para ese mensaje.'
        });
      }
      const providerMessageId = await sendDispatchWhatsappTextMessage({
        scope: 'operational',
        phone: item.phone,
        text: message
      });
      return res.json({ ok: true, assignmentId, workerName: item.workerName, providerMessageId });
    } catch (error) {
      return res.status(502).json({
        ok: false,
        message: dispatchWhatsappProviderErrorMessage(error)
      });
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
