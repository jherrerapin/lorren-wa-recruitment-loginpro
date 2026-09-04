import { createHash } from 'node:crypto';
import { canManageUserModulePermissions } from './appUsers.js';
import { resolvePayrollFeatureAccess } from './payrollFeatureAccess.js';
import { resolveTestWorkspaceFeatureAccess } from './testWorkspaceFeatureAccess.js';
import { injectAdminModuleNavigation } from './adminNavigation.js';
import {
  canManageOperationalPermissions,
  hasOperationalCapability,
  OPERATIONAL_CAPABILITY,
  resolveOperationalAccess
} from './operationalAccess.js';

const PAYROLL_USERS_SCRIPT = '/public/payroll-user-access.js';
const PROGRAMMING_CONTACTS_SCRIPT = '/public/dispatch-programming-contacts.js';
const DEV_TEST_REQUEST_SOURCE = 'DEV_TEST';
const DEV_TEST_ASSIGNMENT_STATUSES = new Set(['DEV_TEST_ASSIGNED', 'DEV_TEST_CONFIRMED']);
const GUARDED_PRISMA_CLIENTS = new WeakSet();
const AUDIT_FINGERPRINT_CONTEXT = 'lorren-dispatch-audit-v1';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function requestPath(req = {}) {
  return String(req.originalUrl || req.url || req.path || '').split('?')[0];
}

