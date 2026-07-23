import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  hashInstallationId,
  normalizeActivationToken,
  normalizeInstallationId
} from '../modules/dispatch-attendance/domain/deviceActivationPolicy.js';
import {
  WORKER_PORTAL_SESSION_COOKIE_NAME,
  WORKER_PORTAL_SESSION_COOKIE_PATH
} from '../modules/dispatch-attendance/domain/workerPortalSessionPolicy.js';
import {
  activateWorkerPortalSession,
  resolveWorkerPortalSession
} from '../modules/dispatch-attendance/application/activateWorkerPortalSession.js';
import { registerDispatchArrival } from '../modules/dispatch-attendance/application/registerArrival.js';
import {
  loadWorkerPortalAssignmentForArrival,
  loadWorkerPortalAssignments
} from '../modules/dispatch-attendance/application/workerPortalAssignments.js';
import { createPrismaWorkerPortalSessionRepository } from '../modules/dispatch-attendance/infrastructure/prismaWorkerPortalSessionRepository.js';
import { createWorkerPortalActivationAbuseGuard } from '../services/workerPortalActivationAbuseGuard.js';
import {
  MAX_ATTENDANCE_EVIDENCE_BYTES,
  discardAttendanceArrivalEvidence,
  storeAttendanceArrivalEvidence
} from '../services/attendanceEvidenceStorage.js';

export const WORKER_PORTAL_HOME_PATH = '/operaciones/portal';
export const WORKER_PORTAL_ACTIVATION_PATH = '/operaciones/portal/activar';
export const WORKER_PORTAL_INSTALLATION_COOKIE_NAME = '__Secure-lorren-installation';
export const WORKER_PORTAL_INSTALLATION_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

