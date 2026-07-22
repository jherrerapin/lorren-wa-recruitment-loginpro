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

export const WORKER_PORTAL_HOME_PATH = '/operaciones/portal';
export const WORKER_PORTAL_ACTIVATION_PATH = '/operaciones/portal/activar';
export const WORKER_PORTAL_INSTALLATION_COOKIE_NAME = '__Secure-lorren-installation';
export const WORKER_PORTAL_INSTALLATION_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
export const WORKER_PORTAL_ACTIVATION_BODY_LIMIT = '4kb';
export const WORKER_PORTAL_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
export const WORKER_PORTAL_RATE_LIMIT_MAX_ATTEMPTS = 12;
export const WORKER_PORTAL_RATE_LIMIT_MAX_ENTRIES = 5000;

const GENERIC_ACTIVATION_ERROR = 'activation_invalid_or_expired';
const GENERIC_REQUEST_ERROR = 'activation_request_invalid';
const EXPECTED_ACTIVATION_REJECTION_CODES = new Set([
  'activation_token_required',
  'activation_token_invalid',
  'worker_portal_session_repository_result_invalid',
  'worker_portal_session_repository_expiry_invalid',
  'worker_portal_session_repository_expired',
  'worker_portal_activation_request_invalid'
]);
const CONFIGURATION_ERROR_CODES = new Set([
  'installation_pepper_required',
  'installation_pepper_too_short',
  'worker_portal_session_ttl_invalid'
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
  return normalizeOptionalHeader(req.ip, 120);
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

function positiveInteger(value, fallback, code, maximum = Number.MAX_SAFE_INTEGER) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate <= 0 || candidate > maximum) {
    throw new Error(code);
  }
  return candidate;
}

function rateLimitNow(nowFn) {
  const value = nowFn();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new Error('worker_portal_rate_limit_now_invalid');
  }
  return milliseconds;
}

function rateLimitKey(req) {
  return requestIp(req) || 'unknown';
}

export function createWorkerPortalActivationRateLimiter({
  windowMs = WORKER_PORTAL_RATE_LIMIT_WINDOW_MS,
  maxAttempts = WORKER_PORTAL_RATE_LIMIT_MAX_ATTEMPTS,
  maxEntries = WORKER_PORTAL_RATE_LIMIT_MAX_ENTRIES,
  nowFn = Date.now
} = {}) {
  const normalizedWindowMs = positiveInteger(windowMs, WORKER_PORTAL_RATE_LIMIT_WINDOW_MS, 'worker_portal_rate_limit_window_invalid');
  const normalizedMaxAttempts = positiveInteger(maxAttempts, WORKER_PORTAL_RATE_LIMIT_MAX_ATTEMPTS, 'worker_portal_rate_limit_attempts_invalid', 1000);
  const normalizedMaxEntries = positiveInteger(maxEntries, WORKER_PORTAL_RATE_LIMIT_MAX_ENTRIES, 'worker_portal_rate_limit_entries_invalid', 100000);
  if (typeof nowFn !== 'function') throw new Error('worker_portal_rate_limit_clock_required');

  const attemptsByIp = new Map();

  function prune(now) {
    for (const [key, entry] of attemptsByIp) {
      if (entry.resetAt <= now) attemptsByIp.delete(key);
    }
    while (attemptsByIp.size >= normalizedMaxEntries) {
      const oldestKey = attemptsByIp.keys().next().value;
      if (oldestKey === undefined) break;
      attemptsByIp.delete(oldestKey);
    }
  }

  function middleware(req, res, next) {
    const now = rateLimitNow(nowFn);
    const key = rateLimitKey(req);
    let entry = attemptsByIp.get(key);

    if (!entry || entry.resetAt <= now) {
      prune(now);
      entry = { count: 0, resetAt: now + normalizedWindowMs };
      attemptsByIp.set(key, entry);
    }

    entry.count += 1;
    if (entry.count <= normalizedMaxAttempts) return next();

    applyWorkerPortalSecurityHeaders(res);
    res.set('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
    return res.status(429).json({ ok: false, error: 'activation_rate_limited' });
  }

  return {
    middleware,
    size() {
      return attemptsByIp.size;
    },
    clear() {
      attemptsByIp.clear();
    }
  };
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
  url.hash = `token=${token}`;
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

function activationSecurityHeaders(_req, res, next) {
  applyWorkerPortalSecurityHeaders(res);
  return next();
}

function requireWorkerPortalRequest(req, res, next) {
  if (req.get?.('x-requested-with') !== 'worker-portal' || !req.is?.('application/json')) {
    return res.status(400).json({ ok: false, error: GENERIC_REQUEST_ERROR });
  }
  return next();
}

export function handleWorkerPortalActivationBodyError(error, _req, res, next) {
  if (!error) return next();
  const status = error?.type === 'entity.too.large' ? 413 : 400;
  return res.status(status).json({ ok: false, error: GENERIC_REQUEST_ERROR });
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
  const activationBodyParser = options.activationBodyParser || express.json({
    limit: WORKER_PORTAL_ACTIVATION_BODY_LIMIT,
    strict: true,
    type: 'application/json'
  });
  const activationRateLimiter = options.activationRateLimiter || createWorkerPortalActivationRateLimiter({
    windowMs: options.rateLimitWindowMs,
    maxAttempts: options.rateLimitMaxAttempts,
    maxEntries: options.rateLimitMaxEntries,
    nowFn: options.rateLimitNowFn || Date.now
  });

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

  router.post(
    '/activar',
    activationSecurityHeaders,
    activationRateLimiter.middleware,
    requireWorkerPortalRequest,
    activationBodyParser,
    handleWorkerPortalActivationBodyError,
    async (req, res) => {
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
        if (!EXPECTED_ACTIVATION_REJECTION_CODES.has(code)) {
          console.warn('[WORKER_PORTAL_ACTIVATION_REJECTED]', { code });
        }
        return res.status(400).json({ ok: false, error: GENERIC_ACTIVATION_ERROR });
      }
    }
  );

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
      console.error('[WORKER_PORTAL_AVAILABILITY_ERROR]', { code: errorCode(error) });
      clearWorkerPortalSessionCookie(res);
      return renderPortal(res, 'unavailable', nonce);
    }
  });

  return router;
}
