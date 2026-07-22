import express from 'express';
import cookieParser from 'cookie-parser';
import { randomBytes, randomUUID } from 'node:crypto';
import { normalizeActivationToken, normalizeInstallationId } from '../modules/dispatch-attendance/domain/deviceActivationPolicy.js';
import {
  WORKER_PORTAL_SESSION_COOKIE_NAME,
  WORKER_PORTAL_SESSION_COOKIE_PATH
} from '../modules/dispatch-attendance/domain/workerPortalSessionPolicy.js';
import {
  activateWorkerPortalSession,
  resolveWorkerPortalSession
} from '../modules/dispatch-attendance/application/activateWorkerPortalSession.js';
import { createPrismaWorkerPortalSessionRepository } from '../modules/dispatch-attendance/infrastructure/prismaWorkerPortalSessionRepository.js';
import { createWorkerPortalActivationAbuseGuard } from '../services/workerPortalActivationAbuseGuard.js';

export const WORKER_PORTAL_HOME_PATH = '/operaciones/portal';
export const WORKER_PORTAL_ACTIVATION_PATH = '/operaciones/portal/activar';
export const WORKER_PORTAL_INSTALLATION_COOKIE_NAME = '__Secure-lorren-installation';
export const WORKER_PORTAL_INSTALLATION_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

const GENERIC_ACTIVATION_ERROR = 'activation_invalid_or_expired';
const ACTIVATION_RATE_LIMIT_ERROR = 'activation_temporarily_limited';
const CONFIGURATION_ERROR_CODES = new Set([
  'installation_pepper_required',
  'installation_pepper_too_short',
  'worker_portal_session_ttl_invalid'
]);
const EXPECTED_ACTIVATION_REJECTION_CODES = new Set([
  'activation_token_required',
  'activation_token_invalid',
  'worker_portal_activation_request_invalid',
  'worker_portal_session_repository_result_invalid',
  'worker_portal_session_repository_expiry_invalid',
  'worker_portal_session_repository_expired'
]);
const INVALID_SESSION_COOKIE_CODES = new Set([
  'worker_portal_session_token_invalid'
]);

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function createNonce(randomBytesFn = randomBytes) {
  const value = randomBytesFn(18);
  if (!Buffer.isBuffer(value) || value.length !== 18) {
    throw new Error('worker_portal_nonce_source_invalid');
  }
  return value.toString('base64');
}

function optionalInteger(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return Number(value);
}