const WORKER_PORTAL_SERVICE_WORKER_FILE = fileURLToPath(
  new URL('../public/worker-portal-sw.js', import.meta.url)
);
const GENERIC_ACTIVATION_ERROR = 'activation_invalid_or_expired';
const ACTIVATION_RATE_LIMIT_ERROR = 'activation_temporarily_limited';
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;
const ONLINE_WEB_CAPTURE_MODE = 'ONLINE_WEB';
const OFFLINE_WEB_CAPTURE_MODE = 'OFFLINE_WEB';
const CONFIGURATION_ERROR_CODES = new Set([
  'installation_pepper_required',
  'installation_pepper_too_short',
  'worker_portal_session_ttl_invalid',
  'attendance_evidence_storage_unavailable'
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
const EXPECTED_ARRIVAL_INPUT_CODES = new Set([
  'attendance_assignment_not_found',
  'attendance_evidence_file_invalid',
  'attendance_evidence_file_too_large',
  'attendance_evidence_mime_not_allowed',
  'attendance_evidence_worker_id_invalid',
  'attendance_evidence_assignment_id_invalid',
  'attendance_evidence_idempotency_key_invalid'
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
  return /^[A-Za-z0-9_]{1,100}$/.test(candidate) ? candidate : 'worker_portal_error';
}

function isConfigurationError(error) {
  const code = errorCode(error);
  return CONFIGURATION_ERROR_CODES.has(code)
    || code.startsWith('worker_portal_session_prisma_')
    || code.startsWith('worker_portal_assignment_')
    || code === 'worker_portal_repository_unavailable'
    || code === 'R2_storage_is_not_configured';
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

function requiredBodyNumber(value, label, { min, max }) {
  if (value === undefined || value === null || value === '') throw new Error(`${label}_required`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${label}_invalid`);
  return number;
}

function optionalBodyDate(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (!validDate(date)) throw new Error(`${label}_invalid`);
  return date;
}

function normalizeIdempotencyKey(value) {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value.trim())) {
    throw new Error('attendance_idempotency_key_invalid');
  }
  return value.trim();
}

function normalizeCaptureMode(value) {
  if (value === undefined || value === null || value === '') return ONLINE_WEB_CAPTURE_MODE;
  if (typeof value !== 'string') throw new Error('attendance_capture_mode_invalid');
  const normalized = value.trim().toUpperCase();
  if (![ONLINE_WEB_CAPTURE_MODE, OFFLINE_WEB_CAPTURE_MODE].includes(normalized)) {
    throw new Error('attendance_capture_mode_invalid');
  }
  return normalized;
}

function arrivalPublicResult(result) {
  if (!result?.recorded) {
    return {
      status: 409,
      payload: {
        ok: false,
        error: result?.validation?.riskFlags?.[0] === 'ARRIVAL_WINDOW_NOT_OPEN'
          ? 'arrival_window_not_open'
          : 'arrival_not_recorded'
      }
    };
  }

  const validationStatus = result.validation?.validationStatus || 'REVIEW_REQUIRED';
  const punctualityStatus = result.validation?.reportedPunctuality || null;
  const riskFlags = Array.isArray(result.validation?.riskFlags) ? result.validation.riskFlags : [];
  let message = 'Llegada registrada y enviada para revisión.';
  if (riskFlags.includes('OFFLINE_WEB_CAPTURE')) {
    message = 'Llegada guardada sin conexión y sincronizada. Quedó pendiente de revisión.';
  } else if (validationStatus === 'AUTO_VALIDATED') {
    message = punctualityStatus === 'LATE'
      ? 'Llegada registrada y validada. Se registró como llegada tarde.'
      : 'Llegada registrada y validada a tiempo.';
  }

  return {
    status: 200,
    payload: {
      ok: true,
      recorded: true,
      replayed: Boolean(result.replayed),
      validationStatus,
      attendanceStatus: result.validation?.attendanceStatus || null,
      punctualityStatus,
      requiresReview: validationStatus === 'REVIEW_REQUIRED',
      message
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
    `default-src 'none'; script-src ${scriptSource} 'self'; worker-src 'self'; manifest-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
  );
}

export function redactWorkerPortalActivationUrlForLogging(req, _res, next) {
  if (req.method === 'GET' && typeof req.originalUrl === 'string') {
    req.originalUrl = req.originalUrl.replace(/([?&]token=)[^&#]*/i, '$1[REDACTED]');
  }
  return next();
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

function renderPortal(res, mode, nonce, options = {}) {
  res.set('X-Lorren-Worker-Portal-Mode', mode);
  return res.render('workerPortal', {
    mode,
    nonce,
    expiresAt: validDate(options.expiresAt) ? options.expiresAt.toISOString() : null,
    assignments: Array.isArray(options.assignments) ? options.assignments : []
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

export function workerPortalArrivalUploadErrorHandler(error, _req, res, next) {
  if (!(error instanceof multer.MulterError)) return next(error);
  applyWorkerPortalSecurityHeaders(res);
  const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
  return res.status(status).json({ ok: false, error: 'arrival_evidence_invalid' });
}

export function workerPortalRouter(prisma, options = {}) {
  const router = express.Router();
  const repositoryFactory = options.repositoryFactory || (() => createPrismaWorkerPortalSessionRepository(prisma));
  let repository = options.repository || null;
  const activateSessionFn = options.activateSessionFn || activateWorkerPortalSession;
  const resolveSessionFn = options.resolveSessionFn || resolveWorkerPortalSession;
  const loadAssignmentsFn = options.loadAssignmentsFn || loadWorkerPortalAssignments;
  const loadAssignmentForArrivalFn = options.loadAssignmentForArrivalFn || loadWorkerPortalAssignmentForArrival;
  const registerArrivalFn = options.registerArrivalFn || registerDispatchArrival;
  const storeArrivalEvidenceFn = options.storeArrivalEvidenceFn || storeAttendanceArrivalEvidence;
  const discardArrivalEvidenceFn = options.discardArrivalEvidenceFn || discardAttendanceArrivalEvidence;
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
  const arrivalUpload = options.arrivalUpload || multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_ATTENDANCE_EVIDENCE_BYTES,
      files: 1,
      fields: 12,
      fieldSize: 4 * 1024
    }
  }).single('selfie');

  function getRepository() {
    if (!repository) repository = repositoryFactory();
    if (!repository) throw new Error('worker_portal_repository_unavailable');
    return repository;
  }

  async function resolveRequestSession(req, now) {
    const rawSessionToken = req.cookies?.[WORKER_PORTAL_SESSION_COOKIE_NAME];
    if (!rawSessionToken) return null;
    return resolveSessionFn({ repository: getRepository(), rawSessionToken, now });
  }

  router.use(cookieParser());
  router.use(redactWorkerPortalActivationUrlForLogging);

  router.get('/service-worker.js', (_req, res) => {
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Service-Worker-Allowed', `${WORKER_PORTAL_HOME_PATH}/`);
    res.set('X-Content-Type-Options', 'nosniff');
    return res.sendFile(WORKER_PORTAL_SERVICE_WORKER_FILE);
  });

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

  router.post(
    '/asignaciones/:assignmentId/llegada',
    (req, res, next) => {
      applyWorkerPortalSecurityHeaders(res);
      if (req.get?.('x-requested-with') !== 'worker-portal') {
        return res.status(400).json({ ok: false, error: 'arrival_request_invalid' });
      }
      return next();
    },
    arrivalUpload,
    async (req, res) => {
      let evidence = null;
      try {
        const now = nowFn();
        if (!validDate(now)) throw new Error('worker_portal_arrival_now_invalid');
        const session = await resolveRequestSession(req, now);
        if (!session) {
          clearWorkerPortalSessionCookie(res);
          return res.status(401).json({ ok: false, error: 'portal_session_required' });
        }

        const idempotencyKey = normalizeIdempotencyKey(req.body?.idempotencyKey);
        const captureMode = normalizeCaptureMode(req.body?.captureMode);
        const clientCapturedAt = optionalBodyDate(req.body?.clientCapturedAt, 'attendance_client_captured_at');
        if (captureMode === OFFLINE_WEB_CAPTURE_MODE && !clientCapturedAt) {
          throw new Error('attendance_client_captured_at_required');
        }

        const assignment = await loadAssignmentForArrivalFn(prisma, {
          workerId: session.workerId,
          assignmentId: req.params.assignmentId,
          now
        });
        if (!assignment) return res.status(404).json({ ok: false, error: 'assignment_not_available' });
        if (!assignment.attendanceEnabled) {
          return res.status(409).json({ ok: false, error: 'attendance_not_enabled' });
        }
        if (captureMode !== OFFLINE_WEB_CAPTURE_MODE && !assignment.canRegisterArrival && !assignment.arrivalReported) {
          return res.status(409).json({
            ok: false,
            error: 'arrival_window_not_open',
            opensAt: assignment.arrivalWindowOpensAt
          });
        }

        const latitude = requiredBodyNumber(req.body?.latitude, 'attendance_latitude', { min: -90, max: 90 });
        const longitude = requiredBodyNumber(req.body?.longitude, 'attendance_longitude', { min: -180, max: 180 });
        const accuracyMeters = requiredBodyNumber(req.body?.accuracyMeters, 'attendance_accuracy', { min: 0, max: 100_000 });
        const photoRequired = assignment.photoRequired === true;
        if (photoRequired && !req.file) {
          return res.status(400).json({ ok: false, error: 'selfie_required' });
        }
        if (req.file && req.body?.photoConsent !== 'true') {
          return res.status(400).json({ ok: false, error: 'photo_consent_required' });
        }

        const rawInstallationId = req.cookies?.[WORKER_PORTAL_INSTALLATION_COOKIE_NAME];
        if (!rawInstallationId) {
          return res.status(401).json({ ok: false, error: 'device_activation_required' });
        }
        const installationId = normalizeInstallationId(rawInstallationId);
        const installationIdHash = hashInstallationId(installationId, installationPepper);

        evidence = await storeArrivalEvidenceFn({
          workerId: session.workerId,
          assignmentId: assignment.id,
          idempotencyKey,
          file: req.file || null
        });

        const result = await registerArrivalFn(prisma, {
          assignmentId: assignment.id,
          expectedWorkerId: session.workerId,
          idempotencyKey,
          now,
          captureMode,
          clientCapturedAt,
          latitude,
          longitude,
          accuracyMeters,
          installationIdHash,
          persistentStorageAvailable: captureMode === OFFLINE_WEB_CAPTURE_MODE
            ? req.body?.persistentStorageAvailable === 'true'
            : true,
          hasFreshPhoto: Boolean(evidence?.storageKey),
          evidenceStorageKey: evidence?.storageKey || null,
          evidenceMimeType: evidence?.mimeType || null,
          ipAddress: requestIp(req),
          userAgent: requestUserAgent(req)
        });

        if (!result.recorded && evidence?.created) {
          await discardArrivalEvidenceFn(evidence).catch((cleanupError) => {
            console.warn('[WORKER_PORTAL_EVIDENCE_CLEANUP_FAILED]', { code: errorCode(cleanupError) });
          });
        }

        const publicResult = arrivalPublicResult(result);
        return res.status(publicResult.status).json(publicResult.payload);
      } catch (error) {
        const code = errorCode(error);
        if (isInvalidSessionCookie(error)) {
          clearWorkerPortalSessionCookie(res);
          return res.status(401).json({ ok: false, error: 'portal_session_required' });
        }
        if (isConfigurationError(error)) {
          console.error('[WORKER_PORTAL_ARRIVAL_CONFIGURATION_ERROR]', { code });
          return res.status(503).json({ ok: false, error: 'arrival_temporarily_unavailable' });
        }
        if (code === 'attendance_assignment_not_found') {
          return res.status(404).json({ ok: false, error: 'assignment_not_available' });
        }
        if (code === 'attendance_offline_capture_expired') {
          return res.status(409).json({ ok: false, error: 'offline_capture_expired' });
        }
        if (code === 'attendance_offline_capture_future_invalid') {
          return res.status(400).json({ ok: false, error: 'offline_capture_time_invalid' });
        }
        if (EXPECTED_ARRIVAL_INPUT_CODES.has(code) || code.endsWith('_invalid') || code.endsWith('_required')) {
          return res.status(400).json({ ok: false, error: 'arrival_request_invalid' });
        }
        console.error('[WORKER_PORTAL_ARRIVAL_ERROR]', { code });
        return res.status(500).json({ ok: false, error: 'arrival_failed' });
      }
    }
  );

  router.use('/asignaciones', workerPortalArrivalUploadErrorHandler);

  router.get('/', async (req, res) => {
    const nonce = createNonce(nonceBytesFn);
    applyWorkerPortalSecurityHeaders(res, nonce);

    try {
      const now = nowFn();
      if (!validDate(now)) throw new Error('worker_portal_resolution_now_invalid');
      const session = await resolveRequestSession(req, now);
      if (!session) {
        if (req.cookies?.[WORKER_PORTAL_SESSION_COOKIE_NAME]) clearWorkerPortalSessionCookie(res);
        return renderPortal(res, 'inactive', nonce);
      }
      const assignments = await loadAssignmentsFn(prisma, { workerId: session.workerId, now });
      return renderPortal(res, 'active', nonce, { expiresAt: session.expiresAt, assignments });
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
