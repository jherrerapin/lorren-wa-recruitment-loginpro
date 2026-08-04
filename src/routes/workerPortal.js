import express from 'express';
import multer from 'multer';
import { workerPortalRouter as coreWorkerPortalRouter, applyWorkerPortalSecurityHeaders } from './workerPortalCore.js';
import { createWorkerPortalSessionHandoffRouter } from './workerPortalSessionHandoff.js';
import { resolveWorkerPortalSession } from '../modules/dispatch-attendance/application/activateWorkerPortalSession.js';
import { createPrismaWorkerPortalSessionRepository } from '../modules/dispatch-attendance/infrastructure/prismaWorkerPortalSessionRepository.js';
import { WORKER_PORTAL_SESSION_COOKIE_NAME } from '../modules/dispatch-attendance/domain/workerPortalSessionPolicy.js';
import {
  calculateAttendanceDistanceMeters,
  isAttendanceInsideGeofence
} from '../modules/dispatch-attendance/domain/attendanceDistance.js';
import { ACTIVE_DISPATCH_ASSIGNMENT_STATUSES } from '../modules/dispatch-attendance/application/registerArrival.js';
import { MAX_ATTENDANCE_EVIDENCE_BYTES } from '../services/attendanceEvidenceStorage.js';
import {
  ATTENDANCE_BIOMETRIC_ENTITY_TYPE,
  WORKER_BIOMETRIC_ACTION,
  WORKER_BIOMETRIC_ENTITY_TYPE,
  WORKER_BIOMETRIC_EVIDENCE_VERSION,
  assertWorkerBiometricAttemptAllowed,
  assessWorkerBiometric,
  enrollWorkerBiometric,
  getWorkerBiometricEnrollment,
  isWorkerBiometricVerificationUsable,
  issueWorkerBiometricChallenge
} from '../services/workerBiometricService.js';

export * from './workerPortalCore.js';

const HUMAN_CDN_ORIGIN = 'https://cdn.jsdelivr.net';
const WORKER_PORTAL_REQUEST_HEADER = 'worker-portal';
const ONLINE_WEB_CAPTURE_MODE = 'ONLINE_WEB';
const OFFLINE_WEB_CAPTURE_MODE = 'OFFLINE_WEB';
const BIOMETRIC_MARK_TYPES = new Set(['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE']);

function markTypeFromPath(pathname = '') {
  if (pathname.endsWith('/llegada')) return 'ARRIVAL';
  if (pathname.endsWith('/salida')) return 'DEPARTURE';
  if (pathname.endsWith('/inicio-almuerzo')) return 'BREAK_START';
  if (pathname.endsWith('/fin-almuerzo')) return 'BREAK_END';
  return null;
}

function finiteNumber(value, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function normalizedString(value, maxLength = 160) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizeBiometricMarkType(value) {
  const markType = normalizedString(value, 40)?.toUpperCase();
  if (!BIOMETRIC_MARK_TYPES.has(markType)) throw new Error('attendance_biometric_mark_type_invalid');
  return markType;
}

function strictError(res, status, error, message) {
  applyWorkerPortalSecurityHeaders(res);
  return res.status(status).json({ ok: false, error, message });
}

function setBiometricRetryAfter(res, error) {
  const seconds = Number(error?.retryAfterSeconds || 0);
  if (Number.isFinite(seconds) && seconds > 0) res.set('Retry-After', String(Math.ceil(seconds)));
}

function hasCurrentBiometricEnrollment(enrollment) {
  return Boolean(
    enrollment?.enrolled
    && enrollment?.descriptor
    && Number(enrollment.evidenceVersion) === WORKER_BIOMETRIC_EVIDENCE_VERSION
  );
}

function verifiedBiometricMetadata(metadata, expected, now) {
  return isWorkerBiometricVerificationUsable(metadata, expected, now);
}

function expandBiometricCsp(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace('script-src ', `script-src ${HUMAN_CDN_ORIGIN} `)
    .replace("connect-src 'self'", `connect-src 'self' ${HUMAN_CDN_ORIGIN}`);
}

function installBiometricCspBridge(_req, res, next) {
  const originalSet = res.set.bind(res);
  res.set = (field, value) => {
    if (typeof field === 'string' && field.toLowerCase() === 'content-security-policy') {
      return originalSet(field, expandBiometricCsp(value));
    }
    if (field && typeof field === 'object' && !Array.isArray(field)) {
      const headers = { ...field };
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'content-security-policy') headers[key] = expandBiometricCsp(headers[key]);
      }
      return originalSet(headers);
    }
    return originalSet(field, value);
  };
  return next();
}