function normalizeOptionalHeader(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function requestIp(req) {
  return normalizeOptionalHeader(req.ip, 120) || 'unknown';
}

function requestPlatform(req) {
  return normalizeOptionalHeader(req.get?.('sec-ch-ua-platform'), 120);
}

function requestUserAgent(req) {
  return normalizeOptionalHeader(req.get?.('user-agent'), 500);
}

function errorCode(error) {
  const candidate = typeof error?.code === 'string'
    ? error.code
    : (typeof error?.message === 'string' ? error.message : 'unknown');
  return /^[A-Za-z0-9_]{1,80}$/.test(candidate) ? candidate : 'worker_portal_error';
}

function isConfigurationError(error) {
  const code = errorCode(error);
  return CONFIGURATION_ERROR_CODES.has(code)
    || code.startsWith('worker_portal_session_prisma_')
    || code === 'worker_portal_repository_unavailable';
}

function isExpectedActivationRejection(error) {
  return EXPECTED_ACTIVATION_REJECTION_CODES.has(errorCode(error));
}

function isInvalidSessionCookie(error) {
  return INVALID_SESSION_COOKIE_CODES.has(errorCode(error));
}

function isActivationBodyParserError(error) {
  return error?.type === 'entity.parse.failed'
    || error?.type === 'entity.too.large'
    || (error instanceof SyntaxError && Number(error?.status) === 400);
}

export function workerPortalCookieOptions(maxAge) {
  if (!Number.isFinite(maxAge) || maxAge <= 0) {
    throw new Error('worker_portal_cookie_max_age_invalid');
  }

  return {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: WORKER_PORTAL_SESSION_COOKIE_PATH,
    maxAge
  };
}

export function applyWorkerPortalSecurityHeaders(res, nonce = null) {
  const scriptSource = nonce ? `'nonce-${nonce}'` : "'none'";
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set(
    'Content-Security-Policy',
    `default-src 'none'; script-src ${scriptSource}; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
  );
}

export function resolveWorkerPortalInstallationId(req, randomUUIDFn = randomUUID) {
  const current = req.cookies?.[WORKER_PORTAL_INSTALLATION_COOKIE_NAME];
  if (current) {
    try {
      return {
        installationId: normalizeInstallationId(current),
        shouldSetCookie: false
      };
    } catch {
      // Replace malformed or legacy values only after a successful activation.
    }
  }

  return {
    installationId: normalizeInstallationId(randomUUIDFn()),
    shouldSetCookie: true
  };
}

export function setWorkerPortalInstallationCookie(res, installationId) {
  const normalized = normalizeInstallationId(installationId);
  res.cookie(
    WORKER_PORTAL_INSTALLATION_COOKIE_NAME,
    normalized,
    workerPortalCookieOptions(WORKER_PORTAL_INSTALLATION_COOKIE_MAX_AGE_MS)
  );
}

export function buildWorkerPortalActivationUrl(origin, rawActivationToken) {
  const token = normalizeActivationToken(rawActivationToken);
  const url = new URL(WORKER_PORTAL_ACTIVATION_PATH, origin);
  if (url.protocol !== 'https:') throw new Error('worker_portal_activation_origin_https_required');
  url.searchParams.set('token', token);
  return url.toString();
}

function clearWorkerPortalSessionCookie(res) {
  res.clearCookie(WORKER_PORTAL_SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: WORKER_PORTAL_SESSION_COOKIE_PATH
  });
}

function renderPortal(res, mode, nonce, expiresAt = null) {
  return res.render('workerPortal', {
    mode,
    nonce,
    expiresAt: validDate(expiresAt) ? expiresAt.toISOString() : null
  });
}

export function createWorkerPortalActivationAttemptMiddleware(attemptGuard) {
  if (!attemptGuard || typeof attemptGuard.consume !== 'function') {
    throw new Error('worker_portal_activation_attempt_guard_required');
  }

  return function workerPortalActivationAttemptMiddleware(req, res, next) {
    const decision = attemptGuard.consume(requestIp(req));
    if (decision.allowed) return next();

    applyWorkerPortalSecurityHeaders(res);
    res.set('Retry-After', String(decision.retryAfterSeconds));
    return res.status(429).json({ ok: false, error: ACTIVATION_RATE_LIMIT_ERROR });
  };
}

export function workerPortalActivationJsonErrorHandler(error, _req, res, next) {
  if (!isActivationBodyParserError(error)) return next(error);

  applyWorkerPortalSecurityHeaders(res);
  const status = error?.type === 'entity.too.large' ? 413 : 400;
  return res.status(status).json({ ok: false, error: GENERIC_ACTIVATION_ERROR });
}

export function workerPortalRouter(prisma, options = {}) {
  const router = express.Router();
  const repositoryFactory = options.repositoryFactory || (() => createPrismaWorkerPortalSessionRepository(prisma));
  let repository = options.repository || null;
  const activateSessionFn = options.activateSessionFn || activateWorkerPortalSession;
  const resolveSessionFn = options.resolveSessionFn || resolveWorkerPortalSession;
  const installationPepper = options.installationPepper ?? process.env.ATTENDANCE_INSTALLATION_PEPPER;
  const sessionTtlMinutes = optionalInteger(
    options.sessionTtlMinutes ?? process.env.ATTENDANCE_PORTAL_SESSION_TTL_MINUTES
  );
  const randomUUIDFn = options.randomUUIDFn || randomUUID;
  const randomSessionBytesFn = options.randomSessionBytesFn;
  const nonceBytesFn = options.nonceBytesFn || randomBytes;
  const nowFn = options.nowFn || (() => new Date());
  const activationAttemptGuard = options.activationAttemptGuard || createWorkerPortalActivationAbuseGuard();
  const activationAttemptMiddleware = createWorkerPortalActivationAttemptMiddleware(activationAttemptGuard);
  const activationJsonParser = express.json({ limit: '4kb', strict: true, type: 'application/json' });

  function getRepository() {
    if (!repository) repository = repositoryFactory();
    if (!repository) throw new Error('worker_portal_repository_unavailable');
    return repository;
  }

  router.use(cookieParser());

  router.get('/activar', (_req, res) => {
    const nonce = createNonce(nonceBytesFn);
    applyWorkerPortalSecurityHeaders(res, nonce);
    return renderPortal(res, 'activation', nonce);
  });

  router.post('/activar', activationAttemptMiddleware, activationJsonParser, async (req, res) => {
    applyWorkerPortalSecurityHeaders(res);

    try {
      if (req.get?.('x-requested-with') !== 'worker-portal') {
        throw new Error('worker_portal_activation_request_invalid');
      }
      const now = nowFn();
      if (!validDate(now)) throw new Error('worker_portal_activation_now_invalid');
      const installation = resolveWorkerPortalInstallationId(req, randomUUIDFn);
      const result = await activateSessionFn({
        repository: getRepository(),
        rawActivationToken: req.body?.activationToken,
        installationId: installation.installationId,
        installationPepper,
        now,
        sessionTtlMinutes,
        randomBytesFn: randomSessionBytesFn,
        userAgent: requestUserAgent(req),
        platform: requestPlatform(req),
        ipAddress: requestIp(req)
      });

      if (installation.shouldSetCookie) {
        setWorkerPortalInstallationCookie(res, installation.installationId);
      }
      res.cookie(result.cookie.name, result.rawSessionToken, result.cookie.options);
      return res.status(200).json({ ok: true, redirectTo: WORKER_PORTAL_HOME_PATH });
    } catch (error) {
      const code = errorCode(error);
      if (isConfigurationError(error)) {
        console.error('[WORKER_PORTAL_CONFIGURATION_ERROR]', { code });
        return res.status(503).json({ ok: false, error: 'portal_temporarily_unavailable' });
      }
      if (!isExpectedActivationRejection(error)) {
        console.error('[WORKER_PORTAL_ACTIVATION_ERROR]', { code });
      }
      return res.status(400).json({ ok: false, error: GENERIC_ACTIVATION_ERROR });
    }
  });

  router.use('/activar', workerPortalActivationJsonErrorHandler);

  router.get('/', async (req, res) => {
    const nonce = createNonce(nonceBytesFn);
    applyWorkerPortalSecurityHeaders(res, nonce);
    const rawSessionToken = req.cookies?.[WORKER_PORTAL_SESSION_COOKIE_NAME];

    if (!rawSessionToken) return renderPortal(res, 'inactive', nonce);

    try {
      const now = nowFn();
      if (!validDate(now)) throw new Error('worker_portal_resolution_now_invalid');
      const session = await resolveSessionFn({ repository: getRepository(), rawSessionToken, now });
      if (!session) {
        clearWorkerPortalSessionCookie(res);
        return renderPortal(res, 'inactive', nonce);
      }
      return renderPortal(res, 'active', nonce, session.expiresAt);
    } catch (error) {
      if (isInvalidSessionCookie(error)) {
        clearWorkerPortalSessionCookie(res);
        return renderPortal(res, 'inactive', nonce);
      }
      console.error('[WORKER_PORTAL_AVAILABILITY_ERROR]', { code: errorCode(error) });
      return renderPortal(res, 'unavailable', nonce);
    }
  });

  return router;
}
