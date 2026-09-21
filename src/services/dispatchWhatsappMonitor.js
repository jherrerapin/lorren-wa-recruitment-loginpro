import { buildDispatchServiceDateWhere, dispatchServiceDateKey, todayIsoDateCO } from './dispatchDate.js';
import { DISPATCH_WHATSAPP_WINDOW_MS } from './dispatchWhatsappAdminAlerts.js';
import { buildDispatchAssignmentMessageBody } from './dispatchWhatsappCloudClient.js';

const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const UNMATCHED_INBOUND_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DISPATCH_WHATSAPP_MESSAGE_ENTITY = 'DISPATCH_WHATSAPP_MESSAGE';
const MESSAGE_HISTORY_LIMIT = 20;
const MESSAGE_BODY_LIMIT = 4000;
const PROVIDER_DIAGNOSTIC_LIMIT = 500;
const PROVIDER_STATUS_RANK = new Map([
  ['ACCEPTED', 0],
  ['SENT', 1],
  ['DELIVERED', 2],
  ['READ', 3]
]);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizePhone(value) {
  const digits = phoneDigits(value);
  if (!digits) return '';
  return digits.length === 10 ? `57${digits}` : digits;
}

export function normalizeDispatchWhatsappMonitorPhone(value) {
  return normalizePhone(value);
}

function phoneIssue(value) {
  const digits = phoneDigits(value);
  if (!digits) return 'MISSING';
  if (digits.startsWith('57') && digits.length !== 12) return 'CO_LENGTH_MISMATCH';
  return null;
}

function addIsoDays(dateKey, days) {
  const [year, month, day] = String(dateKey || '').split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + Number(days || 0), 12, 0, 0));
  return date.toISOString().slice(0, 10);
}

function validDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function isoDate(value) {
  return validDate(value)?.toISOString() || null;
}

function latestDate(...values) {
  return values
    .map(validDate)
    .filter(Boolean)
    .sort((a, b) => b.getTime() - a.getTime())[0] || null;
}

