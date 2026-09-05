const WORKER_PORTAL_SERVICE_ENTITY_TYPE = 'WORKER_PORTAL_SERVICE_STATE';
const WORKER_PORTAL_SERVICE_ENTITY_ID = 'global';
const WORKER_PORTAL_SERVICE_ACTION = 'WORKER_PORTAL_SERVICE_STATE_CHANGED';

function normalizeString(value, maxLength = 500) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function stateFromEvent(event) {
  return {
    enabled: event?.metadata?.enabled !== false,
    changedAt: validDate(event?.createdAt) ? event.createdAt : null,
    changedBy: normalizeString(event?.actorUsername),
    eventId: normalizeString(event?.id)
  };
}

export async function loadWorkerPortalServiceState(prisma, options = {}) {
  if (!prisma?.devAuditEvent?.findFirst) {
    return { enabled: true, changedAt: null, changedBy: null, eventId: null };
  }

  const at = options.at ?? null;
  if (at !== null && !validDate(at)) throw new Error('worker_portal_service_state_at_invalid');

  const event = await prisma.devAuditEvent.findFirst({
    where: {
      entityType: WORKER_PORTAL_SERVICE_ENTITY_TYPE,
      entityId: WORKER_PORTAL_SERVICE_ENTITY_ID,
      action: WORKER_PORTAL_SERVICE_ACTION,
      ...(at ? { createdAt: { lte: at } } : {})
    },
    orderBy: { createdAt: 'desc' }
  });

  return event
    ? stateFromEvent(event)
    : { enabled: true, changedAt: null, changedBy: null, eventId: null };
}

export async function isWorkerPortalServiceEnabled(prisma) {
  return (await loadWorkerPortalServiceState(prisma)).enabled;
}

export async function isWorkerPortalServiceEnabledAt(prisma, at) {
  return (await loadWorkerPortalServiceState(prisma, { at })).enabled;
}

export async function setWorkerPortalServiceState(prisma, input = {}) {
  if (!prisma?.devAuditEvent?.create || !prisma?.devAuditEvent?.findFirst) {
    throw new Error('worker_portal_service_state_persistence_unavailable');
  }
  if (typeof input.enabled !== 'boolean') throw new Error('worker_portal_service_state_enabled_invalid');

  const current = await loadWorkerPortalServiceState(prisma);
  if (current.enabled === input.enabled) return { ...current, changed: false };

  const event = await prisma.devAuditEvent.create({
    data: {
      entityType: WORKER_PORTAL_SERVICE_ENTITY_TYPE,
      entityId: WORKER_PORTAL_SERVICE_ENTITY_ID,
      entityLabel: 'Portal del Auxiliar',
      action: WORKER_PORTAL_SERVICE_ACTION,
      actorUserId: normalizeString(input.actorUserId, 180),
      actorUsername: normalizeString(input.actorUsername, 180),
      actorRole: normalizeString(input.actorRole, 80),
      actorSource: 'attendance-dev-control',
      ipAddress: normalizeString(input.ipAddress, 120),
      userAgent: normalizeString(input.userAgent, 500),
      fromValue: { enabled: current.enabled },
      toValue: { enabled: input.enabled },
      metadata: { enabled: input.enabled }
    }
  });

  return { ...stateFromEvent(event), changed: true };
}

export const WORKER_PORTAL_SERVICE_STATE_CONTRACT = Object.freeze({
  entityType: WORKER_PORTAL_SERVICE_ENTITY_TYPE,
  entityId: WORKER_PORTAL_SERVICE_ENTITY_ID,
  action: WORKER_PORTAL_SERVICE_ACTION
});
