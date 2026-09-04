export const OPERATIONAL_ACCESS_ENTITY_TYPE = 'APP_USER_OPERATIONAL_ACCESS';
export const OPERATIONAL_ACCESS_ACTION = 'OPERATIONAL_ACCESS_SET';

export const OPERATIONAL_ROLE = Object.freeze({
  CONSULTA: 'CONSULTA',
  COORDINADOR: 'COORDINADOR',
  SUPERVISOR: 'SUPERVISOR'
});

export const OPERATIONAL_MODULE_ACCESS = Object.freeze({
  DISPATCH: 'dispatch',
  ATTENDANCE: 'attendance',
  TIME: 'time'
});

export const OPERATIONAL_CAPABILITY = Object.freeze({
  DISPATCH_VIEW: 'DISPATCH_VIEW',
  DISPATCH_REQUEST_MANAGE: 'DISPATCH_REQUEST_MANAGE',
  DISPATCH_ASSIGNMENT_MANAGE: 'DISPATCH_ASSIGNMENT_MANAGE',
  DISPATCH_INCIDENT_MANAGE: 'DISPATCH_INCIDENT_MANAGE',
  DISPATCH_REST_MANAGE: 'DISPATCH_REST_MANAGE',
  DISPATCH_WHATSAPP_SEND: 'DISPATCH_WHATSAPP_SEND',
  DISPATCH_PERSONNEL_MANAGE: 'DISPATCH_PERSONNEL_MANAGE',
  DISPATCH_PERSONNEL_STATUS: 'DISPATCH_PERSONNEL_STATUS',
  DISPATCH_PERSONNEL_DELETE: 'DISPATCH_PERSONNEL_DELETE',
  DISPATCH_MASTERDATA_MANAGE: 'DISPATCH_MASTERDATA_MANAGE',
  DISPATCH_MASTERDATA_DELETE: 'DISPATCH_MASTERDATA_DELETE',
  ATTENDANCE_VIEW: 'ATTENDANCE_VIEW',
  ATTENDANCE_MANAGE: 'ATTENDANCE_MANAGE',
  ATTENDANCE_CORRECT: 'ATTENDANCE_CORRECT',
  ATTENDANCE_CONFIG: 'ATTENDANCE_CONFIG',
  TIME_VIEW: 'TIME_VIEW',
  TIME_EXPORT: 'TIME_EXPORT',
  TIME_COMPENSATION: 'TIME_COMPENSATION',
  TIME_IMPORT: 'TIME_IMPORT',
  TIME_IMPORT_REVERSE: 'TIME_IMPORT_REVERSE',
  SUPERVISE_PERMISSIONS: 'SUPERVISE_PERMISSIONS'
});

