const ACCESS_ENTITY_TYPE = 'LORREN_SUPPORT_USER_ACCESS';
const ACCESS_ACTION = 'LORREN_SUPPORT_USER_ACCESS_SET';

function text(value, max = 500) {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return clean ? clean.slice(0, max) : null;
}

function actorData(actor = {}) {
  return {
    actorUserId: text(actor.actorUserId, 160),
    actorUsername: text(actor.actorUsername, 160),
    actorRole: text(actor.actorRole, 80),
    actorSource: text(actor.actorSource, 120) || 'lorren-support-access',
    ipAddress: text(actor.ipAddress, 120),
    userAgent: text(actor.userAgent, 500)
  };
}

export async function loadLorrenSupportTicketUserAccess(prisma, userId) {
  const id = text(userId, 160);
  if (!id || !prisma?.devAuditEvent?.findFirst) return false;
  const row = await prisma.devAuditEvent.findFirst({
    where: {
      entityType: ACCESS_ENTITY_TYPE,
      entityId: id,
      action: ACCESS_ACTION
    },
    orderBy: { createdAt: 'desc' }
  });
  return row?.metadata?.enabled === true;
}

export async function loadLorrenSupportTicketAccessMap(prisma, userIds = []) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map((value) => text(value, 160)).filter(Boolean))];
  if (!ids.length || !prisma?.devAuditEvent?.findMany) return {};
  const rows = await prisma.devAuditEvent.findMany({
    where: {
      entityType: ACCESS_ENTITY_TYPE,
      entityId: { in: ids },
      action: ACCESS_ACTION
    },
    orderBy: { createdAt: 'desc' }
  });
  const resolved = {};
  for (const row of rows) {
    if (!row.entityId || Object.prototype.hasOwnProperty.call(resolved, row.entityId)) continue;
    resolved[row.entityId] = row?.metadata?.enabled === true;
  }
  for (const id of ids) {
    if (!Object.prototype.hasOwnProperty.call(resolved, id)) resolved[id] = false;
  }
  return resolved;
}

export async function setLorrenSupportTicketUserAccess(prisma, userId, enabled, actor = {}) {
  const id = text(userId, 160);
  if (!id) throw new Error('lorren_support_access_user_required');
  if (!prisma?.appUser?.findUnique || !prisma?.devAuditEvent?.create) {
    throw new Error('lorren_support_access_storage_unavailable');
  }
  const user = await prisma.appUser.findUnique({
    where: { id },
    select: { id: true, username: true, displayName: true, email: true, role: true, isActive: true }
  });
  if (!user || user.role === 'DEV') throw new Error('lorren_support_access_user_invalid');
  const previous = await loadLorrenSupportTicketUserAccess(prisma, id);
  const next = enabled === true;
  if (previous === next) return { userId: id, enabled: next, unchanged: true };

  await prisma.devAuditEvent.create({
    data: {
      entityType: ACCESS_ENTITY_TYPE,
      entityId: id,
      entityLabel: text(user.displayName, 160) || text(user.email, 254) || text(user.username, 160) || id,
      action: ACCESS_ACTION,
      ...actorData(actor),
      fromValue: { enabled: previous },
      toValue: { enabled: next },
      metadata: { enabled: next, userId: id }
    }
  });
  return { userId: id, enabled: next, unchanged: false };
}

export async function canUseLorrenSupportTickets(prisma, req = {}) {
  const role = String(req.session?.userRole || req.userRole || '').toLowerCase();
  if (role === 'dev') return true;
  const userId = req.session?.userId || req.userId || null;
  return loadLorrenSupportTicketUserAccess(prisma, userId);
}

export const LORREN_SUPPORT_ACCESS_AUDIT = Object.freeze({
  entityType: ACCESS_ENTITY_TYPE,
  action: ACCESS_ACTION
});
