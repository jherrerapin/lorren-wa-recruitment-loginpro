import { createHash } from 'node:crypto';
import { canManageUserModulePermissions } from './appUsers.js';
import {
  filterOperationalClientsByCityScope,
  operationalCityScopeAllowsName,
  resolveUserCityScope
} from './cityOptions.js';
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
const SERVICE_REQUESTS_PATH = '/admin/operaciones/solicitudes';
const SERVICE_REQUESTS_VIEW = 'operacionesSolicitudes';
const CLIENTS_PATH = '/admin/operaciones/clientes';
const PERSONNEL_PATH = '/admin/operaciones/personal';
const OPERATIONS_CITY_API_PATH = '/operaciones/api/ciudades';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeStringList(value) {
  const values = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return [...new Set(values.map((item) => normalizeString(item)).filter(Boolean))];
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
    return OPERATIONAL_CAPABILITY.DISPATCH_REQUEST_MANAGE;
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
    console.warn('No fue posible refrescar el permiso de Gestión de Tiempo.', error);
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

function operationalCityAllowed(scope, cityName) {
  return operationalCityScopeAllowsName(scope, cityName, { selected: false });
}

function workerInCityScope(worker, scope) {
  if (!scope?.restricted) return true;
  const assignedCityNames = (worker?.cities || [])
    .map((entry) => entry?.city?.name || entry?.name)
    .filter(Boolean);
  if (assignedCityNames.length) return assignedCityNames.some((name) => operationalCityAllowed(scope, name));
  return operationalCityAllowed(scope, worker?.residenceCity);
}

function filterWorkersByCityScope(workers, scope) {
  if (!Array.isArray(workers) || !scope?.restricted) return workers;
  return workers.filter((worker) => workerInCityScope(worker, scope));
}

function filterVacanciesByCityScope(vacancies, scope) {
  if (!Array.isArray(vacancies) || !scope?.restricted) return vacancies;
  return vacancies.filter((vacancy) => operationalCityAllowed(scope, vacancy?.city));
}

function filterCityOptions(cities, scope) {
  if (!Array.isArray(cities) || !scope?.restricted) return cities;
  const allowedIds = new Set(scope.allowedCityIds || []);
  return cities.filter((city) => allowedIds.has(city?.id));
}

function installOperationalCityRenderGate(res, scope) {
  const originalRender = res.render.bind(res);
  res.render = (view, locals, callback) => {
    let renderLocals = locals || {};
    let renderCallback = callback;
    if (typeof locals === 'function') {
      renderCallback = locals;
      renderLocals = {};
    }

    const nextLocals = { ...renderLocals, operationalCityScope: scope };
    if (Array.isArray(nextLocals.cities)) nextLocals.cities = filterCityOptions(nextLocals.cities, scope);
    if (Array.isArray(nextLocals.vacancies)) nextLocals.vacancies = filterVacanciesByCityScope(nextLocals.vacancies, scope);
    if (Array.isArray(nextLocals.clients)) nextLocals.clients = filterOperationalClientsByCityScope(nextLocals.clients, scope);
    if (Array.isArray(nextLocals.serviceRequests)) {
      nextLocals.serviceRequests = nextLocals.serviceRequests.filter((request) => operationalCityAllowed(scope, request?.cityName));
    }
    if (Array.isArray(nextLocals.workers)) nextLocals.workers = filterWorkersByCityScope(nextLocals.workers, scope);
    if (Array.isArray(nextLocals.availableWorkers)) nextLocals.availableWorkers = filterWorkersByCityScope(nextLocals.availableWorkers, scope);
    if (nextLocals.client && Array.isArray(nextLocals.client.operationPoints)) {
      nextLocals.client = {
        ...nextLocals.client,
        operationPoints: nextLocals.client.operationPoints.filter((point) => operationalCityAllowed(scope, point?.cityName || nextLocals.client?.cityName))
      };
    }
    if (nextLocals.selectedServiceRequest && !operationalCityAllowed(scope, nextLocals.selectedServiceRequest.cityName)) {
      nextLocals.selectedServiceRequest = null;
      nextLocals.selectedServiceRequestId = '';
    }

    return originalRender(view, nextLocals, renderCallback);
  };
}

function installOperationalCityJsonGate(res, scope) {
  if (!res || typeof res.json !== 'function') return;
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (!body || !Array.isArray(body.cities)) return originalJson(body);
    return originalJson({ ...body, cities: filterCityOptions(body.cities, scope) });
  };
}