export const OPERATIONAL_CAPABILITY_DEFINITIONS = Object.freeze([
  { key: OPERATIONAL_CAPABILITY.DISPATCH_VIEW, module: 'Despacho', moduleAccessKey: OPERATIONAL_MODULE_ACCESS.DISPATCH, moduleAccess: true, moduleLabel: 'Operaciones / Despacho', label: 'Ver Operaciones / Despacho' },
  { key: OPERATIONAL_CAPABILITY.DISPATCH_REQUEST_MANAGE, module: 'Despacho', moduleAccessKey: OPERATIONAL_MODULE_ACCESS.DISPATCH, label: 'Crear y gestionar solicitudes' },
  { key: OPERATIONAL_CAPABILITY.DISPATCH_ASSIGNMENT_MANAGE, module: 'Despacho', moduleAccessKey: OPERATIONAL_MODULE_ACCESS.DISPATCH, label: 'Asignar, reemplazar y confirmar personal' },
  { key: OPERATIONAL_CAPABILITY.DISPATCH_INCIDENT_MANAGE, module: 'Despacho', moduleAccessKey: OPERATIONAL_MODULE_ACCESS.DISPATCH, label: 'Gestionar novedades operativas' },
  { key: OPERATIONAL_CAPABILITY.DISPATCH_REST_MANAGE, module: 'Despacho', moduleAccessKey: OPERATIONAL_MODULE_ACCESS.DISPATCH, label: 'Gestionar descansos' },
  { key: OPERATIONAL_CAPABILITY.DISPATCH_WHATSAPP_SEND, module: 'Despacho', moduleAccessKey: OPERATIONAL_MODULE_ACCESS.DISPATCH, label: 'Enviar comunicaciones operativas' },
  { key: OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_MANAGE, module: 'Despacho', moduleAccessKey: OPERATIONAL_MODULE_ACCESS.DISPATCH, label: 'Crear, editar e importar personal' },
  { key: OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_STATUS, module: 'Despacho', moduleAccessKey: OPERATIONAL_MODULE_ACCESS.DISPATCH, label: 'Activar o desactivar personal' },
  { key: OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_DELETE, module: 'Despacho', moduleAccessKey: OPERATIONAL_MODULE_ACCESS.DISPATCH, label: 'Eliminar personal permanentemente', sensitive: true },
  { key: OPERATIONAL_CAPABILITY.DISPATCH_MASTERDATA_MANAGE, module: 'Despacho', moduleAccessKey: OPERATIONAL_MODULE_ACCESS.DISPATCH, label: 'Administrar clientes, puntos y servicios' },
  { key: OPERATIONAL_CAPABILITY.DISPATCH_MASTERDATA_DELETE, module: 'Despacho', moduleAccessKey: OPERATIONAL_MODULE_ACCESS.DISPATCH, label: 'Eliminar clientes, puntos o servicios', sensitive: true },
  { key: OPERATIONAL_CAPABILITY.ATTENDANCE_VIEW, module: 'Asistencia', moduleAccessKey: OPERATIONAL_MODULE_ACCESS.ATTENDANCE, moduleAccess: true, moduleLabel: 'Asistencia', label: 'Ver asistencia y evidencia' },
  { key: OPERATIONAL_CAPABILITY.ATTENDANCE_MANAGE, module: 'Asistencia', moduleAccessKey: OPERATIONAL_MODULE_ACCESS.ATTENDANCE, label: 'Validar asistencia y resolver incidencias' },
  { key: OPERATIONAL_CAPABILITY.ATTENDANCE_CORRECT, module: 'Asistencia', moduleAccessKey: OPERATIONAL_MODULE_ACCESS.ATTENDANCE, label: 'Corregir o registrar marcaciones manuales', sensitive: true },
  { key: OPERATIONAL_CAPABILITY.ATTENDANCE_CONFIG, module: 'Asistencia', moduleAccessKey: OPERATIONAL_MODULE_ACCESS.ATTENDANCE, label: 'Configurar asistencia y cuadrillas' },
  { key: OPERATIONAL_CAPABILITY.TIME_VIEW, module: 'Gestión de Tiempo', moduleAccessKey: OPERATIONAL_MODULE_ACCESS.TIME, moduleAccess: true, moduleLabel: 'Asistencia y Gestión de Tiempo', label: 'Ver Gestión de Tiempo' },
  { key: OPERATIONAL_CAPABILITY.TIME_EXPORT, module: 'Gestión de Tiempo', moduleAccessKey: OPERATIONAL_MODULE_ACCESS.TIME, label: 'Exportar reportes de tiempo' },
  { key: OPERATIONAL_CAPABILITY.TIME_COMPENSATION, module: 'Gestión de Tiempo', moduleAccessKey: OPERATIONAL_MODULE_ACCESS.TIME, label: 'Gestionar compensatorios' },
  { key: OPERATIONAL_CAPABILITY.TIME_IMPORT, module: 'Gestión de Tiempo', moduleAccessKey: OPERATIONAL_MODULE_ACCESS.TIME, label: 'Importar y aplicar datos de asistencia' },
  { key: OPERATIONAL_CAPABILITY.TIME_IMPORT_REVERSE, module: 'Gestión de Tiempo', moduleAccessKey: OPERATIONAL_MODULE_ACCESS.TIME, label: 'Reversar importaciones', sensitive: true },
  { key: OPERATIONAL_CAPABILITY.SUPERVISE_PERMISSIONS, module: 'Supervisión', label: 'Administrar permisos delegables de otros usuarios', supervisorOnly: true }
]);

