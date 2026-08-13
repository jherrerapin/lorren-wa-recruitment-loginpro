import express from 'express';
import {
  getDispatchWhatsappStatusView,
  sendDispatchWhatsappMessage
} from '../services/dispatchWhatsappCloudService.js';
import {
  loadDispatchWhatsappTomorrowAssignmentMonitor,
  loadDispatchWhatsappWindowStatusForAssignments,
  recordDispatchWhatsappMessageAudit
} from '../services/dispatchWhatsappMonitor.js';
import {
  DISPATCH_WINDOW_CHECK_BUTTON,
  DISPATCH_WINDOW_CHECK_MESSAGE,
  buildDispatchAssignmentMessageBody,
  dispatchWhatsappProviderErrorMessage,
  sendCloudWindowCheckTemplate,
  sendDispatchWhatsappTextMessage
} from '../services/dispatchWhatsappCloudClient.js';
import {
  loadDispatchWhatsappAutomationSettings,
  normalizeDispatchAutomationTime,
  saveDispatchWhatsappAutomationSettings
} from '../services/dispatchWhatsappAdminAlerts.js';

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

async function findCurrentDispatchAppUser(prisma, req) {
  const userId = normalizeString(req.session?.userId || req.userId);
  if (userId) {
    const byId = await prisma.appUser.findUnique({ where: { id: userId } });
    if (byId) return byId;
  }
  const username = normalizeString(req.session?.username || req.username);
  if (!username) return null;
  return prisma.appUser.findUnique({ where: { username } });
}

