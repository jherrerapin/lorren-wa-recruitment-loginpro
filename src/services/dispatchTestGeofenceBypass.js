export const DISPATCH_TEST_GEOFENCE_BYPASS_ENTITY_TYPE = 'DISPATCH_TEST_GEOFENCE_BYPASS';
export const DISPATCH_TEST_GEOFENCE_BYPASS_ACTION = Object.freeze({
  ENABLED: 'TEST_GEOFENCE_BYPASS_ENABLED',
  DISABLED: 'TEST_GEOFENCE_BYPASS_DISABLED'
});

function normalizedString(value, maxLength = 200) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

function requirePrisma(prisma) {
  if (!prisma?.dispatchOperationPoint?.findFirst || !prisma?.devAuditEvent?.findFirst || !prisma?.devAuditEvent?.create) {
    throw new Error('dispatch_test_geofence_bypass_prisma_contract_invalid');
  }
  return prisma;
}

async function latestEvent(prisma, operationPointId) {
  return prisma.devAuditEvent.findFirst({
    where: {
      entityType: DISPATCH_TEST_GEOFENCE_BYPASS_ENTITY_TYPE,
      entityId: operationPointId,
      action: {
        in: [
          DISPATCH_TEST_GEOFENCE_BYPASS_ACTION.ENABLED,
          DISPATCH_TEST_GEOFENCE_BYPASS_ACTION.DISABLED
        ]
      }
    },
    orderBy: { createdAt: 'desc' }
  });
}

export async function getDispatchTestGeofenceBypassStatus(prisma, input = {}) {
  requirePrisma(prisma);
  const clientId = normalizedString(input.clientId, 120);
  const operationPointId = normalizedString(input.operationPointId, 120);
  if (!clientId || !operationPointId) throw new Error('dispatch_test_geofence_bypass_identity_required');

  const operationPoint = await prisma.dispatchOperationPoint.findFirst({
    where: { id: operationPointId, clientId },
    select: {
      id: true,
      name: true,
      client: { select: { id: true, isTestClient: true } }
    }
  });
  if (!operationPoint) throw new Error('dispatch_test_geofence_bypass_operation_not_found');

  const eligible = operationPoint.client?.isTestClient === true;
  const event = eligible ? await latestEvent(prisma, operationPoint.id) : null;
  return {
    eligible,
    enabled: eligible && event?.action === DISPATCH_TEST_GEOFENCE_BYPASS_ACTION.ENABLED,
    operationPointId: operationPoint.id,
    operationPointName: operationPoint.name
  };
}

export async function setDispatchTestGeofenceBypass(prisma, input = {}, options = {}) {
  const status = await getDispatchTestGeofenceBypassStatus(prisma, input);
  if (!status.eligible) throw new Error('dispatch_test_geofence_bypass_not_allowed');
  const enabled = input.enabled === true;
  const actorUsername = normalizedString(input.actorUsername, 160);
  if (!actorUsername) throw new Error('dispatch_test_geofence_bypass_actor_required');
  const now = options.now || new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('dispatch_test_geofence_bypass_now_invalid');

  await prisma.devAuditEvent.create({
    data: {
      entityType: DISPATCH_TEST_GEOFENCE_BYPASS_ENTITY_TYPE,
      entityId: status.operationPointId,
      entityLabel: status.operationPointName,
      action: enabled
        ? DISPATCH_TEST_GEOFENCE_BYPASS_ACTION.ENABLED
        : DISPATCH_TEST_GEOFENCE_BYPASS_ACTION.DISABLED,
      actorUsername,
      actorRole: normalizedString(input.actorRole, 80) || 'dev',
      actorSource: 'attendance-admin',
      ipAddress: normalizedString(input.ipAddress, 120),
      userAgent: normalizedString(input.userAgent, 500),
      metadata: {
        enabled,
        scope: 'TEST_CLIENT_OPERATION_AND_WORKER_ONLY'
      },
      createdAt: now
    }
  });

  return { ...status, enabled };
}

export async function isDispatchTestGeofenceBypassEnabled(prisma, input = {}) {
  requirePrisma(prisma);
  if (input.clientIsTest !== true || input.workerIsTest !== true) return false;
  const operationPointId = normalizedString(input.operationPointId, 120);
  if (!operationPointId) return false;
  const event = await latestEvent(prisma, operationPointId);
  return event?.action === DISPATCH_TEST_GEOFENCE_BYPASS_ACTION.ENABLED;
}
