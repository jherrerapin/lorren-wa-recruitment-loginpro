function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function safeJson(value) {
  if (!value || typeof value !== 'object') return value || null;
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => {
      if (typeof item === 'string' && item.length > 500) return `${item.slice(0, 500)}...`;
      return item;
    }));
  } catch (_error) {
    return { error: 'unserializable_payload' };
  }
}

function inferAction(req) {
  const path = req.path || '';
  if (path.includes('/whatsapp/enviar')) return 'DISPATCH_WHATSAPP_SEND';
  if (path.includes('/asignaciones/assign')) return 'DISPATCH_ASSIGNMENT_CREATE';
  if (path.includes('/asignaciones/confirmar')) return 'DISPATCH_ASSIGNMENT_CONFIRM';
  if (path.includes('/asignaciones/no-confirmado')) return 'DISPATCH_ASSIGNMENT_NO_CONFIRM';
  if (path.includes('/asignaciones/unassign')) return 'DISPATCH_ASSIGNMENT_REMOVE';
  if (path.includes('/solicitudes') && path.includes('/eliminar')) return 'DISPATCH_SERVICE_REQUEST_DELETE';
  if (path.includes('/solicitudes')) return 'DISPATCH_SERVICE_REQUEST_CHANGE';
  if (path.includes('/personal')) return 'DISPATCH_WORKER_CHANGE';
  if (path.includes('/clientes')) return 'DISPATCH_CLIENT_CHANGE';
  return 'DISPATCH_OPERATION_MUTATION';
}

function shouldAudit(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return false;
  const path = req.path || '';
  return path.startsWith('/admin/operaciones') || path.startsWith('/operaciones/admin-') || path.startsWith('/operaciones/cliente/');
}

function actorUsername(req) {
  const publicClient = (req.path || '').startsWith('/operaciones/cliente/');
  return normalizeString(req.session?.username || req.username) || (publicClient ? 'cliente-publico' : 'system');
}

function actorSource(req) {
  return (req.path || '').startsWith('/operaciones/cliente/') ? 'public-client' : 'dashboard';
}

function targetFor(req) {
  return normalizeString(req.body?.context?.assignmentId)
    || normalizeString(req.body?.assignmentId)
    || normalizeString(req.body?.context?.serviceRequestId)
    || normalizeString(req.body?.serviceRequestId)
    || normalizeString(req.body?.workerId)
    || req.path
    || 'dispatch';
}

async function refreshDatabaseUserPermissions(prisma, req) {
  if (req.session?.userSource !== 'db' || !req.session?.userId || !prisma?.appUser?.findUnique) return;

  const user = await prisma.appUser.findUnique({
    where: { id: req.session.userId },
    select: {
      isActive: true,
      accessScope: true,
      scopeCity: true,
      scopeVacancyId: true,
      canAccessDispatch: true,
      canAccessStatistics: true,
      canAccessMetaAds: true,
      canAccessCvAnalysis: true
    }
  });

  if (!user || !user.isActive) {
    req.session.userRole = null;
    req.session.userId = null;
    req.session.canAccessDispatch = false;
    req.session.canAccessStatistics = false;
    req.session.canAccessMetaAds = false;
    req.session.canAccessCvAnalysis = false;
    req.userRole = null;
    req.userId = null;
    req.canAccessDispatch = false;
    req.canAccessStatistics = false;
    req.canAccessMetaAds = false;
    req.canAccessCvAnalysis = false;
    return;
  }

  const accessScope = user.accessScope || 'ALL';
  const accessCity = user.scopeCity || null;
  const accessVacancyId = user.scopeVacancyId || null;
  const canAccessDispatch = Boolean(user.canAccessDispatch);
  const canAccessMetaAds = Boolean(user.canAccessMetaAds ?? user.canAccessStatistics);
  const canAccessCvAnalysis = Boolean(user.canAccessCvAnalysis ?? user.canAccessStatistics);
  const canAccessStatistics = canAccessMetaAds || canAccessCvAnalysis;

  req.session.userAccessScope = accessScope;
  req.session.userAccessCity = accessCity;
  req.session.userAccessVacancyId = accessVacancyId;
  req.session.canAccessDispatch = canAccessDispatch;
  req.session.canAccessStatistics = canAccessStatistics;
  req.session.canAccessMetaAds = canAccessMetaAds;
  req.session.canAccessCvAnalysis = canAccessCvAnalysis;

  req.userAccessScope = accessScope;
  req.userAccessCity = accessCity;
  req.userAccessVacancyId = accessVacancyId;
  req.canAccessDispatch = canAccessDispatch;
  req.canAccessStatistics = canAccessStatistics;
  req.canAccessMetaAds = canAccessMetaAds;
  req.canAccessCvAnalysis = canAccessCvAnalysis;
}

export function buildDispatchAuditEventData(req, res, startedAt = Date.now()) {
  return {
    entityType: 'DISPATCH',
    entityId: targetFor(req),
    entityLabel: normalizeString(req.path),
    action: inferAction(req),
    actorUsername: actorUsername(req),
    actorRole: normalizeString(req.session?.userRole || req.userRole),
    actorSource: actorSource(req),
    userAgent: normalizeString(req.get('user-agent')),
    method: req.method || null,
    path: req.originalUrl || req.path || null,
    metadata: {
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      body: safeJson(req.body),
      params: safeJson(req.params),
      query: safeJson(req.query),
      referer: normalizeString(req.get('referer'))
    }
  };
}

export function dispatchAuditMiddleware(prisma) {
  return async (req, res, next) => {
    try {
      // Mantiene los permisos de usuarios de base de datos sincronizados sin
      // obligarlos a cerrar sesión cuando un administrador cambia su alcance.
      await refreshDatabaseUserPermissions(prisma, req);
    } catch (error) {
      console.warn('No fue posible refrescar los permisos del usuario.', error);
    }

    if (!shouldAudit(req) || !prisma?.devAuditEvent?.create) return next();
    const startedAt = Date.now();
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      prisma.devAuditEvent.create({
        data: buildDispatchAuditEventData(req, res, startedAt)
      }).catch((error) => console.warn('No fue posible registrar auditoria de despacho.', error));
    });
    return next();
  };
}
