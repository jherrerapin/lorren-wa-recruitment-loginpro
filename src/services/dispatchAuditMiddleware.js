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

function firstHeaderValue(req, names = []) {
  for (const name of names) {
    const value = normalizeString(req.get(name));
    if (value) return value;
  }
  return null;
}

function normalizeForwardedIp(value) {
  const raw = normalizeString(value);
  if (!raw) return null;
  return raw.split(',').map((item) => item.trim()).find(Boolean) || null;
}

function cleanIpAddress(value) {
  const raw = normalizeString(value);
  if (!raw) return null;
  return raw.replace(/^::ffff:/, '').replace(/^\[/, '').split(']')[0];
}

function maskIpAddress(value) {
  const ip = cleanIpAddress(value);
  if (!ip) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const parts = ip.split('.');
    return `${parts[0]}.${parts[1]}.xxx.${parts[3]}`;
  }
  if (ip.includes(':')) return `${ip.split(':').slice(0, 2).join(':')}:****`;
  return ip;
}

function inferClientIp(req) {
  return cleanIpAddress(
    firstHeaderValue(req, ['cf-connecting-ip', 'x-real-ip', 'x-client-ip'])
    || normalizeForwardedIp(req.get('x-forwarded-for'))
    || req.ip
  );
}

function readApproximateOrigin(req) {
  const city = firstHeaderValue(req, ['cf-ipcity', 'x-vercel-ip-city', 'x-appengine-city']);
  const region = firstHeaderValue(req, ['cf-region', 'x-vercel-ip-country-region', 'x-appengine-region']);
  const country = firstHeaderValue(req, ['cf-ipcountry', 'x-vercel-ip-country', 'x-appengine-country']);
  const hasLocation = Boolean(city || region || country);
  return {
    source: hasLocation ? 'proxy_headers' : 'not_available',
    city,
    region,
    country,
    label: [city, region, country].filter(Boolean).join(', ') || null
  };
}

function parseDeviceLabel(userAgent) {
  const ua = normalizeString(userAgent) || '';
  const browser = ua.includes('Edg/') ? 'Edge' : ua.includes('Chrome/') ? 'Chrome' : ua.includes('Firefox/') ? 'Firefox' : ua.includes('Safari/') ? 'Safari' : 'Navegador no identificado';
  const os = ua.includes('Windows') ? 'Windows' : ua.includes('Mac OS') ? 'macOS' : ua.includes('Android') ? 'Android' : ua.includes('iPhone') || ua.includes('iPad') ? 'iOS' : ua.includes('Linux') ? 'Linux' : 'SO no identificado';
  const formFactor = /Mobi|Android|iPhone/i.test(ua) ? 'móvil' : 'escritorio';
  return `${browser} · ${os} · ${formFactor}`;
}

function inferChannel(req) {
  const path = req.path || '';
  if (path.startsWith('/operaciones/cliente/')) return 'Link público del cliente';
  if (path.startsWith('/admin/operaciones')) return 'Panel interno de despacho';
  return 'Operaciones';
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
  if (path.includes('/personal/importar-excel')) return 'DISPATCH_WORKER_IMPORT';
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
    const clientIp = inferClientIp(req);
    const origin = readApproximateOrigin(req);
    const userAgent = normalizeString(req.get('user-agent'));

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
          ipAddress: clientIp,
          forwardedFor: normalizeString(req.get('x-forwarded-for')),
          userAgent,
          method: req.method,
          path: req.originalUrl || req.path,
          fromValue: null,
          toValue: safeJson(req.body),
          metadata: {
            statusCode: res.statusCode,
            durationMs: Date.now() - startedAt,
            referer: normalizeString(req.get('referer')),
            params: safeJson(req.params),
            query: safeJson(req.query),
            channel: inferChannel(req),
            maskedIp: maskIpAddress(clientIp),
            deviceLabel: parseDeviceLabel(userAgent),
            originLocation: origin,
            operationCity: normalizeString(req.body?.cityName) || normalizeString(req.body?.operationCity) || null,
            serviceRequestId: normalizeString(req.body?.serviceRequestId) || null,
            assignmentId: normalizeString(req.body?.assignmentId) || null
          }
        }
      }).catch((error) => {
        console.warn('No fue posible registrar auditoria de despacho.', error);
      });
    });

    return next();
  };
}