const CAPABILITY_KEYS = Object.freeze(OPERATIONAL_CAPABILITY_DEFINITIONS.map((item) => item.key));
const CAPABILITY_SET = new Set(CAPABILITY_KEYS);
const ROLE_SET = new Set(Object.values(OPERATIONAL_ROLE));
const MODULE_ACCESS_KEYS = Object.freeze(Object.values(OPERATIONAL_MODULE_ACCESS));
const MODULE_VIEW_CAPABILITY_SET = new Set(
  OPERATIONAL_CAPABILITY_DEFINITIONS.filter((item) => item.moduleAccess === true).map((item) => item.key)
);
const MODULE_VIEW_CAPABILITY_BY_ACCESS = Object.freeze(Object.fromEntries(
  OPERATIONAL_CAPABILITY_DEFINITIONS
    .filter((item) => item.moduleAccess === true && item.moduleAccessKey)
    .map((item) => [item.moduleAccessKey, item.key])
));

const ROLE_BASE_PERMISSIONS = Object.freeze({
  [OPERATIONAL_ROLE.CONSULTA]: Object.freeze([
    OPERATIONAL_CAPABILITY.DISPATCH_VIEW,
    OPERATIONAL_CAPABILITY.ATTENDANCE_VIEW,
    OPERATIONAL_CAPABILITY.TIME_VIEW
  ]),
  [OPERATIONAL_ROLE.COORDINADOR]: Object.freeze([
    OPERATIONAL_CAPABILITY.DISPATCH_VIEW,
    OPERATIONAL_CAPABILITY.DISPATCH_REQUEST_MANAGE,
    OPERATIONAL_CAPABILITY.DISPATCH_ASSIGNMENT_MANAGE,
    OPERATIONAL_CAPABILITY.DISPATCH_INCIDENT_MANAGE,
    OPERATIONAL_CAPABILITY.DISPATCH_REST_MANAGE,
    OPERATIONAL_CAPABILITY.DISPATCH_WHATSAPP_SEND,
    OPERATIONAL_CAPABILITY.ATTENDANCE_VIEW,
    OPERATIONAL_CAPABILITY.TIME_VIEW
  ]),
  [OPERATIONAL_ROLE.SUPERVISOR]: Object.freeze([
    OPERATIONAL_CAPABILITY.DISPATCH_VIEW,
    OPERATIONAL_CAPABILITY.DISPATCH_REQUEST_MANAGE,
    OPERATIONAL_CAPABILITY.DISPATCH_ASSIGNMENT_MANAGE,
    OPERATIONAL_CAPABILITY.DISPATCH_INCIDENT_MANAGE,
    OPERATIONAL_CAPABILITY.DISPATCH_REST_MANAGE,
    OPERATIONAL_CAPABILITY.DISPATCH_WHATSAPP_SEND,
    OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_MANAGE,
    OPERATIONAL_CAPABILITY.DISPATCH_PERSONNEL_STATUS,
    OPERATIONAL_CAPABILITY.DISPATCH_MASTERDATA_MANAGE,
    OPERATIONAL_CAPABILITY.ATTENDANCE_VIEW,
    OPERATIONAL_CAPABILITY.ATTENDANCE_MANAGE,
    OPERATIONAL_CAPABILITY.ATTENDANCE_CONFIG,
    OPERATIONAL_CAPABILITY.TIME_VIEW,
    OPERATIONAL_CAPABILITY.TIME_EXPORT,
    OPERATIONAL_CAPABILITY.TIME_COMPENSATION,
    OPERATIONAL_CAPABILITY.SUPERVISE_PERMISSIONS
  ])
});

function normalizeString(value, maxLength = 200) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

function sourceValue(source = {}, key) {
  return source?.[key] ?? source?.session?.[key] ?? null;
}

export function normalizeOperationalRole(value) {
  const normalized = normalizeString(value, 40)?.toUpperCase();
  return normalized && ROLE_SET.has(normalized) ? normalized : null;
}

function normalizeCapabilities(values = []) {
  const list = Array.isArray(values) ? values : [values];
  return [...new Set(list.map((value) => normalizeString(value, 80)?.toUpperCase()).filter((value) => value && CAPABILITY_SET.has(value)))];
}

function normalizeDelegableCapabilities(values = []) {
  return normalizeCapabilities(values).filter((capability) => (
    capability !== OPERATIONAL_CAPABILITY.SUPERVISE_PERMISSIONS
    && !MODULE_VIEW_CAPABILITY_SET.has(capability)
  ));
}

