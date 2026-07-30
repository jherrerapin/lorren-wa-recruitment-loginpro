export const TEST_WORKSPACE_ACCESS_ENTITY_TYPE = 'APP_USER_TEST_WORKSPACE_ACCESS';
export const TEST_WORKSPACE_ACCESS_ACTION = Object.freeze({
  ENABLED: 'TEST_WORKSPACE_ACCESS_ENABLED',
  DISABLED: 'TEST_WORKSPACE_ACCESS_DISABLED'
});

function normalizeString(value, maxLength = 200) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

function requirePrisma(prisma) {
  if (!prisma?.appUser?.findUnique || !prisma?.devAuditEvent?.findFirst || !prisma?.devAuditEvent?.create) {
    throw new Error('test_workspace_access_prisma_contract_invalid');
  }
  return prisma;
}

async function latestAccessEvent(prisma, userId) {
  return prisma.devAuditEvent.findFirst({
    where: {
      entityType: TEST_WORKSPACE_ACCESS_ENTITY_TYPE,
      entityId: userId,
      action: { in: [TEST_WORKSPACE_ACCESS_ACTION.ENABLED, TEST_WORKSPACE_ACCESS_ACTION.DISABLED] }
    },
    orderBy: { createdAt: 'desc' }
  });
}

export async function resolveTestWorkspaceFeatureAccess(prisma, source = {}) {
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
  const allowed = event?.action === TEST_WORKSPACE_ACCESS_ACTION.ENABLED;
  return {
    allowed,
    reason: allowed ? 'user_permission_enabled' : 'user_permission_disabled',
    userId: user.id,
    changedAt: event?.createdAt || null
  };
}

export async function setTestWorkspaceFeatureAccess(prisma, input = {}, options = {}) {
  requirePrisma(prisma);
  const actorRole = normalizeString(input.actorRole, 80)?.toLowerCase();
  if (actorRole !== 'dev') throw new Error('test_workspace_access_dev_required');

  const targetUserId = normalizeString(input.targetUserId, 120);
  if (!targetUserId) throw new Error('test_workspace_access_target_required');
  const enabled = input.enabled === true;
  const now = options.now || new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('test_workspace_access_now_invalid');

  const user = await prisma.appUser.findUnique({
    where: { id: targetUserId },
    select: { id: true, username: true, role: true, isActive: true }
  });
  if (!user || !user.isActive || String(user.role || '').toUpperCase() !== 'ADMIN') {
    throw new Error('test_workspace_access_user_not_found');
  }

  const previous = await latestAccessEvent(prisma, user.id);
  const previousEnabled = previous?.action === TEST_WORKSPACE_ACCESS_ACTION.ENABLED;
  await prisma.devAuditEvent.create({
    data: {
      entityType: TEST_WORKSPACE_ACCESS_ENTITY_TYPE,
      entityId: user.id,
      entityLabel: user.username,
      action: enabled ? TEST_WORKSPACE_ACCESS_ACTION.ENABLED : TEST_WORKSPACE_ACCESS_ACTION.DISABLED,
      actorUsername: normalizeString(input.actorUsername, 160),
      actorRole,
      actorSource: 'users-admin',
      ipAddress: normalizeString(input.ipAddress, 120),
      userAgent: normalizeString(input.userAgent, 500),
      fromValue: { enabled: previousEnabled },
      toValue: { enabled },
      metadata: {
        permission: 'TEST_WORKSPACE',
        independentPermission: true,
        allowsRealEntityReferences: true,
        operationalRecordsChanged: false
      },
      createdAt: now
    }
  });

  return {
    userId: user.id,
    username: user.username,
    enabled,
    independentPermission: true
  };
}
