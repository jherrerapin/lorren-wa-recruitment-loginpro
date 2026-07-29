import { resolvePayrollFeatureAccess } from './payrollFeatureAccess.js';

const PAYROLL_PATH = '/admin/operaciones/asistencia/nomina';
const PAYROLL_USERS_SCRIPT = '/public/payroll-user-access.js';
const DEV_TEST_REQUEST_SOURCE = 'DEV_TEST';
const DEV_TEST_ASSIGNMENT_STATUSES = new Set(['DEV_TEST_ASSIGNED', 'DEV_TEST_CONFIRMED']);
const GUARDED_PRISMA_CLIENTS = new WeakSet();

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
  if (path.includes('/nomina')) return 'DISPATCH_PAYROLL_CHANGE';
  if (path.includes('/pruebas')) return 'DISPATCH_DEV_TEST_CHANGE';
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

function assignmentMutationPayloads(params) {
  if (params.action === 'create') return [params.args?.data || {}];
  if (params.action === 'update' || params.action === 'updateMany') return [params.args?.data || {}];
  if (params.action === 'upsert') return [params.args?.create || {}, params.args?.update || {}];
  return [];
}

async function existingAssignmentContext(prisma, params) {
  const where = params.args?.where || {};
  const compound = where.serviceRequestId_workerId || {};
  if (compound.serviceRequestId && compound.workerId) {
    return {
      serviceRequestId: compound.serviceRequestId,
      workerId: compound.workerId,
      status: null
    };
  }
  if (where.serviceRequestId && where.workerId) {
    return {
      serviceRequestId: where.serviceRequestId,
      workerId: where.workerId,
      status: null
    };
  }
  if (!where.id || !prisma?.dispatchAssignment?.findUnique) return null;
  return prisma.dispatchAssignment.findUnique({
    where: { id: where.id },
    select: { serviceRequestId: true, workerId: true, status: true }
  });
}

async function validateDevTestAssignmentMutation(prisma, params) {
  if (params.model !== 'DispatchAssignment' || !['create', 'update', 'updateMany', 'upsert'].includes(params.action)) return;
  const payloads = assignmentMutationPayloads(params);
  const existing = await existingAssignmentContext(prisma, params);
  const serviceRequestId = payloads.map((item) => item.serviceRequestId).find(Boolean) || existing?.serviceRequestId || null;
  if (!serviceRequestId) return;

  const request = await prisma.dispatchServiceRequest.findUnique({
    where: { id: serviceRequestId },
    select: { source: true }
  });
  if (request?.source !== DEV_TEST_REQUEST_SOURCE) return;

  const workerId = payloads.map((item) => item.workerId).find(Boolean) || existing?.workerId || null;
  const worker = workerId
    ? await prisma.dispatchWorker.findUnique({ where: { id: workerId }, select: { isTestProfile: true } })
    : null;
  const explicitStatuses = payloads.map((item) => item.status).filter(Boolean);
  const statuses = explicitStatuses.length ? explicitStatuses : [existing?.status].filter(Boolean);
  const statusAllowed = statuses.length > 0 && statuses.every((status) => DEV_TEST_ASSIGNMENT_STATUSES.has(status));

  if (worker?.isTestProfile !== true || !statusAllowed) {
    throw new Error('dev_test_assignment_isolated');
  }
}

function installDevTestAssignmentGuard(prisma) {
  if (!prisma || GUARDED_PRISMA_CLIENTS.has(prisma) || typeof prisma.$use !== 'function') return;
  prisma.$use(async (params, next) => {
    await validateDevTestAssignmentMutation(prisma, params);
    return next(params);
  });
  GUARDED_PRISMA_CLIENTS.add(prisma);
}

function clearSessionPermissions(req) {
  req.session.userRole = null;
  req.session.userId = null;
  req.session.canAccessDispatch = false;
  req.session.canAccessAttendance = false;
  req.session.canAccessPayroll = false;
  req.session.canAccessStatistics = false;
  req.session.canAccessMetaAds = false;
  req.session.canAccessCvAnalysis = false;
  req.userRole = null;
  req.userId = null;
  req.canAccessDispatch = false;
  req.canAccessAttendance = false;
  req.canAccessPayroll = false;
  req.canAccessStatistics = false;
  req.canAccessMetaAds = false;
  req.canAccessCvAnalysis = false;
}

