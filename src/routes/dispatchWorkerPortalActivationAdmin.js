import express from 'express';
import cookieParser from 'cookie-parser';
import {
  dispatchWorkerPortalActivationAdminRouter as coreDispatchWorkerPortalActivationAdminRouter
} from './dispatchWorkerPortalActivationAdminCore.js';
import { resolveWorkerPortalSession } from '../modules/dispatch-attendance/application/activateWorkerPortalSession.js';
import {
  loadWorkerPortalAssignmentForArrival,
  loadWorkerPortalAssignmentForMark
} from '../modules/dispatch-attendance/application/workerPortalAssignments.js';
import { createPrismaWorkerPortalSessionRepository } from '../modules/dispatch-attendance/infrastructure/prismaWorkerPortalSessionRepository.js';
import { WORKER_PORTAL_SESSION_COOKIE_NAME } from '../modules/dispatch-attendance/domain/workerPortalSessionPolicy.js';
import {
  assessWorkerBiometric,
  enrollWorkerBiometric,
  getWorkerBiometricEnrollment,
  issueWorkerBiometricChallenge,
  WORKER_BIOMETRIC_ACTION,
  WORKER_BIOMETRIC_ENTITY_TYPE
} from '../services/workerBiometricService.js';

export * from './dispatchWorkerPortalActivationAdminCore.js';

const WORKER_PORTAL_REQUEST_HEADER = 'worker-portal';
const BIOMETRIC_BODY_LIMIT = '256kb';

function normalizeString(value, maxLength = 500) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function requestIp(req) {
  return normalizeString(req.ip, 120) || 'unknown';
}

function requestUserAgent(req) {
  return normalizeString(req.get?.('user-agent'), 500);
}

function normalizeMarkType(value) {
  const normalized = normalizeString(value, 40)?.toUpperCase();
  if (!['ARRIVAL', 'DEPARTURE'].includes(normalized)) {
    throw new Error('attendance_biometric_mark_type_invalid');
  }
  return normalized;
}

function safeErrorCode(error) {
  const candidate = typeof error?.message === 'string' ? error.message : 'unknown';
  return /^[A-Za-z0-9_]{1,100}$/.test(candidate) ? candidate : 'worker_biometric_error';
}

