import { ACTIVE_DISPATCH_ASSIGNMENT_STATUSES } from '../../../services/dispatchOperationalCoverage.js';

export const CREW_ATTENDANCE_OPERATION_ENTITY_TYPE = 'DISPATCH_CREW_ATTENDANCE_OPERATION';
export const CREW_ATTENDANCE_SERVICE_ENTITY_TYPE = 'DISPATCH_CREW_ATTENDANCE_SERVICE';
export const CREW_ATTENDANCE_CONFIG_ACTION = 'CREW_ATTENDANCE_CONFIG_UPDATED';
export const CREW_ATTENDANCE_MODE = Object.freeze({
  INDIVIDUAL: 'INDIVIDUAL',
  CREW: 'CREW'
});

const CREW_ATTENDANCE_MODES = new Set(Object.values(CREW_ATTENDANCE_MODE));
const BOGOTA_TIME_ZONE = 'America/Bogota';

function normalizeString(value, maxLength = 200) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function requireString(value, label) {
  const normalized = normalizeString(value, 160);
  if (!normalized) throw new Error(`${label}_required`);
  return normalized;
}

function explicitBoolean(value, label) {
  if (value === true || value === false) return value;
  const normalized = normalizeString(value, 12)?.toLowerCase();
  if (['true', '1', 'on'].includes(normalized)) return true;
  if (['false', '0', 'off'].includes(normalized)) return false;
  throw new Error(`${label}_invalid`);
}

function normalizeMode(value) {
  const mode = normalizeString(value, 24)?.toUpperCase();
  if (!mode || !CREW_ATTENDANCE_MODES.has(mode)) throw new Error('crew_attendance_mode_invalid');
  return mode;
}