function clientIdFromPath(path) {
  const patterns = [
    /^\/admin\/operaciones\/clientes\/([^/]+)/,
    /^\/operaciones\/admin-clientes\/([^/]+)/,
    /^\/operaciones\/admin-delete\/clientes\/([^/]+)/
  ];
  for (const pattern of patterns) {
    const match = path.match(pattern);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return null;
}

function operationPointIdFromPath(path) {
  const patterns = [
    /^\/admin\/operaciones\/clientes\/[^/]+\/operaciones\/([^/]+)/,
    /^\/operaciones\/admin-clientes\/[^/]+\/operaciones\/([^/]+)/,
    /^\/operaciones\/admin-delete\/clientes\/[^/]+\/operaciones\/([^/]+)/
  ];
  for (const pattern of patterns) {
    const match = path.match(pattern);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return null;
}

function workerIdFromPath(path) {
  const patterns = [
    /^\/admin\/operaciones\/personal\/([^/]+)/,
    /^\/operaciones\/admin-worker\/([^/]+)/,
    /^\/operaciones\/admin-delete\/personal\/([^/]+)/
  ];
  const reserved = new Set(['nuevo', 'importar-excel', 'exportar-excel', 'eliminar-bulk', 'documento-existe']);
  for (const pattern of patterns) {
    const match = path.match(pattern);
    const id = match?.[1] ? decodeURIComponent(match[1]) : null;
    if (id && !reserved.has(id)) return id;
  }
  return null;
}

async function enforceClientCityScope(prisma, req, res, scope) {
  const path = requestPath(req);
  const method = String(req.method || 'GET').toUpperCase();
  const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  if (!path.startsWith(CLIENTS_PATH)
    && !path.startsWith('/operaciones/admin-clientes')
    && !path.startsWith('/operaciones/admin-delete/clientes')) return true;

  if (isWrite && normalizeString(req.body?.cityName) && !operationalCityAllowed(scope, req.body.cityName)) {
    res.status(403).send('No tienes permiso para gestionar clientes u operaciones en esta ciudad.');
    return false;
  }

  const isClientCreate = method === 'POST' && (path === CLIENTS_PATH || path === '/operaciones/admin-clientes');
  if (isClientCreate && scope.restricted && !normalizeString(req.body?.cityName)) {
    res.status(403).send('Debes seleccionar una ciudad dentro de tu alcance.');
    return false;
  }

  const clientId = clientIdFromPath(path);
  if (!clientId) return true;
  const client = await prisma.dispatchClient.findUnique({ where: { id: clientId }, select: { id: true, cityName: true } });
  if (client && !operationalCityAllowed(scope, client.cityName)) {
    res.status(403).send('No tienes permiso para gestionar este cliente.');
    return false;
  }

  const operationPointId = operationPointIdFromPath(path);
  if (!operationPointId) return true;
  const operationPoint = await prisma.dispatchOperationPoint.findFirst({
    where: { id: operationPointId, clientId },
    select: { cityName: true }
  });
  if (operationPoint && !operationalCityAllowed(scope, operationPoint.cityName || client?.cityName)) {
    res.status(403).send('No tienes permiso para gestionar este punto de operación.');
    return false;
  }
  return true;
}

async function enforceWorkerCityScope(prisma, req, res, scope) {
  const path = requestPath(req);
  if (!path.startsWith(PERSONNEL_PATH)
    && !path.startsWith('/operaciones/admin-worker')
    && !path.startsWith('/operaciones/admin-delete/personal')) return true;

  const requestedCityIds = normalizeStringList(req.body?.cityIds);
  if (scope.restricted && requestedCityIds.length) {
    const allowedIds = new Set(scope.allowedCityIds || []);
    if (requestedCityIds.some((id) => !allowedIds.has(id))) {
      res.status(403).send('No tienes permiso para gestionar auxiliares en una de las ciudades seleccionadas.');
      return false;
    }
  }

  const workerId = workerIdFromPath(path);
  if (!workerId) return true;
  const worker = await prisma.dispatchWorker.findUnique({
    where: { id: workerId },
    select: {
      id: true,
      residenceCity: true,
      cities: { select: { city: { select: { name: true } } } }
    }
  });
  if (worker && !workerInCityScope(worker, scope)) {
    res.status(403).send('No tienes permiso para gestionar este auxiliar.');
    return false;
  }
  return true;
}

async function enforceServiceRequestCityScope(prisma, req, res, scope) {
  const path = requestPath(req);
  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'POST' || !path.startsWith(SERVICE_REQUESTS_PATH)) return true;

  if (path === SERVICE_REQUESTS_PATH) {
    const clientId = normalizeString(req.body?.clientId);
    const operationPointId = normalizeString(req.body?.operationPointId);
    if (!clientId || !operationPointId) return true;
    const client = await prisma.dispatchClient.findFirst({
      where: { id: clientId, isActive: true },
      select: {
        cityName: true,
        operationPoints: { where: { id: operationPointId, isActive: true }, select: { id: true, cityName: true } }
      }
    });
    const operationPoint = client?.operationPoints?.[0] || null;
    if (!client || !operationPoint) return true;
    const cityName = operationPoint.cityName || client.cityName;
    if (!operationalCityAllowed(scope, cityName)) {
      res.status(403).send('No tienes permiso para crear solicitudes en esta ciudad.');
      return false;
    }
    return true;
  }

  const deleteMatch = path.match(/^\/admin\/operaciones\/solicitudes\/([^/]+)\/eliminar\/?$/);
  if (!deleteMatch) return true;
  const serviceRequest = await prisma.dispatchServiceRequest.findUnique({
    where: { id: decodeURIComponent(deleteMatch[1]) },
    select: { cityName: true }
  });
  if (serviceRequest && !operationalCityAllowed(scope, serviceRequest.cityName)) {
    res.status(403).send('No tienes permiso para gestionar solicitudes de esta ciudad.');
    return false;
  }
  return true;
}

function needsOperationalCityScope(path) {
  return path.startsWith(SERVICE_REQUESTS_PATH)
    || path.startsWith(CLIENTS_PATH)
    || path.startsWith(PERSONNEL_PATH)
    || path.startsWith('/operaciones/admin-clientes')
    || path.startsWith('/operaciones/admin-delete/clientes')
    || path.startsWith('/operaciones/admin-worker')
    || path.startsWith('/operaciones/admin-delete/personal')
    || path === OPERATIONS_CITY_API_PATH;
}

async function applyOperationalCityAccess(prisma, req, res) {
  const path = requestPath(req);
  if (!needsOperationalCityScope(path)) return true;
  const scope = await resolveUserCityScope(prisma, req);
  req.operationalCityScope = scope;

  if (String(req.method || 'GET').toUpperCase() === 'GET') {
    installOperationalCityRenderGate(res, scope);
    if (path === OPERATIONS_CITY_API_PATH) installOperationalCityJsonGate(res, scope);
  }

  if (!await enforceServiceRequestCityScope(prisma, req, res, scope)) return false;
  if (!await enforceClientCityScope(prisma, req, res, scope)) return false;
  return enforceWorkerCityScope(prisma, req, res, scope);
}

function isHtmlDocumentBody(body) {
  if (typeof body !== 'string') return false;
  const trimmed = body.trimStart().toLowerCase();
  return trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html') || trimmed.includes('<body');
}

function isHtmlResponse(body, res) {
  if (typeof body !== 'string') return false;
  const contentType = String(res.getHeader('Content-Type') || '').toLowerCase();
  return contentType.includes('text/html') || isHtmlDocumentBody(body);
}

function isAdminBrowserNavigation(req = {}) {
  const path = requestPath(req);
  const isPanelPath = path.startsWith('/admin')
    || path.startsWith('/operaciones/admin-')
    || path.startsWith('/account/');
  if (!isPanelPath) return false;
  const accept = String(req.headers?.accept || '').toLowerCase();
  return accept.includes('text/html');
}

function hasPanelSession(req = {}) {
  return Boolean(req.session?.userRole || req.userRole || req.role);
}

function isPlainAccessDenial(body, res) {
  const statusCode = Number(res.statusCode || 0);
  const contentType = String(res.getHeader?.('Content-Type') || '').toLowerCase();
  const structuredBody = Boolean(contentType)
    && !contentType.includes('text/plain')
    && !contentType.includes('text/html');
  return (statusCode === 401 || statusCode === 403)
    && typeof body === 'string'
    && !structuredBody
    && !isHtmlDocumentBody(body);
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderAdminAccessDenied(message) {
  const detail = escapeHtml(message) || 'Tu perfil no tiene permisos para esta sección.';
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Acceso no disponible</title>
  <link rel="icon" type="image/svg+xml" href="/public/favicon-loginpro.svg">
  <style>
    *,*::before,*::after{box-sizing:border-box}body{margin:0;min-height:100vh;background:#f1f5f9;color:#172033;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;flex-direction:column}.topbar{height:54px;background:#1e2d3d;display:flex;align-items:center;padding:0 24px;color:#fff;font-size:14px;font-weight:800;letter-spacing:.01em}.page{flex:1;display:grid;place-items:center;padding:32px 18px}.card{width:min(100%,540px);background:#fff;border:1px solid #e2e8f0;border-radius:18px;padding:36px 34px;text-align:center;box-shadow:0 18px 45px rgba(30,45,61,.10)}.icon{width:64px;height:64px;margin:0 auto 20px;border-radius:18px;background:#fff7ed;color:#b45309;display:grid;place-items:center}.icon svg{width:31px;height:31px}h1{margin:0;color:#1e2d3d;font-size:25px;line-height:1.2}.lead{margin:12px auto 0;max-width:420px;color:#475569;font-size:15px;line-height:1.55}.detail{margin:10px auto 0;max-width:430px;color:#64748b;font-size:13px;line-height:1.5}.actions{display:flex;justify-content:center;gap:10px;flex-wrap:wrap;margin-top:26px}.btn{min-height:42px;padding:10px 16px;border-radius:9px;text-decoration:none;font-size:13px;font-weight:800;display:inline-flex;align-items:center;justify-content:center}.btn.primary{background:#0d7a6b;color:#fff}.btn.secondary{background:#fff;color:#475569;border:1px solid #cbd5e1}.code{margin-top:22px;color:#94a3b8;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}@media(max-width:560px){.topbar{padding:0 16px}.page{padding:20px 12px}.card{padding:30px 20px;border-radius:14px}.actions{flex-direction:column}.btn{width:100%}}
  </style>
</head>
<body>
  <header class="topbar">Lórren · Panel administrativo</header>
  <main class="page">
    <section class="card" aria-labelledby="access-title">
      <div class="icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10" width="14" height="10" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path><path d="M12 14v2"></path></svg>
      </div>
      <h1 id="access-title">Acceso no disponible</h1>
      <p class="lead">No tienes acceso a esta sección o acción con tu perfil actual.</p>
      <p class="detail">${detail}</p>
      <div class="actions">
        <a class="btn primary" href="/admin">Volver al panel</a>
        <a class="btn secondary" href="/logout">Cerrar sesión</a>
      </div>
      <div class="code">Acceso restringido</div>
    </section>
  </main>
</body>
</html>`;
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
  if (!usersPageAllowed || html.includes(PAYROLL_USERS_SCRIPT)) return html;
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
  if (!res || typeof res.send !== 'function' || res.__adminHtmlBridgeInstalled) return;
  res.__adminHtmlBridgeInstalled = true;
  const originalSend = res.send.bind(res);
  res.send = (body) => {
    if (isAdminBrowserNavigation(req) && isPlainAccessDenial(body, res)) {
      if (!hasPanelSession(req)) return res.redirect('/login');
      res.set('Cache-Control', 'no-store');
      res.type('html');
      return originalSend(renderAdminAccessDenied(body));
    }
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

export function adminHtmlBridgeMiddleware(req, res, next) {
  installAdminHtmlBridge(req, res);
  return next();
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
    installAdminHtmlBridge(req, res);
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
    try {
      if (!await applyOperationalCityAccess(prisma, req, res)) return;
    } catch (error) {
      console.warn('No fue posible aplicar el alcance territorial operativo.', error);
      return res.status(500).send('No fue posible validar el alcance territorial operativo.');
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
