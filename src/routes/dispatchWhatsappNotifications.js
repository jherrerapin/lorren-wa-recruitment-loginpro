import express from 'express';
import {
  getDispatchWhatsappStatusView,
  sendDispatchWhatsappMessage
} from '../services/dispatchWhatsappCloudService.js';
import {
  loadDispatchWhatsappPhoneConversation,
  loadDispatchWhatsappTomorrowAssignmentMonitor,
  loadDispatchWhatsappWindowStatusForAssignments,
  normalizeDispatchWhatsappMonitorPhone,
  recordDispatchWhatsappMessageAudit
} from '../services/dispatchWhatsappMonitor.js';
import {
  DISPATCH_WINDOW_CHECK_BUTTON,
  DISPATCH_WINDOW_CHECK_MESSAGE,
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
const CONVERSATION_INBOX_PAGE_SIZE = 20;

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function positivePage(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 1000) : 1;
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

async function loadSelectedWorkerConversation(prisma, workerId) {
  const id = normalizeString(workerId);
  if (!id) return null;
  const worker = await prisma.dispatchWorker.findUnique({
    where: { id },
    select: { id: true, fullName: true, phone: true }
  });
  if (!worker?.phone) return null;
  const conversation = await loadDispatchWhatsappPhoneConversation({
    prismaClient: prisma,
    phone: worker.phone
  });
  return {
    workerId: worker.id,
    workerName: worker.fullName || 'Auxiliar',
    ...conversation
  };
}

function validDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function newestDate(...values) {
  return values
    .map(validDate)
    .filter(Boolean)
    .sort((left, right) => right.getTime() - left.getTime())[0] || null;
}

function formatDispatchPhone(value) {
  const phone = normalizeDispatchWhatsappMonitorPhone(value);
  if (!phone) return 'Sin número';
  if (/^57\d{10}$/.test(phone)) return `+57 ${phone.slice(2, 5)} ${phone.slice(5, 8)} ${phone.slice(8)}`;
  return `+${phone}`;
}

function addConversationEvidence(map, phoneValue, atValue) {
  const phone = normalizeDispatchWhatsappMonitorPhone(phoneValue);
  const at = validDate(atValue);
  if (!phone || !at) return;
  const current = map.get(phone);
  if (!current || at.getTime() > current.getTime()) map.set(phone, at);
}

function workerPhoneWhere(phones) {
  const suffixes = [...new Set((phones || [])
    .map((phone) => normalizeDispatchWhatsappMonitorPhone(phone).slice(-10))
    .filter(Boolean))];
  return suffixes.length ? { OR: suffixes.map((suffix) => ({ phone: { endsWith: suffix } })) } : null;
}

function providerStateFromLink(status) {
  const normalized = String(status || '').trim().toUpperCase();
  return ['DELIVERED', 'READ', 'FAILED', 'DELIVERY_UNKNOWN', 'CONFIRMED'].includes(normalized)
    ? normalized
    : null;
}

function assignmentMessageState({ linked, message }) {
  const linkedState = String(linked?.status || '').trim().toUpperCase();
  const providerState = String(message?.deliveryState || message?.providerStatus || '').trim().toUpperCase();
  if (linkedState === 'CONFIRMED') return 'CONFIRMED';
  if (message?.reconstructed) {
    if (linkedState === 'FAILED') return 'FAILED';
    if (linkedState === 'DELIVERY_UNKNOWN') return 'DELIVERY_UNKNOWN';
    if (linkedState === 'PENDING') return 'PENDING';
    return null;
  }
  if (providerState === 'DELIVERY_UNKNOWN' || linkedState === 'DELIVERY_UNKNOWN') return 'DELIVERY_UNKNOWN';
  if (['READ', 'DELIVERED', 'SENT', 'FAILED', 'ACCEPTED'].includes(providerState)) return providerState;
  if (linkedState === 'FAILED') return 'FAILED';
  if (linkedState === 'PENDING') return 'PENDING';
  if (normalizeString(linked?.providerMessageId)) return 'ACCEPTED';
  return null;
}

export async function loadDispatchWhatsappConversationInbox(prisma, {
  page = 1,
  pageSize = CONVERSATION_INBOX_PAGE_SIZE,
  now = new Date(),
  ownerUsername = null
} = {}) {
  if (!prisma) throw new Error('prisma es requerido');
  const normalizedPage = positivePage(page);
  const normalizedPageSize = Math.min(50, Math.max(1, Number(pageSize) || CONVERSATION_INBOX_PAGE_SIZE));
  const through = normalizedPage * normalizedPageSize + 1;
  const normalizedOwner = normalizeString(ownerUsername);

  const [auditGroups, windowRows, confirmationGroups] = await Promise.all([
    !normalizedOwner && prisma.devAuditEvent?.groupBy
      ? prisma.devAuditEvent.groupBy({
          by: ['entityLabel'],
          where: {
            entityType: 'DISPATCH_WHATSAPP_MESSAGE',
            action: { in: ['DISPATCH_WHATSAPP_INBOUND', 'DISPATCH_WHATSAPP_OUTBOUND'] },
            entityLabel: { not: null }
          },
          _max: { createdAt: true },
          orderBy: { _max: { createdAt: 'desc' } },
          take: through
        })
      : [],
    !normalizedOwner && prisma.dispatchWhatsappContactWindow?.findMany
      ? prisma.dispatchWhatsappContactWindow.findMany({
          where: { scope: 'operational' },
          select: { phone: true, lastInboundAt: true },
          orderBy: { lastInboundAt: 'desc' },
          take: through
        })
      : [],
    prisma.dispatchWhatsappConfirmation?.groupBy
      ? prisma.dispatchWhatsappConfirmation.groupBy({
          by: ['phone'],
          where: {
            ...(normalizedOwner ? { alertOwnerUsername: normalizedOwner } : { providerMessageId: { not: null } }),
            assignment: { serviceRequest: { source: { not: 'DEV_TEST' } } }
          },
          _max: { createdAt: true, confirmationReceivedAt: true },
          orderBy: { _max: { createdAt: 'desc' } },
          take: through
        })
      : []
  ]);

  const latestByPhone = new Map();
  for (const row of auditGroups || []) addConversationEvidence(latestByPhone, row.entityLabel, row?._max?.createdAt);
  for (const row of windowRows || []) addConversationEvidence(latestByPhone, row.phone, row.lastInboundAt);
  for (const row of confirmationGroups || []) {
    addConversationEvidence(latestByPhone, row.phone, row?._max?.createdAt);
    addConversationEvidence(latestByPhone, row.phone, row?._max?.confirmationReceivedAt);
  }

  const orderedPhones = [...latestByPhone.entries()]
    .sort((left, right) => right[1].getTime() - left[1].getTime())
    .map(([phone]) => phone);
  const offset = (normalizedPage - 1) * normalizedPageSize;
  const pagePhones = orderedPhones.slice(offset, offset + normalizedPageSize);
  const hasNext = orderedPhones.length > offset + normalizedPageSize;

  if (!pagePhones.length) {
    return {
      items: [],
      generatedAt: now.toISOString(),
      pagination: { page: normalizedPage, pageSize: normalizedPageSize, hasPrevious: normalizedPage > 1, hasNext: false },
      summary: { shown: 0, pending: 0, accepted: 0, sent: 0, failed: 0, deliveryUnknown: 0, delivered: 0, read: 0, confirmed: 0 },
      scope: 'operational'
    };
  }

  const pagePhoneWhere = workerPhoneWhere(pagePhones);
  const [conversations, confirmationRows, fallbackWorkers] = await Promise.all([
    Promise.all(pagePhones.map((phone) => loadDispatchWhatsappPhoneConversation({ prismaClient: prisma, phone, now }))),
    prisma.dispatchWhatsappConfirmation?.findMany
      ? prisma.dispatchWhatsappConfirmation.findMany({
          where: {
            ...(pagePhoneWhere || {}),
            ...(normalizedOwner ? { alertOwnerUsername: normalizedOwner } : {}),
            assignment: { serviceRequest: { source: { not: 'DEV_TEST' } } }
          },
          include: { assignment: { include: { worker: true, serviceRequest: true } } },
          orderBy: { createdAt: 'desc' }
        })
      : [],
    pagePhoneWhere && prisma.dispatchWorker?.findMany
      ? prisma.dispatchWorker.findMany({
          where: pagePhoneWhere,
          select: { id: true, fullName: true, phone: true }
        })
      : []
  ]);

  const linkedByProviderId = new Map();
  const latestLinkByPhone = new Map();
  for (const link of confirmationRows || []) {
    if (link?.assignment?.serviceRequest?.source === 'DEV_TEST') continue;
    const phone = normalizeDispatchWhatsappMonitorPhone(link.phone || link.assignment?.worker?.phone);
    if (!phone) continue;
    const providerMessageId = normalizeString(link.providerMessageId);
    if (providerMessageId && !linkedByProviderId.has(providerMessageId)) linkedByProviderId.set(providerMessageId, link);
    if (!latestLinkByPhone.has(phone)) latestLinkByPhone.set(phone, link);
  }

  const fallbackWorkersByPhone = new Map();
  for (const worker of fallbackWorkers || []) {
    const phone = normalizeDispatchWhatsappMonitorPhone(worker?.phone);
    if (!phone) continue;
    const bucket = fallbackWorkersByPhone.get(phone) || [];
    bucket.push(worker);
    fallbackWorkersByPhone.set(phone, bucket);
  }

  const items = conversations.map((conversation) => {
    const phone = normalizeDispatchWhatsappMonitorPhone(conversation.phone);
    const messages = Array.isArray(conversation.messageHistory) ? conversation.messageHistory : [];
    const lastMessage = messages.at(-1) || null;
    const lastOutbound = [...messages].reverse().find((item) => item.direction === 'OUTBOUND') || null;
    const exactLink = lastMessage?.providerMessageId ? linkedByProviderId.get(lastMessage.providerMessageId) : null;
    const linked = exactLink || latestLinkByPhone.get(phone) || null;
    const linkedWorker = linked?.assignment?.worker || null;
    const fallbackBucket = fallbackWorkersByPhone.get(phone) || [];
    const fallbackWorker = fallbackBucket.length === 1 ? fallbackBucket[0] : null;
    const knownNames = [...new Set([
      normalizeString(linkedWorker?.fullName),
      ...(Array.isArray(conversation.workerNames) ? conversation.workerNames.map(normalizeString) : []),
      normalizeString(fallbackWorker?.fullName)
    ].filter(Boolean))];
    const workerId = linkedWorker?.id || linked?.assignment?.workerId || fallbackWorker?.id || null;
    const workerName = normalizeString(linkedWorker?.fullName) || (knownNames.length ? knownNames.join(' / ') : null);
    const lastMessageAt = newestDate(lastMessage?.at, latestByPhone.get(phone))?.toISOString() || null;
    const historicalSent = Boolean(lastOutbound?.reconstructed && (lastOutbound?.providerStatus === 'SENT' || lastOutbound?.deliveryState === 'SENT'));
    const providerStatus = historicalSent ? null : (lastOutbound?.providerStatus || null);
    const deliveryState = historicalSent
      ? providerStateFromLink(linked?.status)
      : (lastOutbound?.deliveryState || providerStateFromLink(linked?.status) || providerStatus);
    const linkedProviderMessageId = normalizeString(linked?.providerMessageId);
    const assignmentMessage = [...messages].reverse().find((message) => {
      if (linkedProviderMessageId) return message.providerMessageId === linkedProviderMessageId;
      return message.source === 'ASSIGNMENT_CONFIRMATION_FAILED';
    }) || null;
    const assignmentState = assignmentMessageState({ linked, message: assignmentMessage });
    const assignmentUpdatedAt = newestDate(
      assignmentMessage?.providerStatusAt,
      assignmentMessage?.at,
      linked?.updatedAt,
      linked?.confirmationReceivedAt,
      linked?.createdAt
    )?.toISOString() || null;

    return {
      phone,
      phoneDisplay: conversation.phoneDisplay || formatDispatchPhone(phone),
      workerId,
      workerName,
      workerNames: knownNames,
      lastMessageAt,
      lastMessageDirection: lastMessage?.direction || null,
      lastMessageBody: lastMessage?.body || 'Hay evidencia de conversación, pero el contenido exacto no está disponible.',
      lastMessageType: lastMessage?.messageType || 'UNKNOWN',
      lastMessageSource: lastMessage?.source || null,
      messageCount: Number(conversation.messageCount || messages.length || 0),
      providerMessageId: lastOutbound?.providerMessageId || linkedProviderMessageId,
      providerStatus,
      deliveryState,
      providerStatusAt: historicalSent ? null : (lastOutbound?.providerStatusAt || null),
      providerDiagnostic: lastOutbound?.providerDiagnostic || null,
      reconstructed: Boolean(lastMessage?.reconstructed || lastOutbound?.reconstructed),
      assignmentMessageState: assignmentState,
      assignmentMessageUpdatedAt: assignmentUpdatedAt,
      assignmentMessageFailedBeforeAcceptance: assignmentState === 'FAILED' && !linkedProviderMessageId,
      assignmentMessageProviderId: linkedProviderMessageId,
      windowStatus: conversation.windowStatus,
      lastInboundAt: conversation.lastInboundAt
    };
  }).sort((left, right) => new Date(right.lastMessageAt || 0).getTime() - new Date(left.lastMessageAt || 0).getTime());

  return {
    items,
    generatedAt: now.toISOString(),
    pagination: {
      page: normalizedPage,
      pageSize: normalizedPageSize,
      hasPrevious: normalizedPage > 1,
      hasNext
    },
    summary: {
      shown: items.length,
      pending: items.filter((item) => item.assignmentMessageState === 'PENDING').length,
      accepted: items.filter((item) => item.assignmentMessageState === 'ACCEPTED').length,
      sent: items.filter((item) => item.assignmentMessageState === 'SENT').length,
      failed: items.filter((item) => item.assignmentMessageState === 'FAILED').length,
      deliveryUnknown: items.filter((item) => item.assignmentMessageState === 'DELIVERY_UNKNOWN').length,
      delivered: items.filter((item) => item.assignmentMessageState === 'DELIVERED').length,
      read: items.filter((item) => item.assignmentMessageState === 'READ').length,
      confirmed: items.filter((item) => item.assignmentMessageState === 'CONFIRMED').length
    },
    scope: 'operational'
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

export function dispatchWhatsappNotificationsRouter(prisma) {
  const router = express.Router();
  router.use(requireOps);

  router.get('/', async (req, res) => {
    const page = positivePage(req.query?.page);
    const isDevRequest = role(req) === 'dev';
    const viewerUsername = normalizeString(req.session?.username || req.username);
    const conversationWorkerId = isDevRequest ? normalizeString(req.query?.workerId) : null;
    const [status, automationSettings, conversationInbox, selectedConversation] = await Promise.all([
      getStatusForViewer(req),
      getAutomationSettingsForViewer(prisma, req),
      loadDispatchWhatsappConversationInbox(prisma, {
        page,
        ownerUsername: isDevRequest ? null : viewerUsername
      }),
      isDevRequest ? loadSelectedWorkerConversation(prisma, conversationWorkerId) : Promise.resolve(null)
    ]);
    res.render('operacionesWhatsappEstado', {
      pageTitle: 'WhatsApp de despacho',
      role: role(req),
      message: normalizeString(req.query?.message),
      settingsMessage: normalizeString(req.query?.settingsMessage),
      settingsError: normalizeString(req.query?.settingsError),
      automationSettings,
      conversationInbox,
      selectedConversation,
      whatsappTitle: isDevRequest ? 'WhatsApp oficial de despacho' : 'WhatsApp de despacho',
      whatsappEyebrow: 'Operaciones / Despacho',
      whatsappDescription: isDevRequest
        ? 'Integración directa con WhatsApp Business Platform de Meta. No usa QR, navegador automatizado ni dispositivos vinculados.'
        : 'Seguimiento de los mensajes de asignación enviados a tus auxiliares.',
      whatsappBasePath: '/admin/operaciones/whatsapp',
      whatsappReturnHref: '/admin/operaciones',
      whatsappReturnLabel: 'Volver a Operaciones',
      whatsappAssignmentsHref: '/admin/operaciones/asignaciones',
      whatsappAssignmentsLabel: 'Asignaciones',
      whatsappMonitorHref: isDevRequest ? '/admin/operaciones/whatsapp/monitor' : null,
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
      const phoneQuery = normalizeString(req.query?.phone) || '';
      const [monitor, status, phoneLookup] = await Promise.all([
        loadDispatchWhatsappTomorrowAssignmentMonitor({ prismaClient: prisma }),
        getDispatchWhatsappStatusView({ scope: 'operational' }),
        phoneQuery ? loadDispatchWhatsappPhoneConversation({ prismaClient: prisma, phone: phoneQuery }) : null
      ]);
      return res.render('operacionesWhatsappMonitor', {
        pageTitle: 'Ventanas 24 h de asignados de mañana · WhatsApp Despacho · DEV',
        role: role(req),
        monitor,
        phoneQuery,
        phoneLookup,
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

  router.get('/monitor/datos', requireDevMonitor, async (req, res, next) => {
    try {
      const phoneQuery = normalizeString(req.query?.phone) || '';
      const [monitor, phoneLookup] = await Promise.all([
        loadDispatchWhatsappTomorrowAssignmentMonitor({ prismaClient: prisma }),
        phoneQuery ? loadDispatchWhatsappPhoneConversation({ prismaClient: prisma, phone: phoneQuery }) : null
      ]);
      return res.json({ ok: true, ...monitor, phoneQuery, phoneLookup });
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