function todayInBogota(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BOGOTA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function normalizeDateKey(value, fallback) {
  const normalized = normalizeString(value, 10);
  if (!normalized || !/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return fallback;
  const date = new Date(`${normalized}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized
    ? fallback
    : normalized;
}

export function resolveCrewAttendanceRange(input = {}, now = new Date()) {
  const today = todayInBogota(now);
  const from = normalizeDateKey(input.from, today);
  const to = normalizeDateKey(input.to, from);
  const orderedFrom = from <= to ? from : to;
  const orderedTo = from <= to ? to : from;
  return {
    from: orderedFrom,
    to: orderedTo,
    gte: new Date(`${orderedFrom}T00:00:00.000Z`),
    lte: new Date(`${orderedTo}T23:59:59.999Z`)
  };
}

function requireReadContract(prisma) {
  if (!prisma?.dispatchOperationPoint || typeof prisma.dispatchOperationPoint.findMany !== 'function') {
    throw new Error('crew_attendance_operation_prisma_contract_invalid');
  }
  if (!prisma?.dispatchServiceRequest || typeof prisma.dispatchServiceRequest.findMany !== 'function') {
    throw new Error('crew_attendance_service_prisma_contract_invalid');
  }
  if (!prisma?.devAuditEvent || typeof prisma.devAuditEvent.findMany !== 'function') {
    throw new Error('crew_attendance_audit_prisma_contract_invalid');
  }
  return prisma;
}

function requireWriteContract(prisma) {
  requireReadContract(prisma);
  if (typeof prisma.dispatchOperationPoint.findFirst !== 'function') {
    throw new Error('crew_attendance_operation_prisma_contract_invalid');
  }
  if (typeof prisma.dispatchServiceRequest.findUnique !== 'function') {
    throw new Error('crew_attendance_service_prisma_contract_invalid');
  }
  if (typeof prisma.devAuditEvent.findFirst !== 'function' || typeof prisma.devAuditEvent.create !== 'function') {
    throw new Error('crew_attendance_audit_prisma_contract_invalid');
  }
  return prisma;
}

function eventMetadata(event) {
  return event?.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
    ? event.metadata
    : {};
}

function latestMetadataByEntity(events = []) {
  const map = new Map();
  for (const event of events) {
    if (!event?.entityId || map.has(event.entityId)) continue;
    map.set(event.entityId, eventMetadata(event));
  }
  return map;
}

function operationAllowedFromMetadata(metadata) {
  return metadata?.allowed === true;
}

function serviceConfigFromMetadata(metadata) {
  const mode = CREW_ATTENDANCE_MODES.has(String(metadata?.mode || '').toUpperCase())
    ? String(metadata.mode).toUpperCase()
    : CREW_ATTENDANCE_MODE.INDIVIDUAL;
  return {
    mode,
    crewLeaderWorkerId: mode === CREW_ATTENDANCE_MODE.CREW
      ? normalizeString(metadata?.crewLeaderWorkerId, 160)
      : null
  };
}

async function latestConfigEvent(prisma, entityType, entityId) {
  return prisma.devAuditEvent.findFirst({
    where: {
      entityType,
      entityId,
      action: CREW_ATTENDANCE_CONFIG_ACTION
    },
    orderBy: { createdAt: 'desc' }
  });
}

function auditActor(input = {}) {
  return {
    actorUsername: normalizeString(input.actorUsername, 160),
    actorRole: normalizeString(input.actorRole, 80),
    actorSource: 'attendance-admin-crew',
    ipAddress: normalizeString(input.ipAddress, 120),
    userAgent: normalizeString(input.userAgent, 500)
  };
}

function serviceDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function serviceLabel(service) {
  const dateKey = serviceDateKey(service?.serviceDate) || 'sin-fecha';
  const time = normalizeString(service?.startTime, 16) || 'sin-hora';
  return `${dateKey} · ${time}`;
}

export async function loadCrewAttendanceConfiguration(prisma, input = {}, options = {}) {
  requireReadContract(prisma);
  const range = resolveCrewAttendanceRange(input, options.now || new Date());

  const [operations, services] = await Promise.all([
    prisma.dispatchOperationPoint.findMany({
      where: { isActive: true },
      select: {
        id: true,
        clientId: true,
        name: true,
        cityName: true,
        isActive: true,
        attendanceEnabled: true,
        client: { select: { id: true, name: true } }
      },
      orderBy: { name: 'asc' }
    }),
    prisma.dispatchServiceRequest.findMany({
      where: {
        serviceDate: { gte: range.gte, lte: range.lte },
        operationPointId: { not: null },
        status: { not: 'CANCELLED' }
      },
      select: {
        id: true,
        operationPointId: true,
        clientName: true,
        operationPointName: true,
        serviceDate: true,
        startTime: true,
        endTime: true,
        status: true,
        requiredWorkers: true,
        operationPoint: {
          select: { id: true, isActive: true, attendanceEnabled: true }
        },
        assignments: {
          where: { status: { in: ACTIVE_DISPATCH_ASSIGNMENT_STATUSES } },
          select: {
            workerId: true,
            status: true,
            worker: { select: { id: true, fullName: true } }
          },
          orderBy: { createdAt: 'asc' }
        }
      },
      orderBy: [{ serviceDate: 'asc' }, { startTime: 'asc' }, { createdAt: 'asc' }]
    })
  ]);

  const operationIds = operations.map((operation) => operation.id);
  const serviceIds = services.map((service) => service.id);
  const [operationEvents, serviceEvents] = await Promise.all([
    operationIds.length
      ? prisma.devAuditEvent.findMany({
          where: {
            entityType: CREW_ATTENDANCE_OPERATION_ENTITY_TYPE,
            entityId: { in: operationIds },
            action: CREW_ATTENDANCE_CONFIG_ACTION
          },
          orderBy: { createdAt: 'desc' }
        })
      : [],
    serviceIds.length
      ? prisma.devAuditEvent.findMany({
          where: {
            entityType: CREW_ATTENDANCE_SERVICE_ENTITY_TYPE,
            entityId: { in: serviceIds },
            action: CREW_ATTENDANCE_CONFIG_ACTION
          },
          orderBy: { createdAt: 'desc' }
        })
      : []
  ]);

  const operationConfig = latestMetadataByEntity(operationEvents);
  const serviceConfig = latestMetadataByEntity(serviceEvents);
  const operationById = new Map(operations.map((operation) => [operation.id, operation]));

  const operationRows = operations
    .map((operation) => {
      const crewAttendanceAllowed = operationAllowedFromMetadata(operationConfig.get(operation.id));
      return {
        id: operation.id,
        clientId: operation.clientId,
        clientName: operation.client?.name || 'Cliente sin nombre',
        name: operation.name || 'Operación sin nombre',
        cityName: operation.cityName || '',
        attendanceEnabled: operation.attendanceEnabled === true,
        crewAttendanceAllowed,
        crewAvailable: operation.attendanceEnabled === true && crewAttendanceAllowed
      };
    })
    .sort((left, right) => (
      left.clientName.localeCompare(right.clientName, 'es')
      || left.name.localeCompare(right.name, 'es')
    ));

  const serviceRows = services.map((service) => {
    const configuration = serviceConfigFromMetadata(serviceConfig.get(service.id));
    const operation = operationById.get(service.operationPointId) || service.operationPoint || null;
    const crewAttendanceAllowed = operationAllowedFromMetadata(operationConfig.get(service.operationPointId));
    const crewAvailable = Boolean(operation?.isActive !== false && operation?.attendanceEnabled === true && crewAttendanceAllowed);
    const assignments = (service.assignments || []).map((assignment) => ({
      workerId: assignment.workerId,
      fullName: assignment.worker?.fullName || 'Auxiliar sin nombre',
      status: assignment.status
    }));
    const leaderValid = configuration.crewLeaderWorkerId
      ? assignments.some((assignment) => assignment.workerId === configuration.crewLeaderWorkerId)
      : assignments.length === 0;
    return {
      id: service.id,
      operationPointId: service.operationPointId,
      clientName: service.clientName || 'Cliente sin nombre',
      operationPointName: service.operationPointName || 'Operación sin nombre',
      serviceDate: serviceDateKey(service.serviceDate),
      startTime: service.startTime || '',
      endTime: service.endTime || '',
      status: service.status,
      requiredWorkers: service.requiredWorkers,
      mode: configuration.mode,
      crewLeaderWorkerId: configuration.crewLeaderWorkerId,
      assignments,
      crewAttendanceAllowed,
      crewAvailable,
      leaderValid,
      configurationReady: configuration.mode === CREW_ATTENDANCE_MODE.INDIVIDUAL
        || (crewAvailable && (assignments.length === 0 || leaderValid))
    };
  });

  return { range: { from: range.from, to: range.to }, operations: operationRows, services: serviceRows };
}

export async function saveCrewAttendanceOperationCapability(prisma, input = {}) {
  requireWriteContract(prisma);
  const operationPointId = requireString(input.operationPointId, 'crew_attendance_operation_id');
  const allowed = explicitBoolean(input.allowed, 'crew_attendance_allowed');
  const operation = await prisma.dispatchOperationPoint.findFirst({
    where: { id: operationPointId },
    select: { id: true, isActive: true, attendanceEnabled: true }
  });
  if (!operation) throw new Error('crew_attendance_operation_not_found');
  if (operation.isActive !== true) throw new Error('crew_attendance_operation_inactive');
  if (allowed && operation.attendanceEnabled !== true) {
    throw new Error('crew_attendance_requires_attendance_enabled');
  }

  const previous = await latestConfigEvent(prisma, CREW_ATTENDANCE_OPERATION_ENTITY_TYPE, operation.id);
  if (operationAllowedFromMetadata(eventMetadata(previous)) === allowed && previous) {
    return { operationPointId: operation.id, allowed, changed: false };
  }

  await prisma.devAuditEvent.create({
    data: {
      entityType: CREW_ATTENDANCE_OPERATION_ENTITY_TYPE,
      entityId: operation.id,
      entityLabel: `operation:${operation.id}`,
      action: CREW_ATTENDANCE_CONFIG_ACTION,
      ...auditActor(input),
      toValue: { allowed },
      metadata: { allowed }
    }
  });
  return { operationPointId: operation.id, allowed, changed: true };
}

export async function saveCrewAttendanceServiceConfiguration(prisma, input = {}) {
  requireWriteContract(prisma);
  const serviceRequestId = requireString(input.serviceRequestId, 'crew_attendance_service_id');
  const mode = normalizeMode(input.mode);
  const requestedLeaderWorkerId = normalizeString(input.crewLeaderWorkerId, 160);
  const service = await prisma.dispatchServiceRequest.findUnique({
    where: { id: serviceRequestId },
    select: {
      id: true,
      operationPointId: true,
      serviceDate: true,
      startTime: true,
      operationPoint: { select: { id: true, isActive: true, attendanceEnabled: true } },
      assignments: {
        where: { status: { in: ACTIVE_DISPATCH_ASSIGNMENT_STATUSES } },
        select: { workerId: true, status: true }
      }
    }
  });
  if (!service) throw new Error('crew_attendance_service_not_found');

  let crewLeaderWorkerId = null;
  if (mode === CREW_ATTENDANCE_MODE.CREW) {
    if (!service.operationPointId || service.operationPoint?.isActive !== true || service.operationPoint?.attendanceEnabled !== true) {
      throw new Error('crew_attendance_operation_unavailable');
    }
    const operationEvent = await latestConfigEvent(prisma, CREW_ATTENDANCE_OPERATION_ENTITY_TYPE, service.operationPointId);
    if (!operationAllowedFromMetadata(eventMetadata(operationEvent))) {
      throw new Error('crew_attendance_operation_not_allowed');
    }
    const activeWorkerIds = new Set((service.assignments || []).map((assignment) => assignment.workerId));
    if (activeWorkerIds.size > 0 && !requestedLeaderWorkerId) {
      throw new Error('crew_attendance_leader_required');
    }
    if (requestedLeaderWorkerId && !activeWorkerIds.has(requestedLeaderWorkerId)) {
      throw new Error('crew_attendance_leader_not_assigned');
    }
    crewLeaderWorkerId = requestedLeaderWorkerId;
  }

  const previous = await latestConfigEvent(prisma, CREW_ATTENDANCE_SERVICE_ENTITY_TYPE, service.id);
  const previousConfig = serviceConfigFromMetadata(eventMetadata(previous));
  if (previous
    && previousConfig.mode === mode
    && previousConfig.crewLeaderWorkerId === crewLeaderWorkerId) {
    return { serviceRequestId: service.id, mode, crewLeaderWorkerId, changed: false };
  }

  const metadata = { mode, crewLeaderWorkerId };
  await prisma.devAuditEvent.create({
    data: {
      entityType: CREW_ATTENDANCE_SERVICE_ENTITY_TYPE,
      entityId: service.id,
      entityLabel: `service:${service.id} · ${serviceLabel(service)}`,
      action: CREW_ATTENDANCE_CONFIG_ACTION,
      ...auditActor(input),
      toValue: metadata,
      metadata
    }
  });
  return { serviceRequestId: service.id, mode, crewLeaderWorkerId, changed: true };
}

export function crewAttendanceConfigErrorMessage(error) {
  const code = typeof error?.message === 'string' ? error.message : '';
  const messages = {
    crew_attendance_operation_not_found: 'La operación ya no existe.',
    crew_attendance_operation_inactive: 'La operación está inactiva.',
    crew_attendance_requires_attendance_enabled: 'Primero habilita Asistencia para esta operación.',
    crew_attendance_service_not_found: 'El servicio ya no existe.',
    crew_attendance_mode_invalid: 'Selecciona modalidad Individual o Cuadrilla.',
    crew_attendance_operation_unavailable: 'La operación no está disponible para marcación por cuadrilla.',
    crew_attendance_operation_not_allowed: 'La operación no tiene habilitada la marcación por cuadrilla.',
    crew_attendance_leader_required: 'Selecciona el responsable de la cuadrilla entre los auxiliares asignados.',
    crew_attendance_leader_not_assigned: 'El responsable debe tener una asignación activa en este mismo servicio.'
  };
  if (messages[code]) return messages[code];
  if (code.endsWith('_invalid') || code.endsWith('_required')) return 'Revisa la configuración de cuadrilla e intenta nuevamente.';
  return 'No fue posible guardar la configuración de cuadrilla.';
}
