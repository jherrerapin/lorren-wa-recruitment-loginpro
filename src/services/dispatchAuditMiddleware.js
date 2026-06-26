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

function targetFor(req) {
  return normalizeString(req.body?.context?.assignmentId)
    || normalizeString(req.body?.assignmentId)
    || normalizeString(req.body?.context?.serviceRequestId)
    || normalizeString(req.body?.serviceRequestId)
    || normalizeString(req.body?.workerId)
    || req.path
    || 'dispatch';
}

export function dispatchAuditMiddleware(prisma) {
  return (req, res, next) => {
    if (!shouldAudit(req) || !prisma?.devAuditEvent?.create) return next();
    const startedAt = Date.now();
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      prisma.devAuditEvent.create({
        data: {
          username: actorUsername(req),
          action: inferAction(req),
          target: targetFor(req),
          detail: {
            statusCode: res.statusCode,
            durationMs: Date.now() - startedAt,
            method: req.method,
            path: req.originalUrl || req.path,
            body: safeJson(req.body),
            params: safeJson(req.params),
            query: safeJson(req.query),
            referer: normalizeString(req.get('referer')),
            userAgent: normalizeString(req.get('user-agent'))
          }
        }
      }).catch((error) => console.warn('No fue posible registrar auditoria de despacho.', error));
    });
    return next();
  };
}
