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
  } catch (error) {
    return { error: 'unserializable_payload' };
  }
}

function inferAuditAction(req) {
  const path = req.path || '';
  if (path.includes('/asignaciones/assign')) return 'DISPATCH_ASSIGNMENT_CREATE';
  if (path.includes('/asignaciones/confirmar')) return 'DISPATCH_ASSIGNMENT_CONFIRM';
  if (path.includes('/asignaciones/no-confirmado')) return 'DISPATCH_ASSIGNMENT_NO_CONFIRM';
  if (path.includes('/asignaciones/unassign')) return 'DISPATCH_ASSIGNMENT_REMOVE';
  if (path.includes('/novedades') && path.includes('/resolver')) return 'DISPATCH_INCIDENT_RESOLVE';
  if (path.includes('/novedades') && path.includes('/reabrir')) return 'DISPATCH_INCIDENT_REOPEN';
  if (path.includes('/novedades')) return 'DISPATCH_INCIDENT_CREATE';
  if (path.includes('/solicitudes') && path.includes('/editar')) return 'DISPATCH_SERVICE_REQUEST_UPDATE';
  if (path.includes('/solicitudes') && path.includes('/eliminar')) return 'DISPATCH_SERVICE_REQUEST_DELETE';
  if (path.includes('/solicitudes')) return 'DISPATCH_SERVICE_REQUEST_CREATE';
  if (path.includes('/cliente/') && req.method === 'POST') return path.includes('/editar') ? 'PUBLIC_SERVICE_REQUEST_UPDATE' : 'PUBLIC_SERVICE_REQUEST_CREATE';
  if (path.includes('/personal')) return 'DISPATCH_WORKER_CHANGE';
  if (path.includes('/clientes')) return 'DISPATCH_CLIENT_CHANGE';
  return 'DISPATCH_OPERATION_MUTATION';
}

function inferEntityType(req) {
  const path = req.path || '';
  if (path.includes('/asignaciones')) return 'DispatchAssignment';
  if (path.includes('/solicitudes') || path.includes('/cliente/')) return 'DispatchServiceRequest';
  if (path.includes('/novedades')) return 'DispatchIncident';
  if (path.includes('/personal')) return 'DispatchWorker';
  if (path.includes('/clientes')) return 'DispatchClient';
  return 'DispatchOperation';
}

function inferEntityId(req) {
  const path = req.path || '';
  return normalizeString(req.body?.serviceRequestId)
    || normalizeString(req.body?.assignmentId)
    || normalizeString(req.body?.workerId)
    || normalizeString(path.match(/solicitudes\/([^/]+)/)?.[1])
    || normalizeString(path.match(/personal\/([^/]+)/)?.[1])
    || normalizeString(path.match(/clientes\/([^/]+)/)?.[1])
    || normalizeString(path.match(/novedades\/([^/]+)/)?.[1])
    || null;
}

function shouldAudit(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return false;
  const path = req.path || '';
  return path.startsWith('/admin/operaciones') || path.startsWith('/operaciones/admin-') || path.startsWith('/operaciones/cliente/');
}

export function dispatchAuditMiddleware(prisma) {
  return (req, res, next) => {
    if (!shouldAudit(req)) return next();

    const canWriteAudit = Boolean(prisma?.devAuditEvent?.create);
    if (!canWriteAudit) return next();

    const startedAt = Date.now();
    res.on('finish', () => {
      if (res.statusCode >= 400) return;

      const action = inferAuditAction(req);
      const entityType = inferEntityType(req);
      const entityId = inferEntityId(req);
      const isPublicClient = (req.path || '').startsWith('/operaciones/cliente/');
      const actorUsername = normalizeString(req.session?.username || req.username) || (isPublicClient ? 'cliente-publico' : null);
      const actorRole = normalizeString(req.session?.userRole || req.userRole) || (isPublicClient ? 'public_client' : null);

      prisma.devAuditEvent.create({
        data: {
          entityType,
          entityId,
          entityLabel: normalizeString(req.body?.clientName) || normalizeString(req.body?.fullName) || normalizeString(req.body?.name) || null,
          action,
          actorUserId: normalizeString(req.session?.userId || req.userId),
          actorUsername,
          actorRole,
          actorSource: normalizeString(req.session?.userSource || req.userSource) || (isPublicClient ? 'public_link' : null),
          ipAddress: normalizeString(req.ip),
          forwardedFor: normalizeString(req.get('x-forwarded-for')),
          userAgent: normalizeString(req.get('user-agent')),
          method: req.method,
          path: req.originalUrl || req.path,
          fromValue: null,
          toValue: safeJson(req.body),
          metadata: {
            statusCode: res.statusCode,
            durationMs: Date.now() - startedAt,
            referer: normalizeString(req.get('referer')),
            params: safeJson(req.params),
            query: safeJson(req.query)
          }
        }
      }).catch((error) => {
        console.warn('No fue posible registrar auditoria de despacho.', error);
      });
    });

    return next();
  };
}
