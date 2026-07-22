import {
  PRIMARY_DEVICE_ACTIVATION_PURPOSE,
  hashActivationToken,
  hashInstallationId,
  normalizeActivationToken,
  normalizeInstallationId
} from '../domain/deviceActivationPolicy.js';
import {
  buildWorkerPortalSessionCookie,
  buildWorkerPortalSessionExpiry,
  generateWorkerPortalSessionToken,
  hashWorkerPortalSessionToken,
  normalizeWorkerPortalSessionToken
} from '../domain/workerPortalSessionPolicy.js';

function requireRepositoryMethod(repository, methodName) {
  if (!repository || typeof repository[methodName] !== 'function') {
    throw new Error(`worker_portal_session_repository_${methodName}_required`);
  }
}

function normalizeOptionalText(value, maxLength) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function requireSessionResult(result) {
  if (!result?.workerId || !result?.deviceId || !result?.sessionId) {
    throw new Error('worker_portal_session_repository_result_invalid');
  }

  if (!(result.expiresAt instanceof Date) || Number.isNaN(result.expiresAt.getTime())) {
    throw new Error('worker_portal_session_repository_expiry_invalid');
  }

  return result;
}

export async function activateWorkerPortalSession({
  repository,
  rawActivationToken,
  installationId,
  installationPepper,
  now = new Date(),
  sessionTtlMinutes,
  randomBytesFn,
  userAgent = null,
  platform = null,
  ipAddress = null
}) {
  requireRepositoryMethod(repository, 'claimActivationAuthorizeDeviceAndCreateSession');

  const activationToken = normalizeActivationToken(rawActivationToken);
  const normalizedInstallationId = normalizeInstallationId(installationId);
  const rawSessionToken = generateWorkerPortalSessionToken(randomBytesFn);
  const sessionExpiresAt = buildWorkerPortalSessionExpiry(now, sessionTtlMinutes);

  const result = requireSessionResult(
    await repository.claimActivationAuthorizeDeviceAndCreateSession({
      purpose: PRIMARY_DEVICE_ACTIVATION_PURPOSE,
      activationTokenHash: hashActivationToken(activationToken),
      installationIdHash: hashInstallationId(normalizedInstallationId, installationPepper),
      sessionTokenHash: hashWorkerPortalSessionToken(rawSessionToken),
      sessionExpiresAt,
      now,
      userAgent: normalizeOptionalText(userAgent, 500),
      platform: normalizeOptionalText(platform, 120),
      ipAddress: normalizeOptionalText(ipAddress, 120)
    })
  );

  if (result.expiresAt.getTime() <= now.getTime()) {
    throw new Error('worker_portal_session_repository_expired');
  }

  return {
    workerId: result.workerId,
    deviceId: result.deviceId,
    sessionId: result.sessionId,
    activatedAt: result.activatedAt instanceof Date && !Number.isNaN(result.activatedAt.getTime())
      ? result.activatedAt
      : now,
    expiresAt: result.expiresAt,
    rawSessionToken,
    cookie: buildWorkerPortalSessionCookie(result.expiresAt, now)
  };
}

export async function resolveWorkerPortalSession({
  repository,
  rawSessionToken,
  now = new Date()
}) {
  requireRepositoryMethod(repository, 'resolveActiveSession');
  const token = normalizeWorkerPortalSessionToken(rawSessionToken);
  const result = await repository.resolveActiveSession({
    sessionTokenHash: hashWorkerPortalSessionToken(token),
    now
  });

  if (!result) return null;
  const session = requireSessionResult(result);
  if (session.expiresAt.getTime() <= now.getTime()) return null;

  return {
    workerId: session.workerId,
    deviceId: session.deviceId,
    sessionId: session.sessionId,
    expiresAt: session.expiresAt
  };
}