function sanitizeProviderDiagnosticText(value) {
  return String(value || '')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(access[_-]?token|token)\s*[:=]\s*["']?[^"',;\s]+["']?/gi, '$1=[redacted]')
    .replace(/\b(wa_id|recipient|phone|to)\s*[:=]\s*["']?\+?\d{7,16}["']?/gi, '$1=[redacted]')
    .replace(/\+?\d{7,16}/g, '[redacted-number]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PROVIDER_DIAGNOSTIC_LIMIT);
}

function providerFailureDiagnostic(statusPayload = {}) {
  const errors = Array.isArray(statusPayload?.errors) ? statusPayload.errors : [];
  if (!errors.length) return 'Meta reportó FAILED sin detalle adicional.';
  const diagnostic = errors.slice(0, 3).map((error) => {
    const parts = [];
    if (error?.code !== undefined && error?.code !== null) parts.push(`code=${String(error.code).slice(0, 30)}`);
    if (error?.error_subcode !== undefined && error?.error_subcode !== null) parts.push(`subcode=${String(error.error_subcode).slice(0, 30)}`);
    if (text(error?.title)) parts.push(`title=${text(error.title)}`);
    if (text(error?.message)) parts.push(`message=${text(error.message)}`);
    if (text(error?.error_data?.details)) parts.push(`details=${text(error.error_data.details)}`);
    return parts.join(' ');
  }).filter(Boolean).join(' | ');
  return sanitizeProviderDiagnosticText(diagnostic || 'Meta reportó FAILED sin detalle adicional.');
}

function providerStatusOccurredAt(statusPayload = {}) {
  const timestamp = Number(statusPayload?.timestamp || 0);
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000) : new Date();
}

function shouldAdvanceProviderStatus(currentStatus, nextStatus) {
  if (nextStatus === 'FAILED') return currentStatus !== 'READ';
  if (currentStatus === 'FAILED') return false;
  const currentRank = PROVIDER_STATUS_RANK.get(currentStatus);
  const nextRank = PROVIDER_STATUS_RANK.get(nextStatus);
  return nextRank !== undefined && (currentRank === undefined || nextRank >= currentRank);
}

function windowSnapshot(lastInboundValue, now, evidenceSource = null) {
  const lastInboundAt = validDate(lastInboundValue);
  const expiresAt = lastInboundAt ? new Date(lastInboundAt.getTime() + DISPATCH_WHATSAPP_WINDOW_MS) : null;
  const isOpen = Boolean(expiresAt && now.getTime() < expiresAt.getTime());
  return {
    isOpen,
    windowStatus: isOpen ? 'ABIERTA' : 'CERRADA',
    lastInboundAt: lastInboundAt ? lastInboundAt.toISOString() : null,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    remainingMs: isOpen ? Math.max(0, expiresAt.getTime() - now.getTime()) : 0,
    evidenceSource
  };
}

function latestConfirmationEvidenceByPhone(rows = []) {
  const result = new Map();
  for (const row of rows) {
    const phone = normalizePhone(row?.phone);
    const receivedAt = validDate(row?.confirmationReceivedAt);
    if (!phone || !receivedAt) continue;
    const previous = result.get(phone);
    if (!previous || receivedAt.getTime() > previous.getTime()) result.set(phone, receivedAt);
  }
  return result;
}

async function healContactWindowFromEvidence({ prismaClient, phone, currentLastInboundAt, evidenceLastInboundAt }) {
  if (!phone || !evidenceLastInboundAt) return;
  const current = validDate(currentLastInboundAt);
  if (current && current.getTime() >= evidenceLastInboundAt.getTime()) return;
  await prismaClient.dispatchWhatsappContactWindow.upsert({
    where: { scope_phone: { scope: 'operational', phone } },
    create: { scope: 'operational', phone, lastInboundAt: evidenceLastInboundAt },
    update: { lastInboundAt: evidenceLastInboundAt }
  }).catch(() => {});
}

function possibleInboundMatch(phone, unmatchedInbound = []) {
  const digits = normalizePhone(phone);
  if (digits.length < 7) return null;
  const suffix = digits.slice(-7);
  const matches = unmatchedInbound.filter((item) => normalizePhone(item.phone).endsWith(suffix));
  return matches.length === 1 ? matches[0] : null;
}

async function loadWorkerNamesByPhone(prismaClient) {
  const result = new Map();
  if (!prismaClient?.dispatchWorker?.findMany) return result;
  const workers = await prismaClient.dispatchWorker.findMany({
    where: { phone: { not: null } },
    select: { fullName: true, phone: true }
  });
  for (const worker of workers) {
    const phone = normalizePhone(worker?.phone);
    const name = text(worker?.fullName);
    if (!phone || !name) continue;
    const names = result.get(phone) || new Set();
    names.add(name);
    result.set(phone, names);
  }
  return new Map([...result.entries()].map(([phone, names]) => [phone, [...names].sort((a, b) => a.localeCompare(b, 'es'))]));
}

function auditAction(direction) {
  return direction === 'INBOUND' ? 'DISPATCH_WHATSAPP_INBOUND' : 'DISPATCH_WHATSAPP_OUTBOUND';
}

export async function recordDispatchWhatsappMessageAudit({
  prismaClient,
  scope = 'operational',
  direction,
  phone,
  body = '',
  messageType = 'TEXT',
  messageId = null,
  providerMessageId = null,
  dedupeKey = null,
  source = null,
  occurredAt = new Date()
} = {}) {
  if (scope !== 'operational' || !prismaClient?.devAuditEvent?.create) return { recorded: false, reason: 'unsupported' };
  const normalizedPhone = normalizePhone(phone);
  const normalizedDirection = String(direction || '').trim().toUpperCase();
  const normalizedProviderMessageId = text(providerMessageId);
  const externalId = text(messageId) || normalizedProviderMessageId || text(dedupeKey);
  const eventDate = validDate(occurredAt) || new Date();
  if (!normalizedPhone || !['INBOUND', 'OUTBOUND'].includes(normalizedDirection) || !externalId) {
    return { recorded: false, reason: 'invalid' };
  }

  const entityId = `dispatch-wa:${normalizedDirection.toLowerCase()}:${externalId}`;
  try {
    if (prismaClient.devAuditEvent.findFirst) {
      const duplicate = await prismaClient.devAuditEvent.findFirst({
        where: { entityType: DISPATCH_WHATSAPP_MESSAGE_ENTITY, entityId },
        select: { id: true }
      });
      if (duplicate) return { recorded: false, duplicate: true };
    }
    const cleanBody = String(body || '').trim().slice(0, MESSAGE_BODY_LIMIT);
    await prismaClient.devAuditEvent.create({
      data: {
        entityType: DISPATCH_WHATSAPP_MESSAGE_ENTITY,
        entityId,
        entityLabel: normalizedPhone,
        action: auditAction(normalizedDirection),
        actorSource: source || 'whatsapp-dispatch',
        metadata: {
          scope: 'operational',
          direction: normalizedDirection,
          phone: normalizedPhone,
          body: cleanBody || null,
          messageType: String(messageType || 'UNKNOWN').toUpperCase(),
          messageId: text(messageId),
          providerMessageId: normalizedProviderMessageId,
          providerStatus: normalizedDirection === 'OUTBOUND' && normalizedProviderMessageId ? 'ACCEPTED' : null,
          providerStatusAt: normalizedDirection === 'OUTBOUND' && normalizedProviderMessageId ? eventDate.toISOString() : null,
          providerDiagnostic: null,
          source: source || null,
          occurredAt: eventDate.toISOString()
        },
        createdAt: eventDate
      }
    });
    return { recorded: true };
  } catch (_error) {
    console.warn('[dispatch-wa-audit] No fue posible persistir la auditoría de un mensaje de Despacho.');
    return { recorded: false, reason: 'storage_error' };
  }
}

export async function recordDispatchWhatsappProviderStatusAudit({
  prismaClient,
  scope = 'operational',
  providerMessageId,
  providerStatus,
  statusPayload = {}
} = {}) {
  const normalizedProviderMessageId = text(providerMessageId || statusPayload?.id);
  const normalizedStatus = String(providerStatus || statusPayload?.status || '').trim().toUpperCase();
  if (scope !== 'operational' || !normalizedProviderMessageId || !['SENT', 'DELIVERED', 'READ', 'FAILED'].includes(normalizedStatus)) {
    return { recorded: false, reason: 'invalid' };
  }
  if (!prismaClient?.devAuditEvent?.findFirst || !prismaClient?.devAuditEvent?.update) {
    return { recorded: false, reason: 'unsupported' };
  }
  const entityId = `dispatch-wa:outbound:${normalizedProviderMessageId}`;
  try {
    const row = await prismaClient.devAuditEvent.findFirst({
      where: {
        entityType: DISPATCH_WHATSAPP_MESSAGE_ENTITY,
        entityId,
        action: 'DISPATCH_WHATSAPP_OUTBOUND'
      },
      select: { id: true, metadata: true }
    });
    if (!row) return { recorded: false, reason: 'not_found' };
    const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    const currentStatus = String(metadata.providerStatus || '').trim().toUpperCase();
    if (!shouldAdvanceProviderStatus(currentStatus, normalizedStatus)) {
      return { recorded: false, reason: 'stale_status', status: currentStatus };
    }
    const statusAt = providerStatusOccurredAt(statusPayload);
    const diagnostic = normalizedStatus === 'FAILED' ? providerFailureDiagnostic(statusPayload) : null;
    await prismaClient.devAuditEvent.update({
      where: { id: row.id },
      data: {
        metadata: {
          ...metadata,
          providerStatus: normalizedStatus,
          providerStatusAt: statusAt.toISOString(),
          providerDiagnostic: diagnostic
        }
      }
    });
    return { recorded: true, status: normalizedStatus, statusAt: statusAt.toISOString(), diagnostic };
  } catch (_error) {
    console.warn('[dispatch-wa-audit] No fue posible actualizar el estado de entrega de Meta.');
    return { recorded: false, reason: 'storage_error' };
  }
}

function auditMessageFromRow(row) {
  const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const direction = String(metadata.direction || (row.action?.endsWith('INBOUND') ? 'INBOUND' : 'OUTBOUND')).toUpperCase();
  const providerStatus = text(metadata.providerStatus) || null;
  const providerDiagnostic = text(metadata.providerDiagnostic) || null;
  const baseBody = text(metadata.body) || '(mensaje sin texto)';
  const providerLine = direction === 'OUTBOUND' && providerStatus
    ? `[Meta: ${providerStatus}]${providerDiagnostic ? ` ${providerDiagnostic}` : ''}`
    : null;
  return {
    id: row.entityId || row.id,
    direction,
    body: providerLine ? `${baseBody}\n\n${providerLine}` : baseBody,
    messageType: text(metadata.messageType) || 'UNKNOWN',
    at: isoDate(metadata.occurredAt || row.createdAt),
    source: text(metadata.source) || 'AUDIT',
    messageId: text(metadata.messageId) || null,
    providerMessageId: text(metadata.providerMessageId) || null,
    providerStatus,
    providerStatusAt: isoDate(metadata.providerStatusAt),
    providerDiagnostic,
    persisted: true,
    reconstructed: false
  };
}

async function loadPersistedMessagesByPhone(prismaClient, phones = []) {
  const uniquePhones = [...new Set(phones.map(normalizePhone).filter(Boolean))];
  const result = new Map(uniquePhones.map((phone) => [phone, []]));
  if (!uniquePhones.length || !prismaClient?.devAuditEvent?.findMany) return result;
  const rows = await prismaClient.devAuditEvent.findMany({
    where: {
      entityType: DISPATCH_WHATSAPP_MESSAGE_ENTITY,
      entityLabel: { in: uniquePhones },
      action: { in: ['DISPATCH_WHATSAPP_INBOUND', 'DISPATCH_WHATSAPP_OUTBOUND'] }
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(1000, Math.max(100, uniquePhones.length * MESSAGE_HISTORY_LIMIT * 2))
  });
  for (const row of rows) {
    const phone = normalizePhone(row.entityLabel);
    if (!result.has(phone)) continue;
    const bucket = result.get(phone);
    if (bucket.length < MESSAGE_HISTORY_LIMIT) bucket.push(auditMessageFromRow(row));
  }
  return result;
}

function legacyDirectionLabel(status) {
  return status === 'NOVELTY_REPORTED' ? 'REPORTAR NOVEDAD' : 'CONFIRMADO';
}

function sameEvidenceId(message, id) {
  return Boolean(id && (message.messageId === id || message.providerMessageId === id));
}

function hasInboundNear(messages, value, toleranceMs = 5000) {
  const target = validDate(value);
  if (!target) return false;
  return messages.some((message) => {
    if (message.direction !== 'INBOUND') return false;
    const at = validDate(message.at);
    return at && Math.abs(at.getTime() - target.getTime()) <= toleranceMs;
  });
}

function addLegacyLinkMessages(messages, link, assignment) {
  if (link.providerMessageId && assignment && !messages.some((message) => sameEvidenceId(message, link.providerMessageId))) {
    messages.push({
      id: `legacy-out:${link.id}`,
      direction: 'OUTBOUND',
      body: `${buildDispatchAssignmentMessageBody(assignment)}\n\n[Botones: CONFIRMADO · REPORTAR NOVEDAD]`,
      messageType: 'INTERACTIVE',
      at: isoDate(link.createdAt),
      source: 'RECONSTRUIDO_ASIGNACION',
      messageId: null,
      providerMessageId: link.providerMessageId,
      persisted: false,
      reconstructed: true
    });
  }
  if (link.confirmationMessageId && link.confirmationReceivedAt
    && !messages.some((message) => sameEvidenceId(message, link.confirmationMessageId))) {
    messages.push({
      id: `legacy-in:${link.id}`,
      direction: 'INBOUND',
      body: legacyDirectionLabel(link.status),
      messageType: 'INTERACTIVE',
      at: isoDate(link.confirmationReceivedAt),
      source: 'RECONSTRUIDO_RESPUESTA',
      messageId: link.confirmationMessageId,
      providerMessageId: null,
      persisted: false,
      reconstructed: true
    });
  }
  const hasAuditedThanks = messages.some((message) => (
    message.direction === 'OUTBOUND'
    && message.body === 'Gracias.'
    && validDate(message.at)
    && validDate(link.confirmationReceivedAt)
    && validDate(message.at).getTime() >= validDate(link.confirmationReceivedAt).getTime()
  ));
  if (link.status === 'CONFIRMED' && link.confirmationReceivedAt && !hasAuditedThanks) {
    messages.push({
      id: `legacy-thanks:${link.id}`,
      direction: 'OUTBOUND',
      body: 'Gracias.',
      messageType: 'TEXT',
      at: isoDate(link.updatedAt || link.confirmationReceivedAt),
      source: 'RECONSTRUIDO_AUTO_REPLY',
      messageId: null,
      providerMessageId: null,
      persisted: false,
      reconstructed: true
    });
  }
}

function finalizeMessageHistory(messages, { lastInboundAt, evidenceId = 'phone' } = {}) {
  if (lastInboundAt && !hasInboundNear(messages, lastInboundAt)) {
    messages.push({
      id: `legacy-window:${evidenceId}:${lastInboundAt}`,
      direction: 'INBOUND',
      body: 'Mensaje recibido. El contenido exacto no se almacenaba todavía en el monitor de Despacho.',
      messageType: 'UNKNOWN',
      at: lastInboundAt,
      source: 'EVIDENCIA_VENTANA',
      messageId: null,
      providerMessageId: null,
      persisted: false,
      reconstructed: true
    });
  }
  return messages
    .filter((message) => message.at)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    .slice(-MESSAGE_HISTORY_LIMIT);
}

function legacyMessagesForAssignment({ assignment, links = [], window = {}, persistedMessages = [] }) {
  const messages = [...persistedMessages];
  for (const link of links) addLegacyLinkMessages(messages, link, assignment);
  return finalizeMessageHistory(messages, { lastInboundAt: window.lastInboundAt, evidenceId: assignment.id });
}

export async function loadDispatchWhatsappPhoneConversation({ prismaClient, phone, now = new Date() } = {}) {
  if (!prismaClient) throw new Error('prismaClient es requerido');
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    return {
      phone: '',
      phoneIssue: 'MISSING',
      hasEvidence: false,
      workerNames: [],
      messageHistory: [],
      messageCount: 0,
      ...windowSnapshot(null, now)
    };
  }

  const [windowRow, persistedByPhone, rawLinks] = await Promise.all([
    prismaClient.dispatchWhatsappContactWindow?.findUnique
      ? prismaClient.dispatchWhatsappContactWindow.findUnique({
          where: { scope_phone: { scope: 'operational', phone: normalizedPhone } }
        })
      : null,
    loadPersistedMessagesByPhone(prismaClient, [normalizedPhone]),
    prismaClient.dispatchWhatsappConfirmation?.findMany
      ? prismaClient.dispatchWhatsappConfirmation.findMany({
          where: { phone: normalizedPhone },
          include: { assignment: { include: { worker: true, serviceRequest: true } } },
          orderBy: { createdAt: 'asc' },
          take: 100
        })
      : []
  ]);
  const links = (rawLinks || []).filter((link) => link.assignment?.serviceRequest?.source !== 'DEV_TEST');
  const contactInbound = validDate(windowRow?.lastInboundAt);
  const confirmationInbound = latestDate(...links.map((link) => link.confirmationReceivedAt));
  const effectiveInbound = latestDate(contactInbound, confirmationInbound);
  const evidenceSource = effectiveInbound
    ? (confirmationInbound && (!contactInbound || confirmationInbound.getTime() > contactInbound.getTime())
        ? 'CONFIRMATION_EVIDENCE'
        : 'CONTACT_WINDOW')
    : null;
  if (evidenceSource === 'CONFIRMATION_EVIDENCE') {
    await healContactWindowFromEvidence({
      prismaClient,
      phone: normalizedPhone,
      currentLastInboundAt: contactInbound,
      evidenceLastInboundAt: confirmationInbound
    });
  }
  const window = windowSnapshot(effectiveInbound, now, evidenceSource);
  const messages = [...(persistedByPhone.get(normalizedPhone) || [])];
  for (const link of links) addLegacyLinkMessages(messages, link, link.assignment);
  const messageHistory = finalizeMessageHistory(messages, {
    lastInboundAt: window.lastInboundAt,
    evidenceId: normalizedPhone
  });
  const workerNames = [...new Set(links
    .map((link) => text(link.assignment?.worker?.fullName))
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'es'));

  return {
    phone: normalizedPhone,
    phoneIssue: phoneIssue(normalizedPhone),
    hasEvidence: Boolean(messageHistory.length || window.lastInboundAt || links.length),
    workerNames,
    messageHistory,
    messageCount: messageHistory.length,
    ...window
  };
}

export function tomorrowIsoDateCO(now = new Date()) {
  return addIsoDays(todayIsoDateCO(now), 1);
}

export async function loadDispatchWhatsappWindowStatusForAssignments({
  prismaClient,
  assignments = [],
  now = new Date()
} = {}) {
  if (!prismaClient) throw new Error('prismaClient es requerido');
  const normalizedAssignments = Array.isArray(assignments) ? assignments : [];
  const phones = [...new Set(normalizedAssignments
    .map((assignment) => normalizePhone(assignment?.worker?.phone))
    .filter(Boolean))];

  const [windows, confirmations] = phones.length
    ? await Promise.all([
        prismaClient.dispatchWhatsappContactWindow.findMany({
          where: { scope: 'operational', phone: { in: phones } }
        }),
        prismaClient.dispatchWhatsappConfirmation.findMany({
          where: { phone: { in: phones }, confirmationReceivedAt: { not: null } },
          select: { phone: true, confirmationReceivedAt: true },
          orderBy: { confirmationReceivedAt: 'desc' }
        })
      ])
    : [[], []];

  const windowsByPhone = new Map(windows.map((row) => [normalizePhone(row.phone), row]));
  const confirmationEvidenceByPhone = latestConfirmationEvidenceByPhone(confirmations);
  const snapshotsByPhone = new Map();

  for (const phone of phones) {
    const windowRow = windowsByPhone.get(phone);
    const contactInbound = validDate(windowRow?.lastInboundAt);
    const confirmationInbound = confirmationEvidenceByPhone.get(phone) || null;
    const effectiveInbound = latestDate(contactInbound, confirmationInbound);
    const source = effectiveInbound
      ? (confirmationInbound && (!contactInbound || confirmationInbound.getTime() > contactInbound.getTime())
          ? 'CONFIRMATION_EVIDENCE'
          : 'CONTACT_WINDOW')
      : null;

    if (source === 'CONFIRMATION_EVIDENCE') {
      await healContactWindowFromEvidence({
        prismaClient,
        phone,
        currentLastInboundAt: contactInbound,
        evidenceLastInboundAt: confirmationInbound
      });
    }
    snapshotsByPhone.set(phone, windowSnapshot(effectiveInbound, now, source));
  }

  return Object.fromEntries(normalizedAssignments
    .filter((assignment) => assignment?.id)
    .map((assignment) => {
      const phone = normalizePhone(assignment?.worker?.phone);
      return [assignment.id, {
        assignmentId: assignment.id,
        phone,
        ...windowSnapshot(null, now),
        ...(snapshotsByPhone.get(phone) || {})
      }];
    }));
}

export async function loadDispatchWhatsappTomorrowAssignmentMonitor({ prismaClient, now = new Date() } = {}) {
  if (!prismaClient) throw new Error('prismaClient es requerido');
  const dateKey = tomorrowIsoDateCO(now);
  const assignmentsRaw = await prismaClient.dispatchAssignment.findMany({
    where: {
      status: { in: ACTIVE_ASSIGNMENT_STATUSES },
      serviceRequest: {
        source: { not: 'DEV_TEST' },
        ...buildDispatchServiceDateWhere(dateKey)
      }
    },
    include: { worker: true, serviceRequest: true },
    orderBy: { createdAt: 'asc' }
  });
  const assignments = assignmentsRaw.filter((assignment) => (
    assignment?.serviceRequest?.source !== 'DEV_TEST'
    && dispatchServiceDateKey(assignment?.serviceRequest?.serviceDate) === dateKey
  ));

  const windowsByAssignment = await loadDispatchWhatsappWindowStatusForAssignments({ prismaClient, assignments, now });
  const assignedPhones = new Set(assignments.map((assignment) => normalizePhone(assignment?.worker?.phone)).filter(Boolean));
  const assignmentIds = assignments.map((assignment) => assignment.id);
  const [recentInboundRows, confirmationLinks, persistedByPhone] = await Promise.all([
    prismaClient.dispatchWhatsappContactWindow.findMany({
      where: {
        scope: 'operational',
        lastInboundAt: { gte: new Date(now.getTime() - UNMATCHED_INBOUND_LOOKBACK_MS) }
      },
      orderBy: { lastInboundAt: 'desc' },
      take: 200
    }),
    assignmentIds.length
      ? prismaClient.dispatchWhatsappConfirmation.findMany({
          where: { assignmentId: { in: assignmentIds } },
          select: {
            id: true,
            assignmentId: true,
            phone: true,
            providerMessageId: true,
            confirmationMessageId: true,
            confirmationReceivedAt: true,
            status: true,
            createdAt: true,
            updatedAt: true
          },
          orderBy: { createdAt: 'asc' }
        })
      : [],
    loadPersistedMessagesByPhone(prismaClient, [...assignedPhones])
  ]);
  const linksByAssignment = new Map();
  for (const link of confirmationLinks) {
    const bucket = linksByAssignment.get(link.assignmentId) || [];
    bucket.push(link);
    linksByAssignment.set(link.assignmentId, bucket);
  }
  const unmatchedInboundBase = recentInboundRows
    .map((row) => ({
      phone: normalizePhone(row?.phone),
      lastInboundAt: validDate(row?.lastInboundAt)?.toISOString() || null
    }))
    .filter((row) => row.phone && row.lastInboundAt && !assignedPhones.has(row.phone));
  const workerNamesByPhone = unmatchedInboundBase.length ? await loadWorkerNamesByPhone(prismaClient) : new Map();
  const unmatchedInbound = unmatchedInboundBase.map((row) => {
    const workerNames = workerNamesByPhone.get(row.phone) || [];
    return {
      ...row,
      workerName: workerNames.length ? workerNames.join(' / ') : null,
      workerNames
    };
  });

  const items = assignments.map((assignment) => {
    const worker = assignment.worker || {};
    const request = assignment.serviceRequest || {};
    const phone = normalizePhone(worker.phone);
    const window = windowsByAssignment[assignment.id] || windowSnapshot(null, now);
    const possibleMatch = !window.isOpen ? possibleInboundMatch(phone, unmatchedInbound) : null;
    const messageHistory = legacyMessagesForAssignment({
      assignment,
      links: linksByAssignment.get(assignment.id) || [],
      window,
      persistedMessages: persistedByPhone.get(phone) || []
    });
    return {
      assignmentId: assignment.id,
      serviceRequestId: assignment.serviceRequestId,
      workerId: assignment.workerId,
      workerName: text(worker.fullName) || 'Auxiliar',
      phone,
      phoneIssue: phoneIssue(worker.phone),
      possibleInboundPhone: possibleMatch?.phone || null,
      possibleInboundAt: possibleMatch?.lastInboundAt || null,
      assignmentStatus: assignment.status,
      confirmed: assignment.status === 'CONFIRMED',
      canSendWindowCheck: Boolean(phone && !window.isOpen),
      canAttemptManualMessage: Boolean(phone),
      canSendManualMessage: Boolean(phone && window.isOpen),
      operationName: text(request.operationPointName || request.serviceName) || 'Operación',
      clientName: text(request.clientName) || null,
      address: text(request.address) || null,
      startTime: text(request.startTime) || null,
      serviceDate: dateKey,
      messageHistory,
      messageCount: messageHistory.length,
      ...window
    };
  }).sort((a, b) => {
    if (a.isOpen !== b.isOpen) return a.isOpen ? 1 : -1;
    if (Boolean(a.phoneIssue || a.possibleInboundAt) !== Boolean(b.phoneIssue || b.possibleInboundAt)) {
      return a.phoneIssue || a.possibleInboundAt ? -1 : 1;
    }
    return a.workerName.localeCompare(b.workerName, 'es');
  });

  return {
    dateKey,
    generatedAt: now.toISOString(),
    items,
    unmatchedInbound,
    summary: {
      total: items.length,
      open: items.filter((item) => item.isOpen).length,
      closed: items.filter((item) => !item.isOpen).length,
      missingWindow: items.filter((item) => item.canSendWindowCheck).length,
      withoutPhone: items.filter((item) => !item.phone).length,
      phoneReview: items.filter((item) => item.phoneIssue || item.possibleInboundAt).length,
      unmatchedInbound: unmatchedInbound.length
    },
    scope: 'operational',
    note: 'Estado vivo: se recalcula en cada consulta con el último inbound operativo y, como respaldo, con confirmaciones persistidas. El historial de conversación del monitor de Despacho usa auditoría propia y nunca lee la tabla Message del bot de Reclutamiento.'
  };
}

function normalizeOutboundHistoryDate(value, now = new Date()) {
  const fallback = todayIsoDateCO(now);
  const candidate = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return fallback;
  const [year, month, day] = candidate.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) return fallback;
  return candidate;
}

