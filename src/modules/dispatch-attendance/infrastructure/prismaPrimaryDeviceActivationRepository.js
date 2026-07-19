const ACTIVE_WORKER_STATUSES = Object.freeze(['ACTIVE', 'CONTRATADO']);
const DEFAULT_MAX_TRANSACTION_RETRIES = 3;
const REPLACED_ACTIVATION_REASON = 'REPLACED_BY_NEW_ACTIVATION';
const REPLACED_DEVICE_REASON = 'PRIMARY_DEVICE_REPLACED';
const SYSTEM_ACTOR = 'attendance-activation';

function requirePrismaMethod(target, methodName) {
  if (!target || typeof target[methodName] !== 'function') {
    throw new Error(`activation_prisma_${methodName}_required`);
  }
}

function normalizeRetryCount(value) {
  const retries = Number(value);
  if (!Number.isInteger(retries) || retries < 0 || retries > 5) {
    throw new Error('activation_transaction_retries_invalid');
  }
  return retries;
}

export function isPrismaSerializationConflict(error) {
  return error?.code === 'P2034';
}

export async function runSerializableActivationTransaction(
  prisma,
  operation,
  { maxRetries = DEFAULT_MAX_TRANSACTION_RETRIES } = {}
) {
  requirePrismaMethod(prisma, '$transaction');
  if (typeof operation !== 'function') throw new Error('activation_transaction_operation_required');

  const retryLimit = normalizeRetryCount(maxRetries);
  let retries = 0;

  while (true) {
    try {
      return await prisma.$transaction(operation, { isolationLevel: 'Serializable' });
    } catch (error) {
      if (!isPrismaSerializationConflict(error) || retries >= retryLimit) throw error;
      retries += 1;
    }
  }
}

function activeWorkerWhere(workerId) {
  return {
    id: workerId,
    operationalStatus: { in: [...ACTIVE_WORKER_STATUSES] }
  };
}

function activationAvailable(activation, { purpose, now }) {
  return Boolean(
    activation &&
    activation.purpose === purpose &&
    activation.status === 'PENDING' &&
    activation.consumedAt === null &&
    activation.revokedAt === null &&
    activation.expiresAt instanceof Date &&
    activation.expiresAt.getTime() > now.getTime()
  );
}

export function createPrismaPrimaryDeviceActivationRepository(
  prisma,
  { maxTransactionRetries = DEFAULT_MAX_TRANSACTION_RETRIES } = {}
) {
  if (!prisma?.dispatchWorker || !prisma?.dispatchWorkerActivation || !prisma?.dispatchWorkerDevice) {
    throw new Error('activation_prisma_models_required');
  }

  const retryLimit = normalizeRetryCount(maxTransactionRetries);

  return {
    async findActiveWorker(workerId) {
      return prisma.dispatchWorker.findFirst({
        where: activeWorkerWhere(workerId),
        select: { id: true, operationalStatus: true }
      });
    },

    async replacePendingActivation(input) {
      return runSerializableActivationTransaction(prisma, async (tx) => {
        const worker = await tx.dispatchWorker.findFirst({
          where: activeWorkerWhere(input.workerId),
          select: { id: true }
        });
        if (!worker) throw new Error('activation_worker_not_active');

        await tx.dispatchWorkerActivation.updateMany({
          where: {
            workerId: input.workerId,
            purpose: input.purpose,
            status: 'PENDING',
            consumedAt: null,
            revokedAt: null
          },
          data: {
            status: 'REVOKED',
            revokedAt: input.createdAt,
            revokedByUsername: input.createdByUsername,
            revocationReason: REPLACED_ACTIVATION_REASON
          }
        });

        return tx.dispatchWorkerActivation.create({
          data: {
            workerId: input.workerId,
            purpose: input.purpose,
            tokenHash: input.tokenHash,
            status: 'PENDING',
            expiresAt: input.expiresAt,
            createdAt: input.createdAt,
            createdByUsername: input.createdByUsername
          },
          select: { id: true, workerId: true, purpose: true, expiresAt: true }
        });
      }, { maxRetries: retryLimit });
    },

    async claimActivationAndAuthorizePrimaryDevice(input) {
      return runSerializableActivationTransaction(prisma, async (tx) => {
        const activation = await tx.dispatchWorkerActivation.findUnique({
          where: { tokenHash: input.tokenHash },
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

        await tx.dispatchWorkerDevice.updateMany({
          where: {
            workerId: activation.workerId,
            authorizationType: 'PRIMARY',
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
            authorizationType: 'PRIMARY',
            status: 'ACTIVE',
            authorizedFrom: input.now,
            authorizedUntil: null,
            lastSeenAt: input.now,
            userAgent: input.userAgent,
            platform: input.platform
          },
          update: {
            authorizationType: 'PRIMARY',
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
          select: { id: true, workerId: true, authorizedFrom: true }
        });

        await tx.dispatchWorkerActivation.update({
          where: { id: activation.id },
          data: { consumedByDeviceId: device.id }
        });

        return {
          workerId: activation.workerId,
          deviceId: device.id,
          activatedAt: device.authorizedFrom
        };
      }, { maxRetries: retryLimit });
    }
  };
}
