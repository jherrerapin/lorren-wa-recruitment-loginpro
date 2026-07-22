import { runSerializableActivationTransaction } from './prismaPrimaryDeviceActivationRepository.js';

const ACTIVE_WORKER_STATUSES = Object.freeze(['ACTIVE', 'CONTRATADO']);
const ACTIVE_SESSION_STATUS = 'ACTIVE';
const REVOKED_SESSION_STATUS = 'REVOKED';
const PRIMARY_AUTHORIZATION_TYPE = 'PRIMARY';
const REPLACED_SESSION_REASON = 'REPLACED_BY_NEW_PORTAL_SESSION';
const REPLACED_DEVICE_REASON = 'PRIMARY_DEVICE_REPLACED';
const SYSTEM_ACTOR = 'attendance-portal-session';
const DEFAULT_MAX_TRANSACTION_RETRIES = 3;

function requirePrismaModel(prisma, modelName) {
  if (!prisma?.[modelName]) {
    throw new Error(`worker_portal_session_prisma_${modelName}_required`);
  }
}

function normalizeRetryCount(value) {
  const retries = Number(value);
  if (!Number.isInteger(retries) || retries < 0 || retries > 5) {
    throw new Error('worker_portal_session_transaction_retries_invalid');
  }
  return retries;
}

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function activeWorkerWhere(workerId) {
  return {
    id: workerId,
    operationalStatus: { in: [...ACTIVE_WORKER_STATUSES] }
  };
}

function activationAvailable(activation, input) {
  return Boolean(
    activation
    && activation.purpose === input.purpose
    && activation.status === 'PENDING'
    && activation.consumedAt === null
    && activation.revokedAt === null
    && validDate(activation.expiresAt)
    && activation.expiresAt.getTime() > input.now.getTime()
  );
}

function activeDeviceFilter(now) {
  return {
    status: 'ACTIVE',
    authorizationType: PRIMARY_AUTHORIZATION_TYPE,
    revokedAt: null,
    OR: [
      { authorizedUntil: null },
      { authorizedUntil: { gt: now } }
    ]
  };
}