export function requiredOperationalCapability(req = {}) {
  const path = requestPath(req);
  const method = String(req.method || 'GET').toUpperCase();
  const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  if (!path.startsWith('/admin/operaciones') && !path.startsWith('/operaciones/admin-')) return null;
  if (path.startsWith('/admin/operaciones/pruebas')) return null;

  if (path.startsWith('/admin/operaciones/asistencia/gestion-tiempo') || path.startsWith('/admin/operaciones/asistencia/nomina')) {
    if (isWrite && /\/policy\/?$/.test(path)) return null;
    if (isWrite && /\/imports\/[^/]+\/reverse\/?$/.test(path)) return OPERATIONAL_CAPABILITY.TIME_IMPORT_REVERSE;
    if (isWrite && /\/imports\/(?:preview|commit)\/?$/.test(path)) return OPERATIONAL_CAPABILITY.TIME_IMPORT;
    if (isWrite && /\/compensation\/?$/.test(path)) return OPERATIONAL_CAPABILITY.TIME_COMPENSATION;
    if (/\/export\.(?:csv|xlsx)\/?$/.test(path)) return OPERATIONAL_CAPABILITY.TIME_EXPORT;
    return OPERATIONAL_CAPABILITY.TIME_VIEW;
  }

  if (/^\/admin\/operaciones\/clientes\/[^/]+\/operaciones\/[^/]+\/asistencia(?:\/|$)/.test(path)) {
    return OPERATIONAL_CAPABILITY.ATTENDANCE_CONFIG;
  }

  if (path.startsWith('/admin/operaciones/asistencia')) {
    if (/\/cuadrillas(?:\/|$)/.test(path)) return OPERATIONAL_CAPABILITY.ATTENDANCE_CONFIG;
    if (isWrite && /\/sessions\/[^/]+\/review\/?$/.test(path)) {
      const action = normalizeString(req.body?.action)?.toUpperCase();
      return ['DELETE_MARK', 'ADD_MARK', 'CLEAR'].includes(action)
        ? OPERATIONAL_CAPABILITY.ATTENDANCE_CORRECT
        : OPERATIONAL_CAPABILITY.ATTENDANCE_MANAGE;
    }
    if (isWrite && /\/assignments\/[^/]+\/manual\/?$/.test(path)) return OPERATIONAL_CAPABILITY.ATTENDANCE_CORRECT;
    if (isWrite && /\/failures\/[^/]+\/decision\/?$/.test(path)) return OPERATIONAL_CAPABILITY.ATTENDANCE_MANAGE;
    return OPERATIONAL_CAPABILITY.ATTENDANCE_VIEW;
  }

  if (path.startsWith('/admin/operaciones/personal')) {
    if (isWrite && (/\/eliminar\/?$/.test(path) || /\/eliminar-bulk\/?$/.test(path))) return OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_DELETE;
    if (isWrite && /\/toggle\/?$/.test(path)) return OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_STATUS;
    if (path.includes('/importar-excel') || path.includes('/nuevo') || path.includes('/editar')) {
      return OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_MANAGE;
    }
    return OPERATIONAL_CAPABILITY.DISPATCH_VIEW;
  }

  if (path.startsWith('/admin/operaciones/solicitudes')) {
    return isWrite ? OPERATIONAL_CAPABILITY.DISPATCH_REQUEST_MANAGE : OPERATIONAL_CAPABILITY.DISPATCH_VIEW;
  }

  if (path.startsWith('/admin/operaciones/asignaciones')) {
    if (isWrite && path.includes('/descansos')) return OPERATIONAL_CAPABILITY.DISPATCH_REST_MANAGE;
    return isWrite ? OPERATIONAL_CAPABILITY.DISPATCH_ASSIGNMENT_MANAGE : OPERATIONAL_CAPABILITY.DISPATCH_VIEW;
  }

  if (path.startsWith('/admin/operaciones/novedades')) {
    return isWrite ? OPERATIONAL_CAPABILITY.DISPATCH_INCIDENT_MANAGE : OPERATIONAL_CAPABILITY.DISPATCH_VIEW;
  }

  if (path.startsWith('/admin/operaciones/whatsapp')) {
    return isWrite ? OPERATIONAL_CAPABILITY.DISPATCH_WHATSAPP_SEND : OPERATIONAL_CAPABILITY.DISPATCH_VIEW;
  }

  if (path.startsWith('/admin/operaciones/clientes')) {
    if (isWrite && /\/eliminar\/?$/.test(path)) return OPERATIONAL_CAPABILITY.DISPATCH_MASTERDATA_DELETE;
    return isWrite ? OPERATIONAL_CAPABILITY.DISPATCH_MASTERDATA_MANAGE : OPERATIONAL_CAPABILITY.DISPATCH_VIEW;
  }

  if (path.startsWith('/admin/operaciones/programacion')) {
    return isWrite ? OPERATIONAL_CAPABILITY.DISPATCH_REQUEST_MANAGE : OPERATIONAL_CAPABILITY.DISPATCH_VIEW;
  }

  if (path.startsWith('/operaciones/admin-delete/clientes')) return OPERATIONAL_CAPABILITY.DISPATCH_MASTERDATA_DELETE;
  if (path.startsWith('/operaciones/admin-delete/personal')) return OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_DELETE;
  if (path.startsWith('/operaciones/admin-delete/solicitudes')) return OPERATIONAL_CAPABILITY.DISPATCH_REQUEST_MANAGE;
  if (path.startsWith('/operaciones/admin-clientes')) {
    return isWrite ? OPERATIONAL_CAPABILITY.DISPATCH_MASTERDATA_MANAGE : OPERATIONAL_CAPABILITY.DISPATCH_VIEW;
  }
  if (path.startsWith('/operaciones/admin-worker')) return OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_MANAGE;
  if (path.startsWith('/operaciones/admin-')) {
    return isWrite ? OPERATIONAL_CAPABILITY.DISPATCH_MASTERDATA_MANAGE : OPERATIONAL_CAPABILITY.DISPATCH_VIEW;
  }

  return isWrite ? OPERATIONAL_CAPABILITY.DISPATCH_MASTERDATA_MANAGE : OPERATIONAL_CAPABILITY.DISPATCH_VIEW;
}

function enforceOperationalCapability(req, res) {
  const required = requiredOperationalCapability(req);
  if (!required) return true;
  if (hasOperationalCapability(req, required)) return true;
  res.status(403).send('No tienes permiso para realizar esta función operativa.');
  return false;
}

function auditFingerprint(value, namespace = 'entity') {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  const digest = createHash('sha256')
    .update(AUDIT_FINGERPRINT_CONTEXT, 'utf8')
    .update('\0', 'utf8')
    .update(namespace, 'utf8')
    .update('\0', 'utf8')
    .update(normalized, 'utf8')
    .digest('hex')
    .slice(0, 24);
  return `audit-${digest}`;
}

