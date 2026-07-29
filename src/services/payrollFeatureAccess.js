export const PAYROLL_ACCESS_ENTITY_TYPE = 'APP_USER_PAYROLL_ACCESS';
export const PAYROLL_ACCESS_ACTION = Object.freeze({
  ENABLED: 'PAYROLL_ACCESS_ENABLED',
  DISABLED: 'PAYROLL_ACCESS_DISABLED'
});

function normalizeString(value, maxLength = 200) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

function requirePrisma(prisma) {
  if (!prisma?.appUser?.findUnique || !prisma?.devAuditEvent?.findFirst || !prisma?.devAuditEvent?.create) {
    throw new Error('payroll_access_prisma_contract_invalid');
  }
  return prisma;
}

async function latestAccessEvent(prisma, userId) {
  return prisma.devAuditEvent.findFirst({
    where: {
      entityType: PAYROLL_ACCESS_ENTITY_TYPE,
      entityId: userId,
      action: { in: [PAYROLL_ACCESS_ACTION.ENABLED, PAYROLL_ACCESS_ACTION.DISABLED] }
    },
    orderBy: { createdAt: 'desc' }
  });
}

export async function resolvePayrollFeatureAccess(prisma, source = {}) {
  const role = normalizeString(source.userRole || source.role)?.toLowerCase();
  if (role === 'dev') return { allowed: true, reason: 'dev', userId: source.userId || null };
  if (role !== 'admin') return { allowed: false, reason: 'role_not_allowed', userId: null };

  requirePrisma(prisma);
  const userId = normalizeString(source.userId, 120);
  const username = normalizeString(source.username, 160);
  if (!userId && !username) return { allowed: false, reason: 'user_not_identified', userId: null };

  const user = await prisma.appUser.findUnique({
    where: userId ? { id: userId } : { username },
    select: { id: true, role: true, isActive: true }
  });
  if (!user || !user.isActive || String(user.role || '').toUpperCase() !== 'ADMIN') {
    return { allowed: false, reason: 'user_not_active', userId: user?.id || null };
  }

  const event = await latestAccessEvent(prisma, user.id);
  const allowed = event?.action === PAYROLL_ACCESS_ACTION.ENABLED;
  return {
    allowed,
    reason: allowed ? 'user_permission_enabled' : 'user_permission_disabled',
    userId: user.id,
    changedAt: event?.createdAt || null
  };
}

export async function setPayrollFeatureAccess(prisma, input = {}, options = {}) {
  requirePrisma(prisma);
  const actorRole = normalizeString(input.actorRole, 80)?.toLowerCase();
  if (actorRole !== 'dev') throw new Error('payroll_access_dev_required');

  const targetUserId = normalizeString(input.targetUserId, 120);
  if (!targetUserId) throw new Error('payroll_access_target_required');
  const enabled = input.enabled === true;
  const now = options.now || new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('payroll_access_now_invalid');

  const user = await prisma.appUser.findUnique({
    where: { id: targetUserId },
    select: {
      id: true,
      username: true,
      role: true,
      isActive: true
    }
  });
  if (!user || String(user.role || '').toUpperCase() !== 'ADMIN') throw new Error('payroll_access_user_not_found');

  const previous = await latestAccessEvent(prisma, user.id);
  const previousEnabled = previous?.action === PAYROLL_ACCESS_ACTION.ENABLED;
  await prisma.devAuditEvent.create({
    data: {
      entityType: PAYROLL_ACCESS_ENTITY_TYPE,
      entityId: user.id,
      entityLabel: user.username,
      action: enabled ? PAYROLL_ACCESS_ACTION.ENABLED : PAYROLL_ACCESS_ACTION.DISABLED,
      actorUsername: normalizeString(input.actorUsername, 160),
      actorRole,
      actorSource: 'users-admin',
      ipAddress: normalizeString(input.ipAddress, 120),
      userAgent: normalizeString(input.userAgent, 500),
      fromValue: { enabled: previousEnabled },
      toValue: { enabled },
      metadata: {
        permission: 'PAYROLL',
        independentPermission: true,
        parentPermissionsChanged: false
      },
      createdAt: now
    }
  });

  return {
    userId: user.id,
    username: user.username,
    enabled,
    independentPermission: true,
    parentPermissionsChanged: false
  };
}

export async function listPayrollFeatureAccess(prisma, userIds = []) {
  if (!Array.isArray(userIds) || !userIds.length) return new Map();
  if (!prisma?.devAuditEvent?.findMany) throw new Error('payroll_access_event_reader_required');

  const events = await prisma.devAuditEvent.findMany({
    where: {
      entityType: PAYROLL_ACCESS_ENTITY_TYPE,
      entityId: { in: [...new Set(userIds.filter(Boolean))] },
      action: { in: [PAYROLL_ACCESS_ACTION.ENABLED, PAYROLL_ACCESS_ACTION.DISABLED] }
    },
    orderBy: { createdAt: 'desc' }
  });

  const access = new Map();
  for (const event of events) {
    if (!event.entityId || access.has(event.entityId)) continue;
    access.set(event.entityId, event.action === PAYROLL_ACCESS_ACTION.ENABLED);
  }
  return access;
}