function maskDispatchPhone(value) {
  const phone = normalizePhone(value);
  if (!phone) return 'Sin número';
  if (phone.length <= 4) return phone;
  return `•••• ${phone.slice(-4)}`;
}

export async function loadDispatchWhatsappOutboundHistoryByDate({
  prismaClient,
  dateKey,
  now = new Date(),
  limit = 500
} = {}) {
  if (!prismaClient) throw new Error('prismaClient es requerido');
  const normalizedDate = normalizeOutboundHistoryDate(dateKey, now);
  const nextDate = addIsoDays(normalizedDate, 1);
  const range = {
    gte: new Date(`${normalizedDate}T05:00:00.000Z`),
    lt: new Date(`${nextDate}T05:00:00.000Z`)
  };
  const take = Math.min(500, Math.max(1, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 500));
  const [rows, confirmationRows] = await Promise.all([
    prismaClient?.devAuditEvent?.findMany
      ? prismaClient.devAuditEvent.findMany({
          where: {
            entityType: DISPATCH_WHATSAPP_MESSAGE_ENTITY,
            action: 'DISPATCH_WHATSAPP_OUTBOUND',
            createdAt: range
          },
          orderBy: { createdAt: 'desc' },
          take
        })
      : [],
    prismaClient?.dispatchWhatsappConfirmation?.findMany
      ? prismaClient.dispatchWhatsappConfirmation.findMany({
          where: { createdAt: range, providerMessageId: { not: null } },
          include: {
            assignment: {
              include: {
                worker: true,
                serviceRequest: { include: { operationPoint: true } }
              }
            }
          },
          orderBy: { createdAt: 'desc' },
          take
        })
      : []
  ]);
  const workerNamesByPhone = rows.length ? await loadWorkerNamesByPhone(prismaClient) : new Map();
  const auditedProviderIds = new Set(rows.map((row) => text(row?.metadata?.providerMessageId)).filter(Boolean));
  const auditedItems = rows.map((row) => {
    const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    const phone = normalizePhone(metadata.phone || row.entityLabel);
    const workerNames = workerNamesByPhone.get(phone) || [];
    return {
      id: row.entityId || row.id,
      phoneMasked: maskDispatchPhone(phone),
      workerName: workerNames.length ? workerNames.join(' / ') : null,
      workerNames,
      body: text(metadata.body) || '(mensaje sin texto)',
      messageType: text(metadata.messageType) || 'UNKNOWN',
      source: text(metadata.source) || text(row.actorSource) || 'AUDIT',
      at: isoDate(metadata.occurredAt || row.createdAt),
      providerMessageId: text(metadata.providerMessageId) || null,
      providerStatus: text(metadata.providerStatus).toUpperCase() || null,
      providerStatusAt: isoDate(metadata.providerStatusAt),
      providerDiagnostic: text(metadata.providerDiagnostic) || null,
      reconstructed: false
    };
  });
  const reconstructedItems = (confirmationRows || [])
    .filter((row) => (
      text(row?.providerMessageId)
      && !auditedProviderIds.has(text(row.providerMessageId))
      && row?.assignment
      && row.assignment?.serviceRequest?.source !== 'DEV_TEST'
    ))
    .map((row) => {
      const assignment = row.assignment;
      const phone = normalizePhone(row.phone || assignment?.worker?.phone);
      const workerName = text(assignment?.worker?.fullName) || null;
      return {
        id: `legacy-out:${row.id}`,
        phoneMasked: maskDispatchPhone(phone),
        workerName,
        workerNames: workerName ? [workerName] : [],
        body: `${buildDispatchAssignmentMessageBody(assignment)}\n\n[Botones: CONFIRMADO · REPORTAR NOVEDAD]`,
        messageType: 'UNKNOWN',
        source: 'RECONSTRUIDO_ASIGNACION',
        at: isoDate(row.createdAt),
        providerMessageId: text(row.providerMessageId) || null,
        providerStatus: null,
        providerStatusAt: null,
        providerDiagnostic: null,
        reconstructed: true
      };
    });
  const items = [...auditedItems, ...reconstructedItems]
    .filter((item) => item.at)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, take);
  const statusCount = (status) => items.filter((item) => item.providerStatus === status).length;
  return {
    dateKey: normalizedDate,
    generatedAt: now.toISOString(),
    range: { start: range.gte.toISOString(), end: range.lt.toISOString() },
    items,
    summary: {
      total: items.length,
      accepted: statusCount('ACCEPTED'),
      sent: statusCount('SENT'),
      delivered: statusCount('DELIVERED'),
      read: statusCount('READ'),
      failed: statusCount('FAILED'),
      historical: items.filter((item) => item.reconstructed).length,
      withoutProviderStatus: items.filter((item) => !item.providerStatus).length
    },
    scope: 'operational'
  };
}