function setNoStore(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

function requireWorkerPortalJson(req, res, next) {
  setNoStore(res);
  if (req.get?.('x-requested-with') !== WORKER_PORTAL_REQUEST_HEADER || !req.is?.('application/json')) {
    return res.status(400).json({ ok: false, error: 'biometric_request_invalid' });
  }
  return next();
}

export function dispatchWorkerPortalActivationAdminRouter(prisma, options = {}) {
  const router = express.Router();
  const biometricJson = express.json({ limit: BIOMETRIC_BODY_LIMIT, strict: true, type: 'application/json' });
  const sessionRepositoryFactory = options.sessionRepositoryFactory
    || (() => createPrismaWorkerPortalSessionRepository(prisma));
  const resolvePortalSessionFn = options.resolvePortalSessionFn || resolveWorkerPortalSession;
  const loadArrivalAssignmentFn = options.loadArrivalAssignmentFn || loadWorkerPortalAssignmentForArrival;
  const loadMarkAssignmentFn = options.loadMarkAssignmentFn || loadWorkerPortalAssignmentForMark;
  const getEnrollmentFn = options.getEnrollmentFn
    || ((workerId) => getWorkerBiometricEnrollment(prisma, workerId, { env: options.env || process.env }));
  const enrollBiometricFn = options.enrollBiometricFn
    || ((input, enrollmentOptions) => enrollWorkerBiometric(prisma, input, enrollmentOptions));
  const assessBiometricFn = options.assessBiometricFn
    || ((input, assessmentOptions) => assessWorkerBiometric(prisma, input, assessmentOptions));
  const issueChallengeFn = options.issueChallengeFn || issueWorkerBiometricChallenge;
  const nowFn = options.nowFn || (() => new Date());
  let sessionRepository = options.sessionRepository || null;

  function getSessionRepository() {
    if (!sessionRepository) sessionRepository = sessionRepositoryFactory();
    if (!sessionRepository) throw new Error('worker_portal_repository_unavailable');
    return sessionRepository;
  }

  async function resolvePortalRequestSession(req, now) {
    const rawSessionToken = req.cookies?.[WORKER_PORTAL_SESSION_COOKIE_NAME];
    if (!rawSessionToken) return null;
    return resolvePortalSessionFn({ repository: getSessionRepository(), rawSessionToken, now });
  }

  async function loadBiometricAssignment(workerId, assignmentId, markType, now) {
    const loader = markType === 'ARRIVAL' ? loadArrivalAssignmentFn : loadMarkAssignmentFn;
    return loader(prisma, { workerId, assignmentId, now });
  }

  async function markEnrollmentAsWorkerPortal(workerId) {
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

  router.use(cookieParser());

  router.post('/biometria/desafio', requireWorkerPortalJson, biometricJson, async (req, res) => {
    try {
      const now = nowFn();
      const portalSession = await resolvePortalRequestSession(req, now);
      if (!portalSession) return res.status(401).json({ ok: false, error: 'portal_session_required' });
      const assignmentId = normalizeString(req.body?.assignmentId, 120);
      const idempotencyKey = normalizeString(req.body?.idempotencyKey, 120);
      const markType = normalizeMarkType(req.body?.markType);
      if (!assignmentId || !idempotencyKey) {
        return res.status(400).json({ ok: false, error: 'biometric_request_invalid' });
      }
      const assignment = await loadBiometricAssignment(portalSession.workerId, assignmentId, markType, now);
      if (!assignment || !assignment.attendanceEnabled) {
        return res.status(404).json({ ok: false, error: 'assignment_not_available' });
      }
      const enrollment = await getEnrollmentFn(portalSession.workerId);
      const challenge = issueChallengeFn({
        workerId: portalSession.workerId,
        assignmentId: assignment.id,
        idempotencyKey,
        markType
      }, { now, env: options.env || process.env });
      return res.status(200).json({
        ok: true,
        enabled: true,
        enrolled: Boolean(enrollment.enrolled && enrollment.descriptor),
        enrollmentRequired: !enrollment.enrolled || !enrollment.descriptor,
        challenge
      });
    } catch (error) {
      console.warn('[WORKER_BIOMETRIC_CHALLENGE_FAILED]', { code: safeErrorCode(error) });
      return res.status(400).json({ ok: false, error: 'biometric_challenge_failed' });
    }
  });

  router.post('/biometria/verificar', requireWorkerPortalJson, biometricJson, async (req, res) => {
    try {
      const now = nowFn();
      const portalSession = await resolvePortalRequestSession(req, now);
      if (!portalSession) return res.status(401).json({ ok: false, error: 'portal_session_required' });
      const assignmentId = normalizeString(req.body?.assignmentId, 120);
      const idempotencyKey = normalizeString(req.body?.idempotencyKey, 120);
      const markType = normalizeMarkType(req.body?.markType);
      if (!assignmentId || !idempotencyKey) {
        return res.status(400).json({ ok: false, error: 'biometric_request_invalid' });
      }
      const assignment = await loadBiometricAssignment(portalSession.workerId, assignmentId, markType, now);
      if (!assignment || !assignment.attendanceEnabled) {
        return res.status(404).json({ ok: false, error: 'assignment_not_available' });
      }

      let enrollment = await getEnrollmentFn(portalSession.workerId);
      let enrolledNow = false;
      if (!enrollment.enrolled || !enrollment.descriptor) {
        await enrollBiometricFn({
          workerId: portalSession.workerId,
          workerLabel: portalSession.workerId,
          descriptor: req.body?.descriptor,
          realScore: req.body?.realScore,
          liveScore: req.body?.liveScore,
          consentAccepted: req.body?.consentAccepted === true,
          actorUsername: `worker-portal:${portalSession.workerId}`,
          actorRole: 'worker',
          ipAddress: requestIp(req),
          userAgent: requestUserAgent(req)
        }, { now, env: options.env || process.env });
        await markEnrollmentAsWorkerPortal(portalSession.workerId);
        enrollment = await getEnrollmentFn(portalSession.workerId);
        enrolledNow = Boolean(enrollment.enrolled && enrollment.descriptor);
      }

      const assessment = await assessBiometricFn({
        workerId: portalSession.workerId,
        assignmentId: assignment.id,
        idempotencyKey,
        markType,
        challengeToken: req.body?.challengeToken,
        challengeAction: normalizeString(req.body?.challengeAction, 40),
        challengeCompleted: req.body?.challengeCompleted === true,
        descriptor: req.body?.descriptor,
        realScore: req.body?.realScore,
        liveScore: req.body?.liveScore,
        modelVersion: normalizeString(req.body?.modelVersion, 100),
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req)
      }, { now, env: options.env || process.env });

      return res.status(200).json({
        ok: true,
        enrolledNow,
        decision: assessment.decision,
        verified: assessment.verified,
        requiresReview: assessment.decision !== 'VERIFIED'
      });
    } catch (error) {
      const code = safeErrorCode(error);
      console.warn('[WORKER_BIOMETRIC_VERIFICATION_FAILED]', { code });
      return res.status(400).json({ ok: false, error: code });
    }
  });

  router.post('/biometria/registrar', biometricJson, (_req, res) => {
    setNoStore(res);
    return res.status(410).json({
      ok: false,
      error: 'biometric_enrollment_moved_to_worker_portal'
    });
  });

  router.use(coreDispatchWorkerPortalActivationAdminRouter(prisma, {
    ...options,
    sessionRepository: getSessionRepository()
  }));
  return router;
}
