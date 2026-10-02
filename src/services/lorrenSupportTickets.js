import { randomUUID } from 'node:crypto';
import { loadLorrenBillingConfig } from './lorrenBillingConfig.js';
import { normalizeDispatchWhatsappPhone } from './dispatchWhatsappCloudConfig.js';
import { interpretLorrenSupportTicket } from './lorrenSupportTicketInterpreter.js';
import { persistLorrenBotUsage } from './lorrenAiUsageCounter.js';

const CONFIG_ENTITY_TYPE = 'LORREN_SUPPORT_CONFIG';
const CONFIG_ENTITY_ID = 'singleton';
const CONFIG_ACTION = 'LORREN_SUPPORT_CONFIG_SAVED';
const TICKET_ENTITY_TYPE = 'LORREN_SUPPORT_TICKET';
const TICKET_CREATED = 'LORREN_SUPPORT_TICKET_CREATED';
const TICKET_UPDATED = 'LORREN_SUPPORT_TICKET_UPDATED';
const TICKET_DELETED = 'LORREN_SUPPORT_TICKET_DELETED';
const TICKET_ACTIONS = Object.freeze([TICKET_CREATED, TICKET_UPDATED, TICKET_DELETED]);
const INBOUND_ENTITY_TYPE = 'LORREN_SUPPORT_WHATSAPP_INBOUND';
const INBOUND_ACTION = 'LORREN_SUPPORT_WHATSAPP_ACCEPTED';

export const LORREN_SUPPORT_STATUSES = Object.freeze([
  'RECIBIDO',
  'EN_REVISION',
  'APROBADO',
  'EN_PROCESO',
  'EN_VALIDACION',
  'REALIZADO',
  'RECHAZADO',
  'CANCELADO'
]);

export const LORREN_SUPPORT_PRIORITIES = Object.freeze(['BAJA', 'NORMAL', 'ALTA', 'URGENTE']);

function text(value, max = 4000) {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return clean ? clean.slice(0, max) : null;
}

function normalizePhone(value) {
  return normalizeDispatchWhatsappPhone(value) || null;
}

function normalizePhoneRows(value = []) {
  const rows = Array.isArray(value) ? value : [];
  const byPhone = new Map();
  for (const item of rows) {
    const phone = normalizePhone(item?.phone);
    if (!phone) continue;
    byPhone.set(phone, {
      name: text(item?.name, 160) || phone,
      phone,
      active: item?.active !== false
    });
  }
  return [...byPhone.values()];
}

function defaultConfig() {
  return { authorizedPhones: [], configured: false };
}

export async function loadLorrenSupportConfig(prisma) {
  if (!prisma?.devAuditEvent?.findFirst) return defaultConfig();
  const row = await prisma.devAuditEvent.findFirst({
    where: { entityType: CONFIG_ENTITY_TYPE, entityId: CONFIG_ENTITY_ID, action: CONFIG_ACTION },
    orderBy: { createdAt: 'desc' }
  });
  const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  return {
    authorizedPhones: normalizePhoneRows(metadata.authorizedPhones),
    configured: Boolean(row)
  };
}

export async function saveLorrenSupportConfig(prisma, input = {}) {
  const previous = await loadLorrenSupportConfig(prisma);
  const config = {
    authorizedPhones: normalizePhoneRows(input.authorizedPhones)
  };
  await prisma.devAuditEvent.create({
    data: {
      entityType: CONFIG_ENTITY_TYPE,
      entityId: CONFIG_ENTITY_ID,
      entityLabel: 'Configuración de tickets Lórren',
      action: CONFIG_ACTION,
      actorUserId: text(input.actorUserId, 160),
      actorUsername: text(input.actorUsername, 160),
      actorRole: text(input.actorRole, 80),
      actorSource: 'lorren-support-admin',
      ipAddress: text(input.ipAddress, 120),
      userAgent: text(input.userAgent, 500),
      fromValue: previous,
      toValue: config,
      metadata: config
    }
  });
  return { ...config, configured: true };
}

export async function loadLorrenSupportAuthorizedPhones(prisma) {
  const [config, billing] = await Promise.all([
    loadLorrenSupportConfig(prisma),
    loadLorrenBillingConfig(prisma)
  ]);
  const byPhone = new Map();
  const supervisorPhone = normalizePhone(billing?.supervisor?.phone);
  if (supervisorPhone) {
    byPhone.set(supervisorPhone, {
      name: text(billing?.supervisor?.name, 160) || 'Supervisor',
      phone: supervisorPhone,
      source: 'BILLING_SUPERVISOR'
    });
  }
  for (const item of config.authorizedPhones) {
    if (!item.active) continue;
    byPhone.set(item.phone, { ...item, source: 'DEV_CONFIG' });
  }
  return [...byPhone.values()];
}