function usesInjectedAttendanceCore(options = {}) {
  return [options.registerArrivalFn, options.registerDepartureFn, options.registerBreakFn]
    .some((candidate) => typeof candidate === 'function');
}

function biometricPublicError(error) {
  const code = typeof error?.message === 'string' ? error.message : 'worker_biometric_error';
  if (code === 'attendance_biometric_rate_limited') return [429, code];
  if (code === 'attendance_biometric_consent_required') return [400, code];
  if (
    code === 'attendance_biometric_antispoof_low'
    || code === 'attendance_biometric_liveness_low'
    || code === 'attendance_biometric_samples_inconsistent'
  ) return [422, code];
  if (code === 'attendance_biometric_secret_required') return [503, 'biometric_temporarily_unavailable'];
  return [400, /^[A-Za-z0-9_]{1,100}$/.test(code) ? code : 'worker_biometric_error'];
}

export function workerPortalRouter(prisma, options = {}) {
  const repositoryFactory = options.repositoryFactory || (() => createPrismaWorkerPortalSessionRepository(prisma));
  const resolveSessionFn = options.resolveSessionFn || resolveWorkerPortalSession;
  const nowFn = options.nowFn || (() => new Date());
  const injectedCore = usesInjectedAttendanceCore(options);
  const getEnrollmentFn = options.getEnrollmentFn
    || ((workerId) => getWorkerBiometricEnrollment(prisma, workerId, { env: options.env || process.env }));
  const enrollBiometricFn = options.enrollBiometricFn
    || ((input, enrollmentOptions) => enrollWorkerBiometric(prisma, input, enrollmentOptions));
  const assessBiometricFn = options.assessBiometricFn
    || ((input, assessmentOptions) => assessWorkerBiometric(prisma, input, assessmentOptions));
  const issueChallengeFn = options.issueChallengeFn || issueWorkerBiometricChallenge;
  const assertAttemptAllowedFn = options.assertAttemptAllowedFn
    || ((input, attemptOptions) => assertWorkerBiometricAttemptAllowed(prisma, input, attemptOptions));
  const loadBiometricAssignmentFn = options.loadBiometricAssignmentFn || (async (workerId, assignmentId) => (
    prisma.dispatchAssignment.findFirst({
      where: {
        id: assignmentId,
        workerId,
        status: { in: [...ACTIVE_DISPATCH_ASSIGNMENT_STATUSES] }
      },
      include: { serviceRequest: { include: { operationPoint: true } } }
    })
  ));
  let repository = options.repository || null;

  const markUpload = options.strictMarkUpload || options.markUpload || options.arrivalUpload || multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTENDANCE_EVIDENCE_BYTES, files: 1, fields: 12, fieldSize: 4 * 1024 }
  }).single('selfie');
  const biometricJson = express.json({ limit: '512kb', strict: true, type: 'application/json' });

  function getRepository() {
    if (!repository) repository = repositoryFactory();
    if (!repository) throw new Error('worker_portal_repository_unavailable');
    return repository;
  }

  async function resolvePortalSession(req, now) {
    const rawSessionToken = req.cookies?.[WORKER_PORTAL_SESSION_COOKIE_NAME];
    if (!rawSessionToken) return null;
    return resolveSessionFn({ repository: getRepository(), rawSessionToken, now });
  }

  function requirePortalRequest(req, res) {
    applyWorkerPortalSecurityHeaders(res);
    if (req.get?.('x-requested-with') !== WORKER_PORTAL_REQUEST_HEADER) {
      strictError(res, 400, 'biometric_request_invalid', 'Solicitud biométrica inválida.');
      return false;
    }
    return true;
  }

  async function requireBiometricAssignment(req, res, portalSession, now) {
    const assignmentId = normalizedString(req.body?.assignmentId, 120);
    const idempotencyKey = normalizedString(req.body?.idempotencyKey, 120);
    let markType;
    try {
      markType = normalizeBiometricMarkType(req.body?.markType);
    } catch {
      strictError(res, 400, 'biometric_request_invalid', 'Solicitud biométrica inválida.');
      return null;
    }
    if (!assignmentId || !idempotencyKey) {
      strictError(res, 400, 'biometric_request_invalid', 'Solicitud biométrica inválida.');
      return null;
    }
    const assignment = await loadBiometricAssignmentFn(portalSession.workerId, assignmentId, now);
    if (!assignment || assignment.serviceRequest?.operationPoint?.attendanceEnabled !== true) {
      strictError(res, 404, 'assignment_not_available', 'La operación no está disponible para validar el rostro.');
      return null;
    }
    return { assignment, assignmentId: assignment.id, idempotencyKey, markType };
  }

  async function markLatestEnrollmentAsWorkerPortal(workerId) {
    const event = await prisma.devAuditEvent.findFirst({
      where: {
        entityType: WORKER_BIOMETRIC_ENTITY_TYPE,
        entityId: workerId,
        action: WORKER_BIOMETRIC_ACTION.ENROLLED
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true }
    });
    if (!event) return;
    await prisma.devAuditEvent.update({
      where: { id: event.id },
      data: { actorSource: 'worker-portal', actorRole: 'worker' }
    });
  }

  function consumeVerifiedAssessmentAfterSuccess(res, event, now) {
    if (!event?.id || !event?.metadata || typeof prisma.devAuditEvent?.update !== 'function') return;
    res.once('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      prisma.devAuditEvent.update({
        where: { id: event.id },
        data: {
          metadata: {
            ...event.metadata,
            consumedAt: new Date(Math.max(Date.now(), now.getTime())).toISOString()
          }
        }
      }).catch((error) => {
        console.error('[WORKER_PORTAL_BIOMETRIC_CONSUME_FAILED]', {
          code: typeof error?.message === 'string' ? error.message : 'unknown'
        });
      });
    });
  }

  async function strictMarkGuard(req, res, next) {
    try {
      applyWorkerPortalSecurityHeaders(res);
      if (req.get?.('x-requested-with') !== WORKER_PORTAL_REQUEST_HEADER) {
        return strictError(res, 400, 'mark_request_invalid', 'Solicitud de marcación inválida.');
      }

      const now = nowFn();
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new Error('worker_portal_strict_now_invalid');
      }

      const portalSession = await resolvePortalSession(req, now);
      if (!portalSession) return strictError(res, 401, 'portal_session_required', 'Tu sesión del portal venció.');

      const markType = markTypeFromPath(req.path);
      const idempotencyKey = normalizedString(req.body?.idempotencyKey, 120);
      const latitude = finiteNumber(req.body?.latitude, { min: -90, max: 90 });
      const longitude = finiteNumber(req.body?.longitude, { min: -180, max: 180 });
      const accuracyMeters = finiteNumber(req.body?.accuracyMeters, { min: 0, max: 100_000 });
      const captureMode = normalizedString(req.body?.captureMode, 40)?.toUpperCase();
      if (
        !markType
        || !idempotencyKey
        || latitude === null
        || longitude === null
        || accuracyMeters === null
        || ![ONLINE_WEB_CAPTURE_MODE, OFFLINE_WEB_CAPTURE_MODE].includes(captureMode)
      ) {
        return strictError(res, 400, 'mark_request_invalid', 'No fue posible validar la ubicación o el modo de captura.');
      }

      const assignment = await prisma.dispatchAssignment.findFirst({
        where: {
          id: req.params.assignmentId,
          workerId: portalSession.workerId,
          status: { in: [...ACTIVE_DISPATCH_ASSIGNMENT_STATUSES] }
        },
        include: { serviceRequest: { include: { operationPoint: true } } }
      });
      if (!assignment || assignment.serviceRequest?.operationPoint?.attendanceEnabled !== true) {
        return strictError(res, 409, 'assignment_not_available', 'La operación no está disponible para marcar asistencia.');
      }

      const point = assignment.serviceRequest.operationPoint;
      const pointLatitude = finiteNumber(point.attendanceLatitude, { min: -90, max: 90 });
      const pointLongitude = finiteNumber(point.attendanceLongitude, { min: -180, max: 180 });
      const radiusMeters = finiteNumber(point.geofenceRadiusMeters, { min: 1, max: 100_000 });
      if (pointLatitude === null || pointLongitude === null || radiusMeters === null) {
        return strictError(res, 409, 'operation_geofence_required', 'La operación no tiene una geocerca válida configurada.');
      }

      const maxAccuracyMeters = finiteNumber(point.maxLocationAccuracyMeters, { min: 1, max: 100_000 }) ?? 100;
      if (accuracyMeters > maxAccuracyMeters) {
        return strictError(res, 409, 'location_accuracy_insufficient', 'La precisión del GPS no es suficiente. Intenta nuevamente al aire libre.');
      }

      const distanceMeters = calculateAttendanceDistanceMeters(
        { latitude: pointLatitude, longitude: pointLongitude },
        { latitude, longitude }
      );
      if (isAttendanceInsideGeofence(distanceMeters, radiusMeters) !== true) {
        return strictError(res, 409, 'outside_operation_range', 'Debes estar dentro del rango de la operación para marcar asistencia.');
      }

      if (BIOMETRIC_MARK_TYPES.has(markType) && captureMode === ONLINE_WEB_CAPTURE_MODE) {
        const event = await prisma.devAuditEvent.findFirst({
          where: {
            entityType: ATTENDANCE_BIOMETRIC_ENTITY_TYPE,
            entityId: idempotencyKey,
            action: WORKER_BIOMETRIC_ACTION.ASSESSED
          },
          orderBy: { createdAt: 'desc' }
        });
        if (!verifiedBiometricMetadata(event?.metadata, {
          workerId: portalSession.workerId,
          assignmentId: assignment.id,
          markType,
          idempotencyKey
        }, now)) {
          return strictError(res, 409, 'biometric_verification_required', 'La validación facial venció, ya fue utilizada o no corresponde a esta marcación.');
        }
        consumeVerifiedAssessmentAfterSuccess(res, event, now);
      }

      if (BIOMETRIC_MARK_TYPES.has(markType) && captureMode === OFFLINE_WEB_CAPTURE_MODE) {
        const clientCapturedAt = new Date(req.body?.clientCapturedAt);
        if (Number.isNaN(clientCapturedAt.getTime())) {
          return strictError(res, 400, 'mark_request_invalid', 'La hora de la marcación sin conexión no es válida.');
        }
      }

      req.lorrenStrictAttendance = {
        workerId: portalSession.workerId,
        markType,
        captureMode,
        distanceMeters,
        insideGeofence: true,
        requiresReview: captureMode === OFFLINE_WEB_CAPTURE_MODE
      };
      return next();
    } catch (error) {
      console.error('[WORKER_PORTAL_STRICT_MARK_GUARD_FAILED]', {
        code: typeof error?.message === 'string' ? error.message : 'unknown'
      });
      return strictError(res, 503, 'mark_temporarily_unavailable', 'No fue posible validar la marcación en este momento.');
    }
  }

  function strictMarkMiddleware(req, res, next) {
    return markUpload(req, res, (error) => {
      if (error) return next(error);
      return strictMarkGuard(req, res, next);
    });
  }

  const coreRouter = coreWorkerPortalRouter(prisma, injectedCore ? {
    ...options,
    repository: getRepository()
  } : {
    ...options,
    repository: getRepository(),
    markUpload: strictMarkMiddleware,
    arrivalUpload: undefined
  });

  const router = express.Router();
  router.use(installBiometricCspBridge);
  router.use(coreRouter);

  router.post('/biometria/estado', biometricJson, async (req, res) => {
    if (!requirePortalRequest(req, res)) return;
    try {
      const now = nowFn();
      const portalSession = await resolvePortalSession(req, now);
      if (!portalSession) return strictError(res, 401, 'portal_session_required', 'Tu sesión del portal venció.');
      const enrollment = await getEnrollmentFn(portalSession.workerId);
      const enrolled = hasCurrentBiometricEnrollment(enrollment);
      return res.status(200).json({
        ok: true,
        enrolled,
        registrationRequired: !enrolled,
        upgradeRequired: Boolean(enrollment?.enrolled && !enrolled)
      });
    } catch (error) {
      console.error('[WORKER_PORTAL_BIOMETRIC_STATUS_FAILED]', {
        code: typeof error?.message === 'string' ? error.message : 'unknown'
      });
      return strictError(res, 503, 'biometric_temporarily_unavailable', 'No fue posible consultar el registro facial.');
    }
  });

  router.post('/biometria/registrar', biometricJson, async (req, res) => {
    if (!requirePortalRequest(req, res)) return;
    try {
      const now = nowFn();
      const portalSession = await resolvePortalSession(req, now);
      if (!portalSession) return strictError(res, 401, 'portal_session_required', 'Tu sesión del portal venció.');
      const current = await getEnrollmentFn(portalSession.workerId);
      if (hasCurrentBiometricEnrollment(current)) {
        return res.status(200).json({ ok: true, enrolled: true, alreadyEnrolled: true });
      }
      const result = await enrollBiometricFn({
        workerId: portalSession.workerId,
        workerLabel: portalSession.workerId,
        evidenceVersion: WORKER_BIOMETRIC_EVIDENCE_VERSION,
        descriptor: req.body?.descriptor,
        sampleDescriptors: req.body?.sampleDescriptors,
        sampleRealScores: req.body?.sampleRealScores,
        sampleLiveScores: req.body?.sampleLiveScores,
        captureDurationMs: req.body?.captureDurationMs,
        realScore: req.body?.realScore,
        liveScore: req.body?.liveScore,
        modelVersion: normalizedString(req.body?.modelVersion, 100),
        consentAccepted: req.body?.consentAccepted === true,
        actorUsername: `worker-portal:${portalSession.workerId}`,
        actorRole: 'worker',
        ipAddress: normalizedString(req.ip, 120),
        userAgent: normalizedString(req.get?.('user-agent'), 500)
      }, { now, env: options.env || process.env });
      await markLatestEnrollmentAsWorkerPortal(portalSession.workerId);
      return res.status(201).json({
        ok: true,
        enrolled: true,
        upgraded: Boolean(current?.enrolled),
        enrolledAt: result.enrolledAt
      });
    } catch (error) {
      const [status, code] = biometricPublicError(error);
      setBiometricRetryAfter(res, error);
      return strictError(res, status, code, 'No fue posible completar el registro facial.');
    }
  });

  router.post('/biometria/desafio', biometricJson, async (req, res) => {
    if (!requirePortalRequest(req, res)) return;
    try {
      const now = nowFn();
      const portalSession = await resolvePortalSession(req, now);
      if (!portalSession) return strictError(res, 401, 'portal_session_required', 'Tu sesión del portal venció.');
      const context = await requireBiometricAssignment(req, res, portalSession, now);
      if (!context) return;
      const enrollment = await getEnrollmentFn(portalSession.workerId);
      if (!hasCurrentBiometricEnrollment(enrollment)) {
        return strictError(res, 409, 'biometric_enrollment_required', 'Debes renovar el registro facial antes de marcar.');
      }
      await assertAttemptAllowedFn({
        workerId: portalSession.workerId,
        assignmentId: context.assignmentId,
        markType: context.markType
      }, { now });
      const challenge = issueChallengeFn({
        workerId: portalSession.workerId,
        assignmentId: context.assignmentId,
        idempotencyKey: context.idempotencyKey,
        markType: context.markType
      }, { now, env: options.env || process.env });
      return res.status(200).json({ ok: true, challenge });
    } catch (error) {
      const [status, code] = biometricPublicError(error);
      setBiometricRetryAfter(res, error);
      console.warn('[WORKER_PORTAL_BIOMETRIC_CHALLENGE_FAILED]', { code });
      return strictError(res, status, code, 'No fue posible iniciar la validación facial.');
    }
  });

  router.post('/biometria/verificar', biometricJson, async (req, res) => {
    if (!requirePortalRequest(req, res)) return;
    try {
      const now = nowFn();
      const portalSession = await resolvePortalSession(req, now);
      if (!portalSession) return strictError(res, 401, 'portal_session_required', 'Tu sesión del portal venció.');
      const context = await requireBiometricAssignment(req, res, portalSession, now);
      if (!context) return;
      const enrollment = await getEnrollmentFn(portalSession.workerId);
      if (!hasCurrentBiometricEnrollment(enrollment)) {
        return strictError(res, 409, 'biometric_enrollment_required', 'Debes renovar el registro facial antes de marcar.');
      }
      const assessment = await assessBiometricFn({
        workerId: portalSession.workerId,
        assignmentId: context.assignmentId,
        idempotencyKey: context.idempotencyKey,
        markType: context.markType,
        evidenceVersion: WORKER_BIOMETRIC_EVIDENCE_VERSION,
        challengeToken: req.body?.challengeToken,
        challengeAction: normalizedString(req.body?.challengeAction, 40),
        challengeCompleted: req.body?.challengeCompleted === true,
        challengeEvidence: req.body?.challengeEvidence,
        descriptor: req.body?.descriptor,
        sampleDescriptors: req.body?.sampleDescriptors,
        sampleRealScores: req.body?.sampleRealScores,
        sampleLiveScores: req.body?.sampleLiveScores,
        realScore: req.body?.realScore,
        liveScore: req.body?.liveScore,
        modelVersion: normalizedString(req.body?.modelVersion, 100),
        ipAddress: normalizedString(req.ip, 120),
        userAgent: normalizedString(req.get?.('user-agent'), 500)
      }, { now, env: options.env || process.env });
      if (!assessment?.verified) {
        return res.status(422).json({
          ok: false,
          error: 'biometric_verification_rejected',
          verified: false,
          requiresReview: false,
          riskFlags: assessment?.riskFlags || []
        });
      }
      return res.status(200).json({
        ok: true,
        decision: assessment.decision,
        verified: true,
        validUntil: assessment.validUntil,
        requiresReview: false
      });
    } catch (error) {
      const [status, code] = biometricPublicError(error);
      setBiometricRetryAfter(res, error);
      console.warn('[WORKER_PORTAL_BIOMETRIC_VERIFICATION_FAILED]', { code });
      return strictError(res, status, code, 'No fue posible completar la validación facial.');
    }
  });

  router.use('/sesion-transferencia', createWorkerPortalSessionHandoffRouter(prisma, {
    repository: getRepository(),
    resolveSessionFn,
    nowFn,
    env: options.env || process.env,
    secret: options.handoffSecret ?? options.installationPepper,
    ttlMs: options.handoffTtlMs,
    randomBytesFn: options.handoffRandomBytesFn,
    rotateSessionTokenFn: options.rotateSessionTokenFn
  }));

  return router;
}