function sanitizeFallbackRoute(pathname = '') {
  const path = String(pathname || '').split('?')[0];
  if (!path) return null;
  return path
    .split('/')
    .map((segment) => {
      if (!segment) return segment;
      if (/^[a-f0-9]{32,}$/i.test(segment)) return ':token';
      if (/^\d+$/.test(segment)) return ':id';
      if (/^[A-Za-z0-9_-]{20,}$/.test(segment)) return ':id';
      return segment;
    })
    .join('/');
}

function normalizedRouteName(req) {
  const routePath = typeof req.route?.path === 'string' ? req.route.path : null;
  if (routePath) {
    const baseUrl = normalizeString(req.baseUrl) || '';
    return `${baseUrl}${routePath}`.replace(/\/{2,}/g, '/') || '/';
  }
  return sanitizeFallbackRoute(req.path || req.originalUrl);
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
    || normalizedRouteName(req)
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
    return { serviceRequestId: compound.serviceRequestId, workerId: compound.workerId, status: null };
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
    ? await prisma.dispatchWorker.findUnique({ where: { id: workerId }, select: { id: true, operationalStatus: true } })
    : null;
  const explicitStatuses = payloads.map((item) => item.status).filter(Boolean);
  const statuses = explicitStatuses.length ? explicitStatuses : [existing?.status].filter(Boolean);
  const statusAllowed = statuses.length > 0 && statuses.every((status) => DEV_TEST_ASSIGNMENT_STATUSES.has(status));
  const workerAllowed = Boolean(worker?.id) && worker.operationalStatus !== 'ELIMINADO';

  if (!workerAllowed || !statusAllowed) throw new Error('dev_test_assignment_isolated');
}

function installDevTestAssignmentGuard(prisma) {
  if (!prisma || GUARDED_PRISMA_CLIENTS.has(prisma) || typeof prisma.$use !== 'function') return;
  prisma.$use(async (params, next) => {
    await validateDevTestAssignmentMutation(prisma, params);
    return next(params);
  });
  GUARDED_PRISMA_CLIENTS.add(prisma);
}

function clearOperationalAccess(req) {
  req.session.operationalAccessConfigured = false;
  req.session.operationalRole = null;
  req.session.operationalEffectivePermissions = [];
  req.session.operationalDelegablePermissions = [];
  req.operationalAccessConfigured = false;
  req.operationalRole = null;
  req.operationalEffectivePermissions = [];
  req.operationalDelegablePermissions = [];
}

function applyOperationalAccess(req, access = {}) {
  const configured = access.configured === true;
  const role = normalizeString(access.role);
  const effectivePermissions = Array.isArray(access.effectivePermissions) ? access.effectivePermissions : [];
  const delegablePermissions = Array.isArray(access.delegablePermissions) ? access.delegablePermissions : [];
  req.session.operationalAccessConfigured = configured;
  req.session.operationalRole = role;
  req.session.operationalEffectivePermissions = effectivePermissions;
  req.session.operationalDelegablePermissions = delegablePermissions;
  req.operationalAccessConfigured = configured;
  req.operationalRole = role;
  req.operationalEffectivePermissions = effectivePermissions;
  req.operationalDelegablePermissions = delegablePermissions;
}

function denyOperationalAccess(req) {
  applyOperationalAccess(req, {
    configured: true,
    role: null,
    effectivePermissions: [],
    delegablePermissions: []
  });
}