export function normalizeOperationalModuleAccess(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!MODULE_ACCESS_KEYS.every((key) => typeof value[key] === 'boolean')) return null;
  const attendance = value[OPERATIONAL_MODULE_ACCESS.ATTENDANCE] === true;
  return {
    [OPERATIONAL_MODULE_ACCESS.DISPATCH]: value[OPERATIONAL_MODULE_ACCESS.DISPATCH] === true || attendance,
    [OPERATIONAL_MODULE_ACCESS.ATTENDANCE]: attendance,
    [OPERATIONAL_MODULE_ACCESS.TIME]: value[OPERATIONAL_MODULE_ACCESS.TIME] === true
  };
}

export function operationalRoleBasePermissions(role) {
  const normalized = normalizeOperationalRole(role);
  return normalized ? [...ROLE_BASE_PERMISSIONS[normalized]] : [];
}

function capabilityStateMap(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map();
  const states = new Map();
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizeString(rawKey, 80)?.toUpperCase();
    if (!key || !CAPABILITY_SET.has(key)) continue;
    if (rawValue === true || rawValue === false || rawValue === null || rawValue === 'inherit') states.set(key, rawValue);
  }
  return states;
}

function permissionStatesWithModuleAccess(permissionStates = {}, moduleAccess = null) {
  const normalizedModuleAccess = normalizeOperationalModuleAccess(moduleAccess);
  if (!normalizedModuleAccess) return permissionStates;
  const states = Object.fromEntries(capabilityStateMap(permissionStates));
  for (const definition of OPERATIONAL_CAPABILITY_DEFINITIONS) {
    if (definition.moduleAccess !== true || !definition.moduleAccessKey) continue;
    states[definition.key] = normalizedModuleAccess[definition.moduleAccessKey] === true;
  }
  return states;
}

function permissionsFromConfig(config = {}) {
  const role = normalizeOperationalRole(config.role);
  if (!role) return [];
  const permissions = new Set(operationalRoleBasePermissions(role));
  normalizeCapabilities(config.grants).forEach((capability) => permissions.add(capability));
  normalizeCapabilities(config.denials).forEach((capability) => permissions.delete(capability));
  if (role !== OPERATIONAL_ROLE.SUPERVISOR) permissions.delete(OPERATIONAL_CAPABILITY.SUPERVISE_PERMISSIONS);
  return CAPABILITY_KEYS.filter((capability) => permissions.has(capability));
}

function moduleAccessFromConfig(config = {}) {
  const effective = new Set(permissionsFromConfig(config));
  return normalizeOperationalModuleAccess({
    [OPERATIONAL_MODULE_ACCESS.DISPATCH]: effective.has(OPERATIONAL_CAPABILITY.DISPATCH_VIEW),
    [OPERATIONAL_MODULE_ACCESS.ATTENDANCE]: effective.has(OPERATIONAL_CAPABILITY.ATTENDANCE_VIEW),
    [OPERATIONAL_MODULE_ACCESS.TIME]: effective.has(OPERATIONAL_CAPABILITY.TIME_VIEW)
  });
}

function normalizedConfig(value = {}) {
  const role = normalizeOperationalRole(value?.role);
  if (!role) return null;
  const denials = normalizeCapabilities(value?.denials);
  const denied = new Set(denials);
  const grants = normalizeCapabilities(value?.grants)
    .filter((capability) => !denied.has(capability))
    .filter((capability) => role === OPERATIONAL_ROLE.SUPERVISOR || capability !== OPERATIONAL_CAPABILITY.SUPERVISE_PERMISSIONS);
  const delegablePermissions = role === OPERATIONAL_ROLE.SUPERVISOR
    ? normalizeDelegableCapabilities(value?.delegablePermissions)
    : [];
  return { role, grants, denials, delegablePermissions };
}