async function refreshDatabaseUserPermissions(prisma, req) {
  const source = req.session?.userSource;
  const isDatabaseUser = source === 'db' && Boolean(req.session?.userId);
  const isEnvironmentAdmin = source === 'env'
    && req.session?.userRole === 'admin'
    && Boolean(req.session?.username)
    && req.session.username === normalizeString(process.env.ADMIN_USER);
  if (!isDatabaseUser && !isEnvironmentAdmin) {
    const isDev = req.session?.userRole === 'dev' || req.userRole === 'dev';
    req.session.canAccessPayroll = isDev;
    req.canAccessPayroll = isDev;
    return;
  }

  const user = await prisma.appUser.findUnique({
    where: isEnvironmentAdmin
      ? { username: req.session.username }
      : { id: req.session.userId },
    select: {
      id: true,
      username: true,
      isActive: true,
      accessScope: true,
      scopeCity: true,
      scopeVacancyId: true,
      canAccessDispatch: true,
      canAccessAttendance: true,
      canAccessStatistics: true,
      canAccessMetaAds: true,
      canAccessCvAnalysis: true
    }
  });

  if (!user && isEnvironmentAdmin) {
    req.session.canAccessPayroll = false;
    req.canAccessPayroll = false;
    return;
  }

  if (!user || !user.isActive) {
    clearSessionPermissions(req);
    return;
  }

  const accessScope = user.accessScope || 'ALL';
  const accessCity = user.scopeCity || null;
  const accessVacancyId = user.scopeVacancyId || null;
  const canAccessAttendance = Boolean(user.canAccessAttendance);
  const canAccessDispatch = Boolean(user.canAccessDispatch) || canAccessAttendance;
  const canAccessMetaAds = Boolean(user.canAccessMetaAds);
  const canAccessCvAnalysis = Boolean(user.canAccessCvAnalysis);
  const canAccessStatistics = canAccessMetaAds || canAccessCvAnalysis;
  let canAccessPayroll = false;
  try {
    const payrollAccess = await resolvePayrollFeatureAccess(prisma, {
      userRole: req.session?.userRole || req.userRole,
      userId: user.id,
      username: user.username
    });
    canAccessPayroll = payrollAccess.allowed === true;
  } catch (error) {
    console.warn('No fue posible refrescar el permiso de Nómina.', error);
  }

  req.session.userAccessScope = accessScope;
  req.session.userAccessCity = accessCity;
  req.session.userAccessVacancyId = accessVacancyId;
  req.session.canAccessDispatch = canAccessDispatch;
  req.session.canAccessAttendance = canAccessAttendance;
  req.session.canAccessPayroll = canAccessPayroll;
  req.session.canAccessStatistics = canAccessStatistics;
  req.session.canAccessMetaAds = canAccessMetaAds;
  req.session.canAccessCvAnalysis = canAccessCvAnalysis;
  if (isEnvironmentAdmin) req.session.userId = user.id;

  req.userId = isEnvironmentAdmin ? user.id : req.userId;
  req.userAccessScope = accessScope;
  req.userAccessCity = accessCity;
  req.userAccessVacancyId = accessVacancyId;
  req.canAccessDispatch = canAccessDispatch;
  req.canAccessAttendance = canAccessAttendance;
  req.canAccessPayroll = canAccessPayroll;
  req.canAccessStatistics = canAccessStatistics;
  req.canAccessMetaAds = canAccessMetaAds;
  req.canAccessCvAnalysis = canAccessCvAnalysis;
}

function isHtmlResponse(body, res) {
  if (typeof body !== 'string') return false;
  const contentType = String(res.getHeader('Content-Type') || '').toLowerCase();
  return contentType.includes('text/html') || body.trimStart().startsWith('<!DOCTYPE html') || body.trimStart().startsWith('<html');
}

function injectPayrollNavigation(html, req) {
  const allowed = req.canAccessPayroll === true || req.session?.canAccessPayroll === true;
  const path = String(req.originalUrl || '').split('?')[0];
  if (!allowed || !path.startsWith('/admin') || path.startsWith('/admin/operaciones/asistencia/nomina/api/')) return html;
  if (html.includes(`href="${PAYROLL_PATH}"`)) return html;
  const link = `<a href="${PAYROLL_PATH}">Nómina</a>`;
  if (html.includes('<span class="spacer"></span>')) {
    return html.replace('<span class="spacer"></span>', `${link}\n    <span class="spacer"></span>`);
  }
  return html.replace(/<\/nav>/i, `  ${link}\n  </nav>`);
}

function injectPayrollUsersScript(html, req) {
  const path = String(req.originalUrl || '').split('?')[0];
  const role = req.session?.userRole || req.userRole;
  if (path !== '/admin/users' || role !== 'dev' || html.includes(PAYROLL_USERS_SCRIPT)) return html;
  return html.replace(/<\/body>/i, `  <script src="${PAYROLL_USERS_SCRIPT}"></script>\n</body>`);
}

function installPayrollHtmlBridge(req, res) {
  const originalSend = res.send.bind(res);
  res.send = (body) => {
    if (!isHtmlResponse(body, res)) return originalSend(body);
    const withNavigation = injectPayrollNavigation(body, req);
    return originalSend(injectPayrollUsersScript(withNavigation, req));
  };
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
  installDevTestAssignmentGuard(prisma);
  return async (req, res, next) => {
    try {
      await refreshDatabaseUserPermissions(prisma, req);
    } catch (error) {
      console.warn('No fue posible refrescar los permisos del usuario.', error);
      req.session.canAccessPayroll = req.session?.userRole === 'dev';
      req.canAccessPayroll = req.session?.userRole === 'dev';
    }

    installPayrollHtmlBridge(req, res);

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