function clearSessionPermissions(req) {
  req.session.userRole = null;
  req.session.userId = null;
  req.session.canAccessDispatch = false;
  req.session.canAccessAttendance = false;
  req.session.canAccessPayroll = false;
  req.session.canAccessTestWorkspace = false;
  req.session.canAccessStatistics = false;
  req.session.canAccessMetaAds = false;
  req.session.canAccessCvAnalysis = false;
  req.userRole = null;
  req.userId = null;
  req.canAccessDispatch = false;
  req.canAccessAttendance = false;
  req.canAccessPayroll = false;
  req.canAccessTestWorkspace = false;
  req.canAccessStatistics = false;
  req.canAccessMetaAds = false;
  req.canAccessCvAnalysis = false;
  clearOperationalAccess(req);
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
    req.session.canAccessTestWorkspace = isDev;
    req.canAccessPayroll = isDev;
    req.canAccessTestWorkspace = isDev;
    if (isDev) applyOperationalAccess(req, await resolveOperationalAccess(prisma, { userRole: 'dev', userId: req.session?.userId, username: req.session?.username }));
    else clearOperationalAccess(req);
    return;
  }

  const user = await prisma.appUser.findUnique({
    where: isEnvironmentAdmin ? { username: req.session.username } : { id: req.session.userId },
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
    req.session.canAccessTestWorkspace = false;
    req.canAccessPayroll = false;
    req.canAccessTestWorkspace = false;
    denyOperationalAccess(req);
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
  let canAccessTestWorkspace = false;
  let operationalAccess = { configured: false, role: null, effectivePermissions: [], delegablePermissions: [] };
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
  try {
    const testAccess = await resolveTestWorkspaceFeatureAccess(prisma, {
      userRole: req.session?.userRole || req.userRole,
      userId: user.id,
      username: user.username
    });
    canAccessTestWorkspace = testAccess.allowed === true;
  } catch (error) {
    console.warn('No fue posible refrescar el permiso del entorno de pruebas.', error);
  }
  try {
    operationalAccess = await resolveOperationalAccess(prisma, {
      userRole: req.session?.userRole || req.userRole,
      userId: user.id,
      username: user.username
    });
  } catch (error) {
    console.warn('No fue posible refrescar el rol operativo.', error);
    operationalAccess = { configured: true, role: null, effectivePermissions: [], delegablePermissions: [] };
  }

  req.session.userAccessScope = accessScope;
  req.session.userAccessCity = accessCity;
  req.session.userAccessVacancyId = accessVacancyId;
  req.session.canAccessDispatch = canAccessDispatch;
  req.session.canAccessAttendance = canAccessAttendance;
  req.session.canAccessPayroll = canAccessPayroll;
  req.session.canAccessTestWorkspace = canAccessTestWorkspace;
  req.session.canAccessStatistics = canAccessStatistics;
  req.session.canAccessMetaAds = canAccessMetaAds;
  req.session.canAccessCvAnalysis = canAccessCvAnalysis;
  applyOperationalAccess(req, operationalAccess);
  if (isEnvironmentAdmin) req.session.userId = user.id;

  req.userId = isEnvironmentAdmin ? user.id : req.userId;
  req.userAccessScope = accessScope;
  req.userAccessCity = accessCity;
  req.userAccessVacancyId = accessVacancyId;
  req.canAccessDispatch = canAccessDispatch;
  req.canAccessAttendance = canAccessAttendance;
  req.canAccessPayroll = canAccessPayroll;
  req.canAccessTestWorkspace = canAccessTestWorkspace;
  req.canAccessStatistics = canAccessStatistics;
  req.canAccessMetaAds = canAccessMetaAds;
  req.canAccessCvAnalysis = canAccessCvAnalysis;
}

function isHtmlResponse(body, res) {
  if (typeof body !== 'string') return false;
  const contentType = String(res.getHeader('Content-Type') || '').toLowerCase();
  return contentType.includes('text/html') || body.trimStart().startsWith('<!DOCTYPE html') || body.trimStart().startsWith('<html');
}

export function sanitizeUsersPermissionCopy(html) {
  if (typeof html !== 'string') return html;
  return html
    .replaceAll('Los permisos adicionales solo pueden ser concedidos por DEV o reclutador-general.', '')
    .replaceAll('Puedes crear usuarios dentro de tu alcance. Los permisos adicionales del panel los asigna DEV o reclutador-general.', '')
    .replaceAll('Solo DEV y reclutador-general pueden modificar estos permisos.', '');
}

function injectPayrollUsersScript(html, req) {
  const path = requestPath(req);
  const isDev = (req.session?.userRole || req.userRole) === 'dev';
  const canSupervise = canManageOperationalPermissions(req) && !isDev;
  const usersPageAllowed = path === '/admin/users' && canManageUserModulePermissions(req);
  const supervisorPageAllowed = path.startsWith('/admin/operaciones') && canSupervise;
  if ((!usersPageAllowed && !supervisorPageAllowed) || html.includes(PAYROLL_USERS_SCRIPT)) return html;
  const canManageTestWorkspace = isDev;
  const operationalActorRole = isDev ? 'dev' : canSupervise ? 'supervisor' : 'none';
  return html.replace(
    /<\/body>/i,
    `  <script src="${PAYROLL_USERS_SCRIPT}" data-can-manage-test-workspace="${canManageTestWorkspace ? 'true' : 'false'}" data-operational-actor-role="${operationalActorRole}" data-can-supervise-operational-permissions="${canSupervise ? 'true' : 'false'}"></script>\n</body>`
  );
}

function normalizeProgrammingPresentation(html, req) {
  const path = String(req.originalUrl || '').split('?')[0];
  if (path !== '/admin/operaciones') return html;
  return html
    .replace('aria-label="Formatos para enviar a gerentes"', 'aria-label="Formatos para enviar reportes"')
    .replace('<strong>Enviar a gerentes:</strong>', '<strong>Enviar reportes:</strong>')
    .replace("showToast(formatLabel+' enviado a los gerentes.');", "showToast(formatLabel+' enviado a los destinatarios configurados.');");
}

function injectProgrammingContactsScript(html, req) {
  const path = String(req.originalUrl || '').split('?')[0];
  if (path !== '/admin/operaciones' || html.includes(PROGRAMMING_CONTACTS_SCRIPT)) return html;
  const isDev = (req.session?.userRole || req.userRole) === 'dev';
  return html.replace(/<\/body>/i, `  <script src="${PROGRAMMING_CONTACTS_SCRIPT}" data-dev="${isDev ? 'true' : 'false'}"></script>\n</body>`);
}

function installAdminHtmlBridge(req, res) {
  const originalSend = res.send.bind(res);
  res.send = (body) => {
    if (!isHtmlResponse(body, res)) return originalSend(body);
    const withNavigation = injectAdminModuleNavigation(body, req);
    const path = String(req.originalUrl || '').split('?')[0];
    const withPrivateCopyRemoved = path === '/admin/users'
      ? sanitizeUsersPermissionCopy(withNavigation)
      : withNavigation;
    const withPayrollUsers = injectPayrollUsersScript(withPrivateCopyRemoved, req);
    const withProgrammingCopy = normalizeProgrammingPresentation(withPayrollUsers, req);
    return originalSend(injectProgrammingContactsScript(withProgrammingCopy, req));
  };
}

export function buildDispatchAuditEventData(req, res, startedAt = Date.now()) {
  const routeName = normalizedRouteName(req);
  const statusCode = Number(res.statusCode || 0);
  return {
    entityType: 'DISPATCH',
    entityId: auditFingerprint(targetFor(req), 'target'),
    entityLabel: routeName,
    action: inferAction(req),
    actorUsername: auditFingerprint(actorUsername(req), 'actor'),
    actorRole: normalizeString(req.session?.userRole || req.userRole),
    actorSource: actorSource(req),
    method: req.method || null,
    path: routeName,
    metadata: {
      statusCode,
      durationMs: Math.max(0, Date.now() - startedAt),
      operationResult: statusCode >= 200 && statusCode < 400 ? 'SUCCESS' : 'FAILURE'
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
      const isDev = req.session?.userRole === 'dev';
      req.session.canAccessPayroll = isDev;
      req.session.canAccessTestWorkspace = isDev;
      req.canAccessPayroll = isDev;
      req.canAccessTestWorkspace = isDev;
      if (isDev) applyOperationalAccess(req, await resolveOperationalAccess(prisma, { userRole: 'dev' }));
      else denyOperationalAccess(req);
    }

    if (!enforceOperationalCapability(req, res)) return;
    installAdminHtmlBridge(req, res);
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