function configFromPermissionStates(role, permissionStates, previous = null, editableCapabilities = CAPABILITY_KEYS) {
  const normalizedRole = normalizeOperationalRole(role);
  if (!normalizedRole) throw new Error('operational_role_invalid');
  const base = new Set(operationalRoleBasePermissions(normalizedRole));
  const editable = new Set(normalizeCapabilities(editableCapabilities));
  const states = capabilityStateMap(permissionStates);
  const grants = new Set(normalizeCapabilities(previous?.grants));
  const denials = new Set(normalizeCapabilities(previous?.denials));

  for (const capability of editable) {
    if (!states.has(capability)) continue;
    grants.delete(capability);
    denials.delete(capability);
    const state = states.get(capability);
    if (state === null || state === 'inherit') continue;
    if (state === true && !base.has(capability)) grants.add(capability);
    if (state === false && base.has(capability)) denials.add(capability);
  }

  if (normalizedRole !== OPERATIONAL_ROLE.SUPERVISOR) {
    grants.delete(OPERATIONAL_CAPABILITY.SUPERVISE_PERMISSIONS);
    denials.delete(OPERATIONAL_CAPABILITY.SUPERVISE_PERMISSIONS);
  }

  return {
    role: normalizedRole,
    grants: CAPABILITY_KEYS.filter((capability) => grants.has(capability) && !denials.has(capability)),
    denials: CAPABILITY_KEYS.filter((capability) => denials.has(capability)),
    delegablePermissions: normalizedRole === OPERATIONAL_ROLE.SUPERVISOR
      ? normalizeDelegableCapabilities(previous?.delegablePermissions)
      : []
  };
}

function requirePrisma(prisma) {
  if (!prisma?.appUser?.findUnique || !prisma?.devAuditEvent?.findFirst || !prisma?.devAuditEvent?.create) {
    throw new Error('operational_access_prisma_contract_invalid');
  }
  return prisma;
}

