export const ATTENDANCE_RECRUITER_GENERAL_FLAG_KEY = 'feature.attendance.recruiter_general.enabled';
export const RECRUITER_GENERAL_USERNAME = 'reclutador-general';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length ? normalized : null;
}

function parseStoredBoolean(value) {
  return normalizeString(value)?.toLowerCase() === 'true';
}

function requirePrismaModel(prisma, modelName, methodName) {
  if (!prisma?.[modelName] || typeof prisma[modelName][methodName] !== 'function') {
    throw new Error(`attendance_access_${modelName}_${methodName}_required`);
  }
}

export async function getRecruiterGeneralAttendanceEnabled(prisma) {
  requirePrismaModel(prisma, 'botKnowledge', 'findUnique');
  const flag = await prisma.botKnowledge.findUnique({
    where: { key: ATTENDANCE_RECRUITER_GENERAL_FLAG_KEY },
    select: { value: true }
  });
  return parseStoredBoolean(flag?.value);
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
    requirePrismaModel(tx, 'botKnowledge', 'upsert');

    const recruiterGeneral = await tx.appUser.findUnique({
      where: { username: RECRUITER_GENERAL_USERNAME },
      select: { id: true, username: true, role: true, isActive: true }
    });

    if (!recruiterGeneral || String(recruiterGeneral.role || '').toUpperCase() !== 'ADMIN') {
      throw new Error('attendance_access_recruiter_general_not_found');
    }

    const previous = await tx.botKnowledge.findUnique({
      where: { key: ATTENDANCE_RECRUITER_GENERAL_FLAG_KEY },
      select: { value: true }
    });
    const previousEnabled = parseStoredBoolean(previous?.value);

    await tx.botKnowledge.upsert({
      where: { key: ATTENDANCE_RECRUITER_GENERAL_FLAG_KEY },
      create: {
        key: ATTENDANCE_RECRUITER_GENERAL_FLAG_KEY,
        value: String(input.enabled)
      },
      update: { value: String(input.enabled) }
    });

    if (typeof tx.devAuditEvent?.create === 'function') {
      await tx.devAuditEvent.create({
        data: {
          entityType: 'FEATURE_ACCESS',
          entityId: recruiterGeneral.id,
          entityLabel: 'Asistencia operativa para reclutador-general',
          action: input.enabled
            ? 'ATTENDANCE_RECRUITER_GENERAL_ENABLED'
            : 'ATTENDANCE_RECRUITER_GENERAL_DISABLED',
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
            targetActive: recruiterGeneral.isActive
          }
        }
      });
    }

    return {
      enabled: input.enabled,
      previousEnabled,
      recruiterGeneral
    };
  });
}
