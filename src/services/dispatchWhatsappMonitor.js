import { buildDispatchServiceDateWhere, dispatchServiceDateKey, todayIsoDateCO } from './dispatchDate.js';
import { DISPATCH_WHATSAPP_WINDOW_MS } from './dispatchWhatsappAdminAlerts.js';
import { buildDispatchAssignmentMessageBody } from './dispatchWhatsappCloudClient.js';

const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const UNMATCHED_INBOUND_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DISPATCH_WHATSAPP_MESSAGE_ENTITY = 'DISPATCH_WHATSAPP_MESSAGE';
const MESSAGE_HISTORY_LIMIT = 20;
const MESSAGE_BODY_LIMIT = 4000;

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
  const externalId = text(messageId) || text(providerMessageId) || text(dedupeKey);
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
          providerMessageId: text(providerMessageId),
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

function auditMessageFromRow(row) {
  const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const direction = String(metadata.direction || (row.action?.endsWith('INBOUND') ? 'INBOUND' : 'OUTBOUND')).toUpperCase();
  return {
    id: row.entityId || row.id,
    direction,
    body: text(metadata.body) || '(mensaje sin texto)',
    messageType: text(metadata.messageType) || 'UNKNOWN',
    at: isoDate(metadata.occurredAt || row.createdAt),
    source: text(metadata.source) || 'AUDIT',
    messageId: text(metadata.messageId) || null,
    providerMessageId: text(metadata.providerMessageId) || null,
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

function legacyMessagesForAssignment({ assignment, links = [], window = {}, persistedMessages = [] }) {
  const messages = [...persistedMessages];
  for (const link of links) {
    if (link.providerMessageId && !messages.some((message) => sameEvidenceId(message, link.providerMessageId))) {
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

  if (window.lastInboundAt && !hasInboundNear(messages, window.lastInboundAt)) {
    messages.push({
      id: `legacy-window:${assignment.id}:${window.lastInboundAt}`,
      direction: 'INBOUND',
      body: 'Mensaje recibido. El contenido exacto no se almacenaba todavía en el monitor de Despacho.',
      messageType: 'UNKNOWN',
      at: window.lastInboundAt,
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
  const unmatchedInbound = recentInboundRows
    .map((row) => ({
      phone: normalizePhone(row?.phone),
      lastInboundAt: validDate(row?.lastInboundAt)?.toISOString() || null
    }))
    .filter((row) => row.phone && row.lastInboundAt && !assignedPhones.has(row.phone));

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