async function latestConfigEvent(prisma, userId) {
  return prisma.devAuditEvent.findFirst({
    where: {
      entityType: OPERATIONAL_ACCESS_ENTITY_TYPE,
      entityId: userId,
      action: OPERATIONAL_ACCESS_ACTION
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
  });
}

async function loadUser(prisma, source = {}) {
  const userId = normalizeString(source.userId || source.id, 120);
  const username = normalizeString(source.username, 160);
  if (!userId && !username) return null;
  return prisma.appUser.findUnique({
    where: userId ? { id: userId } : { username },
    select: { id: true, username: true, displayName: true, role: true, isActive: true }
  });
}

export function operationalAccessCatalog() {
  return {
    roles: [
      { key: OPERATIONAL_ROLE.CONSULTA, label: 'Consulta', basePermissions: operationalRoleBasePermissions(OPERATIONAL_ROLE.CONSULTA) },
      { key: OPERATIONAL_ROLE.COORDINADOR, label: 'Coordinador', basePermissions: operationalRoleBasePermissions(OPERATIONAL_ROLE.COORDINADOR) },
      { key: OPERATIONAL_ROLE.SUPERVISOR, label: 'Supervisor', basePermissions: operationalRoleBasePermissions(OPERATIONAL_ROLE.SUPERVISOR) }
    ],
    capabilities: OPERATIONAL_CAPABILITY_DEFINITIONS.map((item) => ({ ...item }))
  };
}

export async function getOperationalAccessForUser(prisma, userId) {
  requirePrisma(prisma);
  const user = await loadUser(prisma, { userId });
  if (!user || String(user.role || '').toUpperCase() !== 'ADMIN') return null;
  const event = await latestConfigEvent(prisma, user.id);
  const config = normalizedConfig(event?.toValue);
  if (!config) {
    return {
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      isActive: user.isActive,
      configured: false,
      role: null,
      grants: [],
      denials: [],
      delegablePermissions: [],
      effectivePermissions: []
    };
  }
  return {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    isActive: user.isActive,
    configured: true,
    ...config,
    effectivePermissions: permissionsFromConfig(config),
    changedAt: event?.createdAt || null
  };
}

export async function resolveOperationalAccess(prisma, source = {}) {
  const appRole = normalizeString(sourceValue(source, 'userRole') || sourceValue(source, 'role'), 40)?.toLowerCase();
  if (appRole === 'dev') {
    return {
      configured: true,
      role: 'DEV',
      effectivePermissions: [...CAPABILITY_KEYS],
      delegablePermissions: normalizeDelegableCapabilities(CAPABILITY_KEYS),
      grants: [],
      denials: [],
      userId: sourceValue(source, 'userId') || null,
      username: sourceValue(source, 'username') || null
    };
  }
  if (appRole !== 'admin') return { configured: false, role: null, effectivePermissions: [], delegablePermissions: [], grants: [], denials: [] };
  requirePrisma(prisma);
  const user = await loadUser(prisma, {
    userId: sourceValue(source, 'userId'),
    username: sourceValue(source, 'username')
  });
  if (!user || !user.isActive || String(user.role || '').toUpperCase() !== 'ADMIN') {
    return { configured: false, role: null, effectivePermissions: [], delegablePermissions: [], grants: [], denials: [], userId: user?.id || null };
  }
  const access = await getOperationalAccessForUser(prisma, user.id);
  return access || { configured: false, role: null, effectivePermissions: [], delegablePermissions: [], grants: [], denials: [], userId: user.id };
}

export function hasOperationalCapability(source = {}, capability) {
  const role = normalizeString(sourceValue(source, 'userRole') || sourceValue(source, 'role'), 40)?.toLowerCase();
  if (role === 'dev') return true;
  const normalizedCapability = normalizeString(capability, 80)?.toUpperCase();
  if (!normalizedCapability || !CAPABILITY_SET.has(normalizedCapability)) return false;
  const configured = sourceValue(source, 'operationalAccessConfigured') ?? sourceValue(source, 'configured');
  if (configured !== true) return true;
  const permissions = sourceValue(source, 'operationalEffectivePermissions') || sourceValue(source, 'effectivePermissions') || [];
  return normalizeCapabilities(permissions).includes(normalizedCapability);
}

export function canManageOperationalPermissions(source = {}) {
  const appRole = normalizeString(sourceValue(source, 'userRole') || sourceValue(source, 'role'), 40)?.toLowerCase();
  if (appRole === 'dev') return true;
  const operationalRole = normalizeOperationalRole(sourceValue(source, 'operationalRole'));
  return operationalRole === OPERATIONAL_ROLE.SUPERVISOR
    && hasOperationalCapability(source, OPERATIONAL_CAPABILITY.SUPERVISE_PERMISSIONS);
}

export async function listOperationalAccess(prisma, users = []) {
  const entries = [];
  for (const user of Array.isArray(users) ? users : []) {
    const access = await getOperationalAccessForUser(prisma, user?.id);
    if (access) entries.push(access);
  }
  return entries;
}

function actorContext(input = {}) {
  return {
    userRole: normalizeString(input.actorRole, 40)?.toLowerCase() || null,
    userId: normalizeString(input.actorUserId, 120),
    username: normalizeString(input.actorUsername, 160),
    operationalRole: normalizeOperationalRole(input.actorOperationalRole),
    operationalAccessConfigured: input.actorOperationalAccessConfigured === true,
    operationalEffectivePermissions: normalizeCapabilities(input.actorEffectivePermissions),
    operationalDelegablePermissions: normalizeDelegableCapabilities(input.actorDelegablePermissions)
  };
}

function permissionStatesForEffective(role, effectivePermissions = []) {
  const effective = new Set(normalizeCapabilities(effectivePermissions));
  const states = {};
  for (const capability of CAPABILITY_KEYS) states[capability] = effective.has(capability);
  return configFromPermissionStates(role, states);
}

export async function setOperationalAccess(prisma, input = {}, options = {}) {
  requirePrisma(prisma);
  const actor = actorContext(input);
  const actorIsDev = actor.userRole === 'dev';
  const actorIsSupervisor = canManageOperationalPermissions(actor);
  if (!actorIsDev && !actorIsSupervisor) throw new Error('operational_access_manager_required');

  const hasModuleAccessInput = Object.prototype.hasOwnProperty.call(input, 'moduleAccess');
  const moduleAccess = hasModuleAccessInput ? normalizeOperationalModuleAccess(input.moduleAccess) : null;
  if (hasModuleAccessInput && !moduleAccess) throw new Error('operational_module_access_invalid');

  const targetUserId = normalizeString(input.targetUserId, 120);
  if (!targetUserId) throw new Error('operational_access_target_required');
  const target = await loadUser(prisma, { userId: targetUserId });
  if (!target || String(target.role || '').toUpperCase() !== 'ADMIN') throw new Error('operational_access_user_not_found');

  const previousEvent = await latestConfigEvent(prisma, target.id);
  const previous = normalizedConfig(previousEvent?.toValue);
  let next;

  if (actorIsDev) {
    const role = normalizeOperationalRole(input.role);
    if (!role) throw new Error('operational_role_invalid');
    const permissionStates = moduleAccess
      ? permissionStatesWithModuleAccess(input.permissions || {}, moduleAccess)
      : input.permissions || {};
    next = configFromPermissionStates(role, permissionStates, null, CAPABILITY_KEYS);
    next.delegablePermissions = role === OPERATIONAL_ROLE.SUPERVISOR
      ? normalizeDelegableCapabilities(input.delegablePermissions)
      : [];
  } else {
    if (actor.userId && actor.userId === target.id) throw new Error('operational_access_self_forbidden');
    if (!previous) throw new Error('operational_role_dev_required');
    if (previous.role === OPERATIONAL_ROLE.SUPERVISOR) throw new Error('operational_access_supervisor_target_forbidden');
    if (Object.prototype.hasOwnProperty.call(input, 'role')) throw new Error('operational_role_dev_required');
    if (Object.prototype.hasOwnProperty.call(input, 'delegablePermissions')) throw new Error('operational_delegation_dev_required');

    const editable = new Set(actor.operationalDelegablePermissions);
    const requestedStates = capabilityStateMap(input.permissions || {});
    for (const capability of requestedStates.keys()) {
      if (MODULE_VIEW_CAPABILITY_SET.has(capability)) throw new Error('operational_access_capability_not_delegable');
      if (!editable.has(capability)) throw new Error('operational_access_capability_not_delegable');
    }

    const editableForUpdate = new Set(editable);
    let permissionStates = input.permissions || {};
    if (moduleAccess) {
      const previousModules = moduleAccessFromConfig(previous);
      const actorPermissions = new Set(actor.operationalEffectivePermissions);
      for (const moduleKey of MODULE_ACCESS_KEYS) {
        if (previousModules?.[moduleKey] === moduleAccess[moduleKey]) continue;
        const rootCapability = MODULE_VIEW_CAPABILITY_BY_ACCESS[moduleKey];
        if (!rootCapability || !actorPermissions.has(rootCapability)) {
          throw new Error('operational_module_access_not_delegable');
        }
        editableForUpdate.add(rootCapability);
      }
      permissionStates = permissionStatesWithModuleAccess(permissionStates, moduleAccess);
    }

    next = configFromPermissionStates(previous.role, permissionStates, previous, [...editableForUpdate]);
    next.delegablePermissions = previous.delegablePermissions;
  }

  const now = options.now || new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('operational_access_now_invalid');
  const previousSnapshot = previous || { role: null, grants: [], denials: [], delegablePermissions: [] };
  await prisma.devAuditEvent.create({
    data: {
      entityType: OPERATIONAL_ACCESS_ENTITY_TYPE,
      entityId: target.id,
      entityLabel: target.username,
      action: OPERATIONAL_ACCESS_ACTION,
      actorUserId: actor.userId,
      actorUsername: actor.username,
      actorRole: actor.userRole,
      actorSource: actorIsDev ? 'users-admin-dev' : 'users-supervisor',
      ipAddress: normalizeString(input.ipAddress, 120),
      userAgent: normalizeString(input.userAgent, 500),
      fromValue: previousSnapshot,
      toValue: next,
      metadata: {
        authority: 'operationalAccess',
        roleAssignedByDev: actorIsDev,
        delegatedBySupervisor: actorIsSupervisor && !actorIsDev,
        moduleAccessSynchronized: Boolean(moduleAccess),
        modulesDelegatedBySupervisor: Boolean(moduleAccess) && actorIsSupervisor && !actorIsDev
      },
      createdAt: now
    }
  });

  return {
    userId: target.id,
    username: target.username,
    displayName: target.displayName,
    configured: true,
    ...next,
    effectivePermissions: permissionsFromConfig(next),
    ...(moduleAccess ? { moduleAccess } : {})
  };
}

export function buildOperationalPermissionStates(role, effectivePermissions = []) {
  const normalizedRole = normalizeOperationalRole(role);
  if (!normalizedRole) return {};
  const normalized = permissionStatesForEffective(normalizedRole, effectivePermissions);
  const effective = new Set(permissionsFromConfig(normalized));
  return Object.fromEntries(CAPABILITY_KEYS.map((capability) => [capability, effective.has(capability)]));
}
