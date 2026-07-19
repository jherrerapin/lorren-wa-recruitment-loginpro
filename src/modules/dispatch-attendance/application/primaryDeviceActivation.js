import {
  PRIMARY_DEVICE_ACTIVATION_PURPOSE,
  buildActivationExpiry,
  generateActivationToken,
  hashActivationToken,
  hashInstallationId,
  normalizeActivationToken,
  normalizeInstallationId,
  requiredString
} from '../domain/deviceActivationPolicy.js';

function requiredRepositoryMethod(repository, methodName) {
  if (!repository || typeof repository[methodName] !== 'function') {
    throw new Error(`activation_repository_${methodName}_required`);
  }
}

function normalizeOptionalText(value, maxLength) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

export async function issuePrimaryDeviceActivation({
  repository,
  workerId,
  createdByUsername = null,
  now = new Date(),
  ttlMinutes,
  randomBytesFn
}) {
  requiredRepositoryMethod(repository, 'findActiveWorker');
  requiredRepositoryMethod(repository, 'replacePendingActivation');

  const normalizedWorkerId = requiredString(workerId, 'worker_id');
  const worker = await repository.findActiveWorker(normalizedWorkerId);
  if (!worker) throw new Error('activation_worker_not_active');

  const rawToken = generateActivationToken(randomBytesFn);
  const tokenHash = hashActivationToken(rawToken);
  const expiresAt = buildActivationExpiry(now, ttlMinutes);

  const activation = await repository.replacePendingActivation({
    workerId: normalizedWorkerId,
    purpose: PRIMARY_DEVICE_ACTIVATION_PURPOSE,
    tokenHash,
    expiresAt,
    createdAt: now,
    createdByUsername: normalizeOptionalText(createdByUsername, 120)
  });

  if (!activation?.id) throw new Error('activation_repository_result_invalid');

  return {
    activationId: activation.id,
    workerId: normalizedWorkerId,
    purpose: PRIMARY_DEVICE_ACTIVATION_PURPOSE,
    rawToken,
    expiresAt
  };
}

export async function activatePrimaryDevice({
  repository,
  rawToken,
  installationId,
  installationPepper,
  userAgent = null,
  platform = null,
  now = new Date()
}) {
  requiredRepositoryMethod(repository, 'claimActivationAndAuthorizePrimaryDevice');

  const token = normalizeActivationToken(rawToken);
  const normalizedInstallationId = normalizeInstallationId(installationId);
  const tokenHash = hashActivationToken(token);
  const installationIdHash = hashInstallationId(normalizedInstallationId, installationPepper);

  const result = await repository.claimActivationAndAuthorizePrimaryDevice({
    purpose: PRIMARY_DEVICE_ACTIVATION_PURPOSE,
    tokenHash,
    installationIdHash,
    now,
    userAgent: normalizeOptionalText(userAgent, 500),
    platform: normalizeOptionalText(platform, 120)
  });

  if (!result) throw new Error('activation_token_unavailable');
  if (!result.workerId || !result.deviceId) throw new Error('activation_repository_result_invalid');

  return {
    workerId: result.workerId,
    deviceId: result.deviceId,
    authorizationType: 'PRIMARY',
    activatedAt: result.activatedAt instanceof Date && !Number.isNaN(result.activatedAt.getTime()) ? result.activatedAt : now
  };
}
