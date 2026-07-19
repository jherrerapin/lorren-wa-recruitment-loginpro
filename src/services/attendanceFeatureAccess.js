export const RECRUITER_GENERAL_USERNAME = 'reclutador-general';
export const ATTENDANCE_ACCESS_ENTITY_TYPE = 'FEATURE_ACCESS';
export const ATTENDANCE_ACCESS_ENTITY_LABEL = 'Asistencia operativa para reclutador-general';
export const ATTENDANCE_ACCESS_ENABLED_ACTION = 'ATTENDANCE_RECRUITER_GENERAL_ENABLED';
export const ATTENDANCE_ACCESS_DISABLED_ACTION = 'ATTENDANCE_RECRUITER_GENERAL_DISABLED';

const ATTENDANCE_ACCESS_ACTIONS = Object.freeze([
  ATTENDANCE_ACCESS_ENABLED_ACTION,
  ATTENDANCE_ACCESS_DISABLED_ACTION
]);

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length ? normalized : null;
}

function requirePrismaModel(prisma, modelName, methodName) {
  if (!prisma?.[modelName] || typeof prisma[modelName][methodName] !== 'function') {
    throw new Error(`attendance_access_${modelName}_${methodName}_required`);
  }
}

function eventEnablesAttendance(event) {
  if (!event) return false;
  if (event.action === ATTENDANCE_ACCESS_ENABLED_ACTION) return true;
  if (event.action === ATTENDANCE_ACCESS_DISABLED_ACTION) return false;
  return event.toValue?.enabled === true;
}

async function findLatestAttendanceAccessEvent(prisma) {
  requirePrismaModel(prisma, 'devAuditEvent', 'findFirst');
  return prisma.devAuditEvent.findFirst({
    where: {
      entityType: ATTENDANCE_ACCESS_ENTITY_TYPE,
      entityLabel: ATTENDANCE_ACCESS_ENTITY_LABEL,
      action: { in: [...ATTENDANCE_ACCESS_ACTIONS] }
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      action: true,
      toValue: true,
      createdAt: true
    }
  });
}

export async function getRecruiterGeneralAttendanceEnabled(prisma) {
  return eventEnablesAttendance(await findLatestAttendanceAccessEvent(prisma));
}

export async function resolveAttendanceFeatureAccess(prisma, source = {}) {
  const role = normalizeString(source.userRole || source.role)?.toLowerCase();
  const username = normalizeString(source.username);

  if (role === 'dev') {
    return {
      allowed: true,
      recruiterGeneralEnabled: await getRecruiterGeneralAttendanceEnabled(prisma),
      reason: 'dev'
    };
  }

  if (role !== 'admin' || username !== RECRUITER_GENERAL_USERNAME) {
    return {
      allowed: false,
      recruiterGeneralEnabled: false,
      reason: 'role_not_allowed'
    };
  }

  requirePrismaModel(prisma, 'appUser', 'findUnique');
  const [user, recruiterGeneralEnabled] = await Promise.all([
    prisma.appUser.findUnique({
      where: { username: RECRUITER_GENERAL_USERNAME },
      select: { id: true, role: true, isActive: true }
    }),
    getRecruiterGeneralAttendanceEnabled(prisma)
  ]);

  const allowed = Boolean(
    recruiterGeneralEnabled
    && user?.isActive
    && String(user.role || '').toUpperCase() === 'ADMIN'
  );

  return {
    allowed,
    recruiterGeneralEnabled,
    reason: allowed ? 'recruiter_general_enabled' : 'recruiter_general_disabled'
  };
}

export async function setRecruiterGeneralAttendanceEnabled(prisma, input = {}) {
  if (typeof input.enabled !== 'boolean') {
    throw new Error('attendance_access_enabled_boolean_required');
  }
  if (typeof prisma?.$transaction !== 'function') {
    throw new Error('attendance_access_transaction_required');
  }

  const actorUsername = normalizeString(input.actorUsername) || 'dev';
  const actorRole = normalizeString(input.actorRole)?.toLowerCase() || 'dev';
  if (actorRole !== 'dev') throw new Error('attendance_access_dev_required');

  return prisma.$transaction(async (tx) => {
    requirePrismaModel(tx, 'appUser', 'findUnique');
    requirePrismaModel(tx, 'devAuditEvent', 'findFirst');
    requirePrismaModel(tx, 'devAuditEvent', 'create');

    const recruiterGeneral = await tx.appUser.findUnique({
      where: { username: RECRUITER_GENERAL_USERNAME },
      select: { id: true, username: true, role: true, isActive: true }
    });

    if (!recruiterGeneral || String(recruiterGeneral.role || '').toUpperCase() !== 'ADMIN') {
      throw new Error('attendance_access_recruiter_general_not_found');
    }

    const previousEnabled = eventEnablesAttendance(
      await findLatestAttendanceAccessEvent(tx)
    );

    await tx.devAuditEvent.create({
      data: {
        entityType: ATTENDANCE_ACCESS_ENTITY_TYPE,
        entityId: recruiterGeneral.id,
        entityLabel: ATTENDANCE_ACCESS_ENTITY_LABEL,
        action: input.enabled
          ? ATTENDANCE_ACCESS_ENABLED_ACTION
          : ATTENDANCE_ACCESS_DISABLED_ACTION,
        actorUsername,
        actorRole,
        actorSource: normalizeString(input.actorSource),
        ipAddress: normalizeString(input.ipAddress),
        forwardedFor: normalizeString(input.forwardedFor),
        userAgent: normalizeString(input.userAgent),
        method: normalizeString(input.method),
        path: normalizeString(input.path),
        fromValue: { enabled: previousEnabled },
        toValue: { enabled: input.enabled },
        metadata: {
          targetUsername: RECRUITER_GENERAL_USERNAME,
          targetActive: recruiterGeneral.isActive,
          temporaryFeatureGate: true
        }
      }
    });

    return {
      enabled: input.enabled,
      previousEnabled,
      recruiterGeneral
    };
  });
}