function buildPublicCode(sourceId = null) {
  const compact = String(sourceId || randomUUID()).replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const suffix = compact.slice(-8).padStart(8, '0');
  return `TCK-${suffix}`;
}

function snapshotFromEvent(row) {
  const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : null;
  if (!metadata) return null;
  return { ...metadata, auditEventId: row.id, auditCreatedAt: row.createdAt };
}

export async function loadLorrenSupportTickets(prisma, { take = 500 } = {}) {
  if (!prisma?.devAuditEvent?.findMany) return [];
  const rows = await prisma.devAuditEvent.findMany({
    where: { entityType: TICKET_ENTITY_TYPE, action: { in: TICKET_ACTIONS } },
    orderBy: { createdAt: 'desc' },
    take: Math.max(50, Math.min(Number(take) || 500, 2000))
  });
  const latest = new Map();
  const seen = new Set();
  for (const row of rows) {
    if (!row.entityId || seen.has(row.entityId)) continue;
    seen.add(row.entityId);
    if (row.action === TICKET_DELETED) continue;
    const snapshot = snapshotFromEvent(row);
    if (snapshot) latest.set(row.entityId, snapshot);
  }
  return [...latest.values()].sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
}

export async function loadLorrenSupportTicket(prisma, ticketId) {
  if (!ticketId || !prisma?.devAuditEvent?.findFirst) return null;
  const row = await prisma.devAuditEvent.findFirst({
    where: { entityType: TICKET_ENTITY_TYPE, entityId: ticketId, action: { in: TICKET_ACTIONS } },
    orderBy: { createdAt: 'desc' }
  });
  if (!row || row.action === TICKET_DELETED) return null;
  return snapshotFromEvent(row);
}

async function persistTicket(prisma, snapshot, { action, previous = null, actor = {} } = {}) {
  const row = await prisma.devAuditEvent.create({
    data: {
      entityType: TICKET_ENTITY_TYPE,
      entityId: snapshot.id,
      entityLabel: snapshot.publicCode,
      action,
      actorUserId: text(actor.actorUserId, 160),
      actorUsername: text(actor.actorUsername, 160),
      actorRole: text(actor.actorRole, 80),
      actorSource: text(actor.actorSource, 120) || snapshot.source || 'lorren-support',
      ipAddress: text(actor.ipAddress, 120),
      userAgent: text(actor.userAgent, 500),
      fromValue: previous || undefined,
      toValue: snapshot,
      metadata: snapshot
    }
  });
  return { ...snapshot, auditEventId: row.id, auditCreatedAt: row.createdAt };
}

export async function createLorrenSupportTicket(prisma, input = {}) {
  const originalText = text(input.originalText, 6000);
  if (!originalText) throw new Error('lorren_support_ticket_text_required');
  const id = input.id || randomUUID();
  const now = new Date().toISOString();
  const interpretation = input.interpretation || await interpretLorrenSupportTicket(originalText, {
    onUsage: async (event) => persistLorrenBotUsage(prisma, event)
  });
  const suggestedPriority = LORREN_SUPPORT_PRIORITIES.includes(interpretation?.suggestedPriority)
    ? interpretation.suggestedPriority
    : 'NORMAL';
  const snapshot = {
    id,
    publicCode: input.publicCode || buildPublicCode(input.sourceMessageId || id),
    source: text(input.source, 80) || 'DEV_PANEL',
    sourceMessageId: text(input.sourceMessageId, 240),
    createdByPhone: normalizePhone(input.createdByPhone),
    createdByName: text(input.createdByName, 160),
    createdByUserId: text(input.createdByUserId, 160),
    createdByUsername: text(input.createdByUsername, 160),
    originalText,
    interpretation,
    status: 'RECIBIDO',
    priority: suggestedPriority,
    createdAt: now,
    updatedAt: now,
    developmentRequestedAt: null,
    developmentRequestedBy: null
  };
  return persistTicket(prisma, snapshot, {
    action: TICKET_CREATED,
    actor: input.actor || {
      actorUserId: input.createdByUserId,
      actorUsername: input.createdByUsername,
      actorRole: input.actorRole,
      actorSource: snapshot.source,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent
    }
  });
}

