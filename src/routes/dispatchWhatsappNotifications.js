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
const SUPERVISOR_STATUS_PAGE_SIZE = 30;

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

function operationalRole(req) {
  return normalizeString(req.session?.operationalRole || req.operationalRole)?.toUpperCase() || null;
}

function isSupervisorView(req) {
  return role(req) !== 'dev' && operationalRole(req) === 'SUPERVISOR';
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

function requireSupervisorStatus(req, res, next) {
  if (!isSupervisorView(req)) {
    return res.status(403).json({ ok: false, message: 'Este estado está disponible para supervisores de Operaciones.' });
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

function supervisorAssignmentStatus(link, auditMetadata = {}) {
  const linkStatus = String(link?.status || '').trim().toUpperCase();
  const providerStatus = String(auditMetadata?.providerStatus || '').trim().toUpperCase();
  const watchdogStatus = String(auditMetadata?.deliveryWatchdogStatus || '').trim().toUpperCase();
  const providerAt = validDate(auditMetadata?.providerStatusAt);
  const receivedAt = validDate(link?.confirmationReceivedAt);
  const updatedAt = validDate(link?.updatedAt);
  const createdAt = validDate(link?.createdAt);
  const statusAt = (...values) => newestDate(...values)?.toISOString() || null;

  if (['CONFIRMED_REPLY_PENDING', 'CONFIRMED'].includes(linkStatus)) {
    return {
      key: 'CONFIRMED',
      label: 'Confirmado por el auxiliar',
      detail: 'El auxiliar respondió y confirmó la asignación.',
      at: statusAt(receivedAt, updatedAt, createdAt)
    };
  }
  if (linkStatus === 'NOVELTY_REPORTED') {
    return {
      key: 'NOVELTY',
      label: 'Novedad reportada',
      detail: 'El auxiliar respondió que tiene una novedad sobre la asignación.',
      at: statusAt(receivedAt, updatedAt, createdAt)
    };
  }
  if (linkStatus === 'FAILED' || providerStatus === 'FAILED') {
    return {
      key: 'FAILED',
      label: 'No se pudo enviar',
      detail: 'El mensaje no salió por WhatsApp. Puedes intentar enviarlo nuevamente desde Asignaciones; si vuelve a fallar, informa al responsable técnico.',
      at: statusAt(providerAt, updatedAt, createdAt)
    };
  }
  if (linkStatus === 'DELIVERY_UNKNOWN' || watchdogStatus === 'DELIVERY_UNKNOWN') {
    return {
      key: 'DELIVERY_UNKNOWN',
      label: 'Entrega sin confirmar',
      detail: 'WhatsApp no confirmó que el mensaje haya llegado al teléfono. Puedes reenviar la asignación desde Asignaciones; Lórren seguirá actualizando el estado si WhatsApp informa uno después.',
      at: statusAt(providerAt, updatedAt, createdAt)
    };
  }
  if (providerStatus === 'READ') {
    return {
      key: 'READ',
      label: 'Leído',
      detail: 'WhatsApp confirmó que el mensaje fue leído.',
      at: statusAt(providerAt, updatedAt, createdAt)
    };
  }
  if (providerStatus === 'DELIVERED') {
    return {
      key: 'DELIVERED',
      label: 'Entregado',
      detail: 'WhatsApp confirmó que el mensaje llegó al teléfono.',
      at: statusAt(providerAt, updatedAt, createdAt)
    };
  }
  if (providerStatus === 'SENT') {
    return {
      key: 'SENT',
      label: 'Enviado',
      detail: 'WhatsApp confirmó que el mensaje fue enviado.',
      at: statusAt(providerAt, updatedAt, createdAt)
    };
  }
  if (providerStatus === 'ACCEPTED' || normalizeString(link?.providerMessageId)) {
    return {
      key: 'ACCEPTED',
      label: 'Recibido por WhatsApp',
      detail: 'WhatsApp recibió la solicitud; todavía no ha confirmado que salió hacia el teléfono.',
      at: statusAt(providerAt, updatedAt, createdAt)
    };
  }
  if (linkStatus === 'EXPIRED') {
    return {
      key: 'EXPIRED',
      label: 'Solicitud vencida',
      detail: 'Esta solicitud dejó de estar activa.',
      at: statusAt(updatedAt, createdAt)
    };
  }
  if (linkStatus === 'DECLINED') {
    return {
      key: 'DECLINED',
      label: 'No confirmado por el auxiliar',
      detail: 'La asignación no quedó confirmada por el auxiliar.',
      at: statusAt(receivedAt, updatedAt, createdAt)
    };
  }
  return {
    key: 'PROCESSING',
    label: 'Procesando envío',
    detail: 'La solicitud todavía está en proceso de envío.',
    at: statusAt(updatedAt, createdAt)
  };
}

export async function loadDispatchWhatsappSupervisorAssignmentStatus(prisma, {
  ownerUsername,
  page = 1,
  pageSize = SUPERVISOR_STATUS_PAGE_SIZE,
  now = new Date()
} = {}) {
  if (!prisma?.dispatchWhatsappConfirmation?.findMany) throw new Error('prisma es requerido');
  const owner = normalizeString(ownerUsername);
  if (!owner) {
    return {
      items: [],
      generatedAt: now.toISOString(),
      pagination: { page: 1, pageSize: SUPERVISOR_STATUS_PAGE_SIZE, hasPrevious: false, hasNext: false },
      summary: { shown: 0, confirmed: 0, deliveredOrRead: 0, attention: 0 }
    };
  }
  const normalizedPage = positivePage(page);
  const normalizedPageSize = Math.min(50, Math.max(1, Number(pageSize) || SUPERVISOR_STATUS_PAGE_SIZE));
  const links = await prisma.dispatchWhatsappConfirmation.findMany({
    where: {
      alertOwnerUsername: owner,
      assignment: { serviceRequest: { source: { not: 'DEV_TEST' } } }
    },
    include: { assignment: { include: { worker: true, serviceRequest: true } } },
    orderBy: { createdAt: 'desc' }
  });

  const latestLinkByWorker = new Map();
  for (const link of links || []) {
    const assignment = link?.assignment || {};
    const worker = assignment.worker || {};
    const workerId = normalizeString(worker.id || assignment.workerId);
    const phone = normalizeDispatchWhatsappMonitorPhone(link.phone || worker.phone);
    const identityKey = workerId ? `worker:${workerId}` : (phone ? `phone:${phone}` : null);
    if (!identityKey || latestLinkByWorker.has(identityKey)) continue;
    latestLinkByWorker.set(identityKey, link);
  }

  const workerLinks = [...latestLinkByWorker.values()];
  const offset = (normalizedPage - 1) * normalizedPageSize;
  const pageLinks = workerLinks.slice(offset, offset + normalizedPageSize);
  const hasNext = workerLinks.length > offset + normalizedPageSize;
  const providerMessageIds = [...new Set(pageLinks.map((link) => normalizeString(link?.providerMessageId)).filter(Boolean))];
  const auditRows = providerMessageIds.length && prisma.devAuditEvent?.findMany
    ? await prisma.devAuditEvent.findMany({
        where: {
          entityType: 'DISPATCH_WHATSAPP_MESSAGE',
          action: 'DISPATCH_WHATSAPP_OUTBOUND',
          entityId: { in: providerMessageIds.map((id) => `dispatch-wa:outbound:${id}`) }
        },
        select: { entityId: true, metadata: true }
      })
    : [];
  const auditByProviderId = new Map();
  for (const row of auditRows || []) {
    const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    const providerMessageId = normalizeString(metadata.providerMessageId)
      || normalizeString(row?.entityId)?.replace(/^dispatch-wa:outbound:/, '');
    if (providerMessageId) auditByProviderId.set(providerMessageId, metadata);
  }

  const items = pageLinks.map((link) => {
    const providerMessageId = normalizeString(link?.providerMessageId);
    const status = supervisorAssignmentStatus(link, providerMessageId ? auditByProviderId.get(providerMessageId) : null);
    const assignment = link?.assignment || {};
    const worker = assignment.worker || {};
    const serviceRequest = assignment.serviceRequest || {};
    return {
      assignmentId: assignment.id || link.assignmentId,
      workerId: worker.id || assignment.workerId || null,
      workerName: normalizeString(worker.fullName) || 'Auxiliar',
      phoneDisplay: formatDispatchPhone(link.phone || worker.phone),
      sentAt: validDate(link.createdAt)?.toISOString() || null,
      serviceDate: validDate(serviceRequest.serviceDate)?.toISOString() || null,
      operationName: normalizeString(serviceRequest.operationPointName || serviceRequest.serviceName) || null,
      statusKey: status.key,
      statusLabel: status.label,
      statusDetail: status.detail,
      statusAt: status.at
    };
  });

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
      confirmed: items.filter((item) => item.statusKey === 'CONFIRMED').length,
      deliveredOrRead: items.filter((item) => ['DELIVERED', 'READ'].includes(item.statusKey)).length,
      attention: items.filter((item) => ['FAILED', 'DELIVERY_UNKNOWN', 'NOVELTY'].includes(item.statusKey)).length
    }
  };
}

export async function loadDispatchWhatsappConversationInbox(prisma, {
  page = 1,
  pageSize = CONVERSATION_INBOX_PAGE_SIZE,
  now = new Date()
} = {}) {
  if (!prisma) throw new Error('prisma es requerido');
  const normalizedPage = positivePage(page);
  const normalizedPageSize = Math.min(50, Math.max(1, Number(pageSize) || CONVERSATION_INBOX_PAGE_SIZE));
  const through = normalizedPage * normalizedPageSize + 1;

  const [auditGroups, windowRows, confirmationGroups] = await Promise.all([
    prisma.devAuditEvent?.groupBy
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
    prisma.dispatchWhatsappContactWindow?.findMany
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
            providerMessageId: { not: null },
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
      summary: { shown: 0, failed: 0, deliveryUnknown: 0, delivered: 0, read: 0 },
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
      providerMessageId: lastOutbound?.providerMessageId || normalizeString(linked?.providerMessageId),
      providerStatus,
      deliveryState,
      providerStatusAt: historicalSent ? null : (lastOutbound?.providerStatusAt || null),
      providerDiagnostic: lastOutbound?.providerDiagnostic || null,
      reconstructed: Boolean(lastMessage?.reconstructed || lastOutbound?.reconstructed),
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
      failed: items.filter((item) => item.deliveryState === 'FAILED').length,
      deliveryUnknown: items.filter((item) => item.deliveryState === 'DELIVERY_UNKNOWN').length,
      delivered: items.filter((item) => item.deliveryState === 'DELIVERED').length,
      read: items.filter((item) => item.deliveryState === 'READ').length
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
    const devView = role(req) === 'dev';
    const supervisorView = isSupervisorView(req);
    const conversationWorkerId = devView ? normalizeString(req.query?.workerId) : null;
    const ownerUsername = supervisorView ? normalizeString(req.session?.username || req.username) : null;
    const [status, automationSettings, conversationInbox, selectedConversation, supervisorAssignmentStatus] = await Promise.all([
      getStatusForViewer(req),
      getAutomationSettingsForViewer(prisma, req),
      devView ? loadDispatchWhatsappConversationInbox(prisma, { page }) : null,
      devView ? loadSelectedWorkerConversation(prisma, conversationWorkerId) : null,
      supervisorView ? loadDispatchWhatsappSupervisorAssignmentStatus(prisma, { ownerUsername, page }) : null
    ]);
    res.render('operacionesWhatsappEstado', {
      pageTitle: 'WhatsApp de despacho',
      role: role(req),
      operationalRole: operationalRole(req),
      message: normalizeString(req.query?.message),
      settingsMessage: normalizeString(req.query?.settingsMessage),
      settingsError: normalizeString(req.query?.settingsError),
      automationSettings,
      conversationInbox,
      selectedConversation,
      supervisorAssignmentStatus,
      whatsappTitle: devView ? 'WhatsApp oficial de despacho' : 'WhatsApp de despacho',
      whatsappEyebrow: 'Operaciones / Despacho',
      whatsappDescription: devView
        ? 'Integración directa con WhatsApp Business Platform de Meta. No usa QR, navegador automatizado ni dispositivos vinculados.'
        : supervisorView
          ? 'Seguimiento de los mensajes de asignación enviados por tu usuario.'
          : 'Estado general del canal de WhatsApp usado por Despacho.',
      whatsappBasePath: '/admin/operaciones/whatsapp',
      whatsappReturnHref: '/admin/operaciones',
      whatsappReturnLabel: 'Volver a Operaciones',
      whatsappAssignmentsHref: '/admin/operaciones/asignaciones',
      whatsappAssignmentsLabel: 'Asignaciones',
      whatsappMonitorHref: devView ? '/admin/operaciones/whatsapp/monitor' : null,
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

  router.get('/estado-mensajes-asignacion', requireSupervisorStatus, async (req, res, next) => {
    try {
      const ownerUsername = normalizeString(req.session?.username || req.username);
      const status = await loadDispatchWhatsappSupervisorAssignmentStatus(prisma, {
        ownerUsername,
        page: positivePage(req.query?.page)
      });
      return res.json({ ok: true, ...status });
    } catch (error) {
      return next(error);
    }
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
            body: `${DISPATCH_WINDOW_CHECK_MESSAGE}\
\
[Botón: ${DISPATCH_WINDOW_CHECK_BUTTON}]`,
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
