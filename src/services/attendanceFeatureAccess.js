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

export async function resolveAttendanceFeatureAccess(prisma, source = {}) {
  const role = normalizeString(source.userRole || source.role)?.toLowerCase();
  const username = normalizeString(source.username);

  if (role === 'dev') {
    return { allowed: true, reason: 'dev' };
  }

  if (role !== 'admin') {
    return { allowed: false, reason: 'role_not_allowed' };
  }

  if (!username) {
    return { allowed: false, reason: 'user_not_identified' };
  }

  requirePrismaModel(prisma, 'appUser', 'findUnique');
  const user = await prisma.appUser.findUnique({
    where: { username },
    select: {
      id: true,
      role: true,
      isActive: true,
      canAccessAttendance: true
    }
  });

  if (!user) {
    return { allowed: false, reason: 'user_not_found' };
  }
  if (!user.isActive || String(user.role || '').toUpperCase() !== 'ADMIN') {
    return { allowed: false, reason: 'user_not_active' };
  }

  const allowed = user.canAccessAttendance === true;
  return {
    allowed,
    reason: allowed ? 'user_permission_enabled' : 'user_permission_disabled'
  };
}