export function createPrismaWorkerPortalSessionRepository(
  prisma,
  { maxTransactionRetries = DEFAULT_MAX_TRANSACTION_RETRIES } = {}
) {
  requirePrismaModel(prisma, 'dispatchWorker');
  requirePrismaModel(prisma, 'dispatchWorkerActivation');
  requirePrismaModel(prisma, 'dispatchWorkerDevice');
  requirePrismaModel(prisma, 'dispatchWorkerPortalSession');

  const retryLimit = normalizeRetryCount(maxTransactionRetries);

  return {
    async claimActivationAuthorizeDeviceAndCreateSession(input) {
      return runSerializableActivationTransaction(prisma, async (tx) => {
        const activation = await tx.dispatchWorkerActivation.findUnique({
          where: { tokenHash: input.activationTokenHash },
          select: {
            id: true,
            workerId: true,
            purpose: true,
            status: true,
            expiresAt: true,
            consumedAt: true,
            revokedAt: true
          }
        });
        if (!activationAvailable(activation, input)) return null;

        const worker = await tx.dispatchWorker.findFirst({
          where: activeWorkerWhere(activation.workerId),
          select: { id: true }
        });
        if (!worker) return null;

        const claimed = await tx.dispatchWorkerActivation.updateMany({
          where: {
            id: activation.id,
            purpose: input.purpose,
            status: 'PENDING',
            consumedAt: null,
            revokedAt: null,
            expiresAt: { gt: input.now }
          },
          data: {
            status: 'CONSUMED',
            consumedAt: input.now
          }
        });
        if (claimed.count !== 1) return null;

        await tx.dispatchWorkerPortalSession.updateMany({
          where: {
            workerId: activation.workerId,
            status: ACTIVE_SESSION_STATUS,
            revokedAt: null
          },
          data: {
            status: REVOKED_SESSION_STATUS,
            revokedAt: input.now,
            revokedByUsername: SYSTEM_ACTOR,
            revocationReason: REPLACED_SESSION_REASON
          }
        });

        await tx.dispatchWorkerDevice.updateMany({
          where: {
            workerId: activation.workerId,
            authorizationType: PRIMARY_AUTHORIZATION_TYPE,
            status: 'ACTIVE'
          },
          data: {
            status: 'REVOKED',
            authorizedUntil: input.now,
            revokedAt: input.now,
            revokedByUsername: SYSTEM_ACTOR,
            revocationReason: REPLACED_DEVICE_REASON
          }
        });

        const device = await tx.dispatchWorkerDevice.upsert({
          where: {
            workerId_installationIdHash: {
              workerId: activation.workerId,
              installationIdHash: input.installationIdHash
            }
          },
          create: {
            workerId: activation.workerId,
            installationIdHash: input.installationIdHash,
            authorizationType: PRIMARY_AUTHORIZATION_TYPE,
            status: 'ACTIVE',
            authorizedFrom: input.now,
            authorizedUntil: null,
            lastSeenAt: input.now,
            userAgent: input.userAgent,
            platform: input.platform
          },
          update: {
            authorizationType: PRIMARY_AUTHORIZATION_TYPE,
            status: 'ACTIVE',
            authorizedFrom: input.now,
            authorizedUntil: null,
            lastSeenAt: input.now,
            revokedAt: null,
            revokedByUsername: null,
            revocationReason: null,
            userAgent: input.userAgent,
            platform: input.platform
          },
          select: {
            id: true,
            workerId: true,
            authorizedFrom: true
          }
        });

        const session = await tx.dispatchWorkerPortalSession.create({
          data: {
            workerId: activation.workerId,
            workerDeviceId: device.id,
            activationId: activation.id,
            sessionTokenHash: input.sessionTokenHash,
            status: ACTIVE_SESSION_STATUS,
            issuedAt: input.now,
            expiresAt: input.sessionExpiresAt,
            lastSeenAt: input.now,
            ipAddress: input.ipAddress,
            userAgent: input.userAgent,
            platform: input.platform
          },
          select: {
            id: true,
            workerId: true,
            workerDeviceId: true,
            issuedAt: true,
            expiresAt: true
          }
        });

        await tx.dispatchWorkerActivation.update({
          where: { id: activation.id },
          data: { consumedByDeviceId: device.id }
        });

        return {
          workerId: session.workerId,
          deviceId: session.workerDeviceId,
          sessionId: session.id,
          activatedAt: session.issuedAt,
          expiresAt: session.expiresAt
        };
      }, { maxRetries: retryLimit });
    },

    async resolveActiveSession(input) {
      if (!validDate(input.now)) throw new Error('worker_portal_session_now_invalid');

      const session = await prisma.dispatchWorkerPortalSession.findFirst({
        where: {
          sessionTokenHash: input.sessionTokenHash,
          status: ACTIVE_SESSION_STATUS,
          revokedAt: null,
          expiresAt: { gt: input.now },
          worker: {
            is: {
              operationalStatus: { in: [...ACTIVE_WORKER_STATUSES] }
            }
          },
          workerDevice: {
            is: activeDeviceFilter(input.now)
          }
        },
        select: {
          id: true,
          workerId: true,
          workerDeviceId: true,
          expiresAt: true
        }
      });
      if (!session) return null;

      const touched = await prisma.dispatchWorkerPortalSession.updateMany({
        where: {
          id: session.id,
          status: ACTIVE_SESSION_STATUS,
          revokedAt: null,
          expiresAt: { gt: input.now }
        },
        data: {
          lastSeenAt: input.now
        }
      });
      if (touched.count !== 1) return null;

      return {
        workerId: session.workerId,
        deviceId: session.workerDeviceId,
        sessionId: session.id,
        expiresAt: session.expiresAt
      };
    }
  };
}