export async function updateLorrenSupportTicket(prisma, ticketId, changes = {}, actor = {}) {
  const previous = await loadLorrenSupportTicket(prisma, ticketId);
  if (!previous) throw new Error('lorren_support_ticket_not_found');
  const status = text(changes.status, 40) || previous.status;
  const priority = text(changes.priority, 40) || previous.priority;
  if (!LORREN_SUPPORT_STATUSES.includes(status)) throw new Error('lorren_support_ticket_status_invalid');
  if (!LORREN_SUPPORT_PRIORITIES.includes(priority)) throw new Error('lorren_support_ticket_priority_invalid');
  const now = new Date().toISOString();
  const interpretation = {
    ...(previous.interpretation || {}),
    ...(changes.interpretation && typeof changes.interpretation === 'object' ? changes.interpretation : {})
  };
  const snapshot = {
    ...previous,
    interpretation,
    status,
    priority,
    updatedAt: now
  };
  delete snapshot.auditEventId;
  delete snapshot.auditCreatedAt;
  if (changes.requestDevelopment === true) {
    snapshot.status = 'APROBADO';
    snapshot.developmentRequestedAt = now;
    snapshot.developmentRequestedBy = text(actor.actorUsername, 160) || text(actor.actorUserId, 160) || 'DEV';
  }
  return persistTicket(prisma, snapshot, { action: TICKET_UPDATED, previous, actor });
}

export async function deleteLorrenSupportTicket(prisma, ticketId, actor = {}) {
  const previous = await loadLorrenSupportTicket(prisma, ticketId);
  if (!previous) throw new Error('lorren_support_ticket_not_found');
  const deletedAt = new Date().toISOString();
  const tombstone = {
    id: previous.id,
    publicCode: previous.publicCode,
    deleted: true,
    deletedAt
  };
  const row = await prisma.devAuditEvent.create({
    data: {
      entityType: TICKET_ENTITY_TYPE,
      entityId: previous.id,
      entityLabel: previous.publicCode,
      action: TICKET_DELETED,
      actorUserId: text(actor.actorUserId, 160),
      actorUsername: text(actor.actorUsername, 160),
      actorRole: text(actor.actorRole, 80),
      actorSource: text(actor.actorSource, 120) || 'lorren-support-admin',
      ipAddress: text(actor.ipAddress, 120),
      userAgent: text(actor.userAgent, 500),
      fromValue: previous,
      toValue: tombstone,
      metadata: tombstone
    }
  });
  return { ...tombstone, auditEventId: row.id, auditCreatedAt: row.createdAt };
}

export async function createLorrenSupportTicketFromWhatsapp(prisma, input = {}) {
  const messageId = text(input.messageId, 240);
  const phone = normalizePhone(input.phone);
  const originalText = text(input.text, 6000);
  if (!messageId || !phone || !originalText) return { accepted: false, reason: 'invalid_message' };

  const authorized = await loadLorrenSupportAuthorizedPhones(prisma);
  const owner = authorized.find((item) => item.phone === phone);
  if (!owner) return { accepted: false, reason: 'unauthorized_phone' };

  const duplicate = await prisma.devAuditEvent.findFirst({
    where: { entityType: INBOUND_ENTITY_TYPE, entityId: messageId, action: INBOUND_ACTION },
    orderBy: { createdAt: 'desc' }
  });
  if (duplicate) return { accepted: true, duplicate: true, ticketId: duplicate.metadata?.ticketId || null };

  const ticket = await createLorrenSupportTicket(prisma, {
    source: 'WHATSAPP',
    sourceMessageId: messageId,
    createdByPhone: phone,
    createdByName: owner.name,
    originalText,
    actorRole: 'WHATSAPP_AUTHORIZED',
    actor: { actorSource: 'lorren-whatsapp-support', actorUsername: owner.name, actorRole: 'WHATSAPP_AUTHORIZED' }
  });

  await prisma.devAuditEvent.create({
    data: {
      entityType: INBOUND_ENTITY_TYPE,
      entityId: messageId,
      entityLabel: ticket.publicCode,
      action: INBOUND_ACTION,
      actorUsername: owner.name,
      actorRole: 'WHATSAPP_AUTHORIZED',
      actorSource: 'lorren-whatsapp-support',
      metadata: { ticketId: ticket.id, publicCode: ticket.publicCode, phone }
    }
  });
  return { accepted: true, duplicate: false, ticketId: ticket.id, publicCode: ticket.publicCode };
}

export async function loadLorrenSupportTicketTimeline(prisma, ticketId, { take = 100 } = {}) {
  if (!ticketId || !prisma?.devAuditEvent?.findMany) return [];
  return prisma.devAuditEvent.findMany({
    where: { entityType: TICKET_ENTITY_TYPE, entityId: ticketId },
    orderBy: { createdAt: 'asc' },
    take: Math.max(1, Math.min(Number(take) || 100, 500))
  });
}