async function getAutomationSettingsForViewer(prisma, req) {
  const user = await findCurrentDispatchAppUser(prisma, req);
  if (!user) {
    return {
      available: false,
      assignmentAutoSendTime: null,
      pendingConfirmationAlertTime: null,
      alertPhoneConfigured: false
    };
  }
  const settings = await loadDispatchWhatsappAutomationSettings({ prismaClient: prisma, userId: user.id });
  return {
    available: true,
    ...settings,
    alertPhoneConfigured: Boolean(user.dispatchAlertPhone)
  };
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

async function auditAssignmentSend(prisma, context, result) {
  const assignment = await prisma.dispatchAssignment.findFirst({
    where: {
      id: context.assignmentId,
      serviceRequestId: context.serviceRequestId,
      workerId: context.workerId
    },
    include: { worker: true, serviceRequest: { include: { operationPoint: true } } }
  });
  if (!assignment) return;
  await recordDispatchWhatsappMessageAudit({
    prismaClient: prisma,
    scope: 'operational',
    direction: 'OUTBOUND',
    phone: result.phone,
    body: `${buildDispatchAssignmentMessageBody(assignment)}\n\n[Botones: CONFIRMADO · REPORTAR NOVEDAD]`,
    messageType: result.deliveryMode === 'TEMPLATE' ? 'TEMPLATE' : 'INTERACTIVE',
    providerMessageId: result.providerMessageId,
    source: 'ASSIGNMENT_CONFIRMATION',
    occurredAt: new Date()
  });
}

export function dispatchWhatsappNotificationsRouter(prisma) {
  const router = express.Router();
  router.use(requireOps);

  router.get('/', async (req, res) => {
    const [status, automationSettings] = await Promise.all([
      getStatusForViewer(req),
      getAutomationSettingsForViewer(prisma, req)
    ]);
    res.render('operacionesWhatsappEstado', {
      pageTitle: 'WhatsApp de despacho',
      role: role(req),
      message: normalizeString(req.query?.message),
      settingsMessage: normalizeString(req.query?.settingsMessage),
      settingsError: normalizeString(req.query?.settingsError),
      automationSettings,
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

  router.post('/programacion-automatica', express.urlencoded({ extended: false }), async (req, res) => {
    const redirectWith = (key, message) => {
      const params = new URLSearchParams({ [key]: message });
      return res.redirect(`/admin/operaciones/whatsapp?${params.toString()}`);
    };
    try {
      const user = await findCurrentDispatchAppUser(prisma, req);
      if (!user) return redirectWith('settingsError', 'No fue posible asociar esta configuración a tu usuario.');

      const rawAuto = String(req.body?.dispatchAssignmentAutoSendTime || '').trim();
      const rawPending = String(req.body?.dispatchPendingConfirmationAlertTime || '').trim();
      const assignmentAutoSendTime = normalizeDispatchAutomationTime(rawAuto);
      const pendingConfirmationAlertTime = normalizeDispatchAutomationTime(rawPending);
      if ((rawAuto && !assignmentAutoSendTime) || (rawPending && !pendingConfirmationAlertTime)) {
        return redirectWith('settingsError', 'Indica horarios válidos en formato de 24 horas.');
      }
      if (pendingConfirmationAlertTime && !user.dispatchAlertPhone) {
        return redirectWith('settingsError', 'Configura primero tu WhatsApp personal de alertas en el panel de Operaciones.');
      }
      if (assignmentAutoSendTime && pendingConfirmationAlertTime && pendingConfirmationAlertTime <= assignmentAutoSendTime) {
        return redirectWith('settingsError', 'La hora del reporte de pendientes debe ser posterior a la hora de envío de confirmaciones.');
      }

      await saveDispatchWhatsappAutomationSettings({
        prismaClient: prisma,
        userId: user.id,
        assignmentAutoSendTime,
        pendingConfirmationAlertTime
      });
      return redirectWith('settingsMessage', 'Horarios de Bogotá guardados correctamente.');
    } catch (error) {
      console.warn('[dispatch-wa-schedule-settings] No fue posible guardar la configuración.', error?.message || error);
      return redirectWith('settingsError', 'No fue posible guardar los horarios. Intenta nuevamente.');
    }
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
        pageTitle: 'Ventanas 24 h de asignados de mañana · WhatsApp Despacho · DEV',
        role: role(req),
        monitor,
        windowCheckTemplateName: status.windowCheckTemplateName || null,
        windowCheckMessage: DISPATCH_WINDOW_CHECK_MESSAGE,
        windowCheckButton: DISPATCH_WINDOW_CHECK_BUTTON,
        monitorDataEndpoint: '/admin/operaciones/whatsapp/monitor/datos',
        bulkSendEndpoint: '/admin/operaciones/whatsapp/monitor/enviar-verificacion-ventana',
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

  router.post('/monitor/enviar-verificacion-ventana', requireDevMonitor, async (_req, res, next) => {
    try {
      const monitor = await loadDispatchWhatsappTomorrowAssignmentMonitor({ prismaClient: prisma });
      const missing = monitor.items.filter((item) => item.canSendWindowCheck);
      const results = [];

      for (const item of missing) {
        try {
          const result = await sendCloudWindowCheckTemplate({
            scope: 'operational',
            assignmentId: item.assignmentId,
            phone: item.phone
          });
          await recordDispatchWhatsappMessageAudit({
            prismaClient: prisma,
            scope: 'operational',
            direction: 'OUTBOUND',
            phone: item.phone,
            body: `${DISPATCH_WINDOW_CHECK_MESSAGE}\n\n[Botón: ${DISPATCH_WINDOW_CHECK_BUTTON}]`,
            messageType: 'TEMPLATE',
            providerMessageId: result.providerMessageId,
            source: 'WINDOW_CHECK_TEMPLATE',
            occurredAt: new Date()
          });
          results.push({
            assignmentId: item.assignmentId,
            workerName: item.workerName,
            ok: true,
            providerMessageId: result.providerMessageId,
            templateName: result.templateName
          });
        } catch (error) {
          results.push({
            assignmentId: item.assignmentId,
            workerName: item.workerName,
            ok: false,
            message: error?.message || 'No fue posible enviar la verificación de ventana.'
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
        alreadyOpen: monitor.summary.open,
        withoutPhone: monitor.summary.withoutPhone,
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
      if (!item.phone) return res.status(409).json({ ok: false, message: 'El auxiliar no tiene un teléfono disponible para intentar el envío.' });

      const providerMessageId = await sendDispatchWhatsappTextMessage({
        scope: 'operational',
        phone: item.phone,
        text: message
      });
      await recordDispatchWhatsappMessageAudit({
        prismaClient: prisma,
        scope: 'operational',
        direction: 'OUTBOUND',
        phone: item.phone,
        body: message,
        messageType: 'TEXT',
        providerMessageId,
        dedupeKey: `dev-manual:${assignmentId}:${Date.now()}`,
        source: 'DEV_MANUAL',
        occurredAt: new Date()
      });
      return res.json({
        ok: true,
        assignmentId,
        workerName: item.workerName,
        providerMessageId,
        monitorStateWasOpen: Boolean(item.isOpen)
      });
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
      await auditAssignmentSend(prisma, context, result);
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
