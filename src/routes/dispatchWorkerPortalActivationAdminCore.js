import express from 'express';
import cookieParser from 'cookie-parser';
import { issuePrimaryDeviceActivation } from '../modules/dispatch-attendance/application/primaryDeviceActivation.js';
import { resolveWorkerPortalSession } from '../modules/dispatch-attendance/application/activateWorkerPortalSession.js';
import {
  loadWorkerPortalAssignmentForArrival,
  loadWorkerPortalAssignmentForMark
} from '../modules/dispatch-attendance/application/workerPortalAssignments.js';
import { createPrismaPrimaryDeviceActivationRepository } from '../modules/dispatch-attendance/infrastructure/prismaPrimaryDeviceActivationRepository.js';
import { createPrismaWorkerPortalSessionRepository } from '../modules/dispatch-attendance/infrastructure/prismaWorkerPortalSessionRepository.js';
import { WORKER_PORTAL_SESSION_COOKIE_NAME } from '../modules/dispatch-attendance/domain/workerPortalSessionPolicy.js';
import { buildWorkerPortalActivationUrl } from './workerPortal.js';
import {
  assessWorkerBiometric,
  enrollWorkerBiometric,
  getWorkerBiometricEnrollment,
  issueWorkerBiometricChallenge,
  loadWorkerBiometricStatusMap,
  revokeWorkerBiometric
} from '../services/workerBiometricService.js';

const ACTIVE_DISPATCH_WORKER_STATUS = 'CONTRATADO';
const DEFAULT_ACTIVATION_TTL_MINUTES = 30;
const ADMIN_REQUEST_HEADER = 'attendance-admin';
const WORKER_PORTAL_REQUEST_HEADER = 'worker-portal';
const BIOMETRIC_BODY_LIMIT = '256kb';

function normalizeString(value, maxLength = 500) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length ? normalized.slice(0, maxLength) : null;
}

function setNoStore(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

function currentRole(req) {
  return normalizeString(req.session?.userRole || req.userRole)?.toLowerCase();
}

function currentUsername(req) {
  return normalizeString(req.session?.username || req.username);
}

function canManagePortalActivations(req) {
  return currentRole(req) === 'dev' || req.canAccessAttendanceFeature === true;
}

function requireAttendancePermission(req, res, next) {
  setNoStore(res);
  if (!currentRole(req)) {
    if (req.method === 'GET') return res.redirect('/login');
    return res.status(401).json({ ok: false, error: 'authentication_required' });
  }
  if (!canManagePortalActivations(req)) {
    if (req.method === 'GET') {
      return res.status(403).send('No tienes permiso para gestionar activaciones del Portal del Auxiliar');
    }
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  return next();
}

function requireAdminJson(req, res, next) {
  if (req.get?.('x-requested-with') !== ADMIN_REQUEST_HEADER || !req.is?.('application/json')) {
    return res.status(400).json({ ok: false, error: 'activation_request_invalid' });
  }
  return next();
}

function requireWorkerPortalJson(req, res, next) {
  setNoStore(res);
  if (req.get?.('x-requested-with') !== WORKER_PORTAL_REQUEST_HEADER || !req.is?.('application/json')) {
    return res.status(400).json({ ok: false, error: 'biometric_request_invalid' });
  }
  return next();
}

function normalizeOriginCandidate(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  return normalized.includes('://') ? normalized : `https://${normalized}`;
}

export function resolveWorkerPortalPublicOrigin(env = process.env) {
  const explicit = normalizeOriginCandidate(env.ATTENDANCE_PORTAL_PUBLIC_ORIGIN);
  const railway = normalizeString(env.RAILWAY_PUBLIC_DOMAIN);
  const candidate = explicit || (railway ? `https://${railway}` : null);
  if (!candidate) throw new Error('attendance_portal_public_origin_required');

  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('attendance_portal_public_origin_invalid');
  }

  if (url.protocol !== 'https:') throw new Error('attendance_portal_public_origin_https_required');
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('attendance_portal_public_origin_invalid');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('attendance_portal_public_origin_path_not_allowed');
  }
  return url.origin;
}

function activationTtlMinutes(env = process.env) {
  const raw = normalizeString(env.ATTENDANCE_ACTIVATION_TTL_MINUTES);
  return raw ? Number(raw) : DEFAULT_ACTIVATION_TTL_MINUTES;
}

function safeErrorCode(error) {
  const candidate = typeof error?.message === 'string' ? error.message : 'unknown';
  return /^[A-Za-z0-9_]{1,100}$/.test(candidate) ? candidate : 'worker_portal_activation_admin_error';
}

function contractTypeLabel(value) {
  return normalizeString(value)?.toUpperCase() === 'CONTRATISTA' ? 'Contratista' : 'Directo';
}

function workerLabel(worker) {
  return `${worker.fullName} · ${contractTypeLabel(worker.contractType)}`;
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

async function loadActiveWorkers(prisma) {
  return prisma.dispatchWorker.findMany({
    where: { operationalStatus: ACTIVE_DISPATCH_WORKER_STATUS },
    select: {
      id: true,
      fullName: true,
      contractType: true,
      operationalStatus: true,
      isTestProfile: true
    },
    orderBy: { fullName: 'asc' }
  });
}

async function findActiveWorker(prisma, workerId) {
  return prisma.dispatchWorker.findFirst({
    where: {
      id: workerId,
      operationalStatus: ACTIVE_DISPATCH_WORKER_STATUS
    },
    select: {
      id: true,
      fullName: true,
      contractType: true,
      operationalStatus: true,
      isTestProfile: true
    }
  });
}

function emptyBiometricStatusMap(workerIds) {
  return new Map(workerIds.map((workerId) => [workerId, { enrolled: false }]));
}

export function dispatchWorkerPortalActivationAdminRouter(prisma, options = {}) {
  const router = express.Router();
  const issueActivationFn = options.issueActivationFn || issuePrimaryDeviceActivation;
  const repositoryFactory = options.repositoryFactory || (() => createPrismaPrimaryDeviceActivationRepository(prisma));
  const sessionRepositoryFactory = options.sessionRepositoryFactory || (() => createPrismaWorkerPortalSessionRepository(prisma));
  const buildActivationUrlFn = options.buildActivationUrlFn || buildWorkerPortalActivationUrl;
  const resolveOriginFn = options.resolveOriginFn || (() => resolveWorkerPortalPublicOrigin(options.env || process.env));
  const loadWorkersFn = options.loadWorkersFn || (() => loadActiveWorkers(prisma));
  const findWorkerFn = options.findWorkerFn || ((workerId) => findActiveWorker(prisma, workerId));
  const loadBiometricStatusMapFn = options.loadBiometricStatusMapFn || ((workerIds) => (
    prisma?.devAuditEvent
      ? loadWorkerBiometricStatusMap(prisma, workerIds)
      : emptyBiometricStatusMap(workerIds)
  ));
  const getEnrollmentFn = options.getEnrollmentFn || ((workerId) => getWorkerBiometricEnrollment(prisma, workerId, { env: options.env || process.env }));
  const assessBiometricFn = options.assessBiometricFn || ((input, assessmentOptions) => assessWorkerBiometric(prisma, input, assessmentOptions));
  const enrollBiometricFn = options.enrollBiometricFn || ((input, enrollmentOptions) => enrollWorkerBiometric(prisma, input, enrollmentOptions));
  const revokeBiometricFn = options.revokeBiometricFn || ((input, revocationOptions) => revokeWorkerBiometric(prisma, input, revocationOptions));
  const issueChallengeFn = options.issueChallengeFn || issueWorkerBiometricChallenge;
  const loadArrivalAssignmentFn = options.loadArrivalAssignmentFn || loadWorkerPortalAssignmentForArrival;
  const loadMarkAssignmentFn = options.loadMarkAssignmentFn || loadWorkerPortalAssignmentForMark;
  const resolvePortalSessionFn = options.resolvePortalSessionFn || resolveWorkerPortalSession;
  const nowFn = options.nowFn || (() => new Date());
  const ttlMinutes = options.ttlMinutes ?? activationTtlMinutes(options.env || process.env);
  const biometricJson = express.json({ limit: BIOMETRIC_BODY_LIMIT, strict: true, type: 'application/json' });
  let repository = options.repository || null;
  let sessionRepository = options.sessionRepository || null;

  function getRepository() {
    if (!repository) repository = repositoryFactory();
    if (!repository) throw new Error('activation_repository_unavailable');
    return repository;
  }

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
      if (!enrollment.enrolled || !enrollment.descriptor) {
        return res.status(200).json({ ok: true, enabled: false, enrolled: Boolean(enrollment.enrolled) });
      }
      const challenge = issueChallengeFn({
        workerId: portalSession.workerId,
        assignmentId: assignment.id,
        idempotencyKey,
        markType
      }, { now, env: options.env || process.env });
      return res.status(200).json({ ok: true, enabled: true, enrolled: true, challenge });
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
        decision: assessment.decision,
        verified: assessment.verified,
        requiresReview: assessment.decision !== 'VERIFIED'
      });
    } catch (error) {
      console.warn('[WORKER_BIOMETRIC_VERIFICATION_FAILED]', { code: safeErrorCode(error) });
      return res.status(400).json({ ok: false, error: 'biometric_verification_failed' });
    }
  });

  router.get('/', requireAttendancePermission, async (req, res) => {
    try {
      const workers = await loadWorkersFn();
      const statusMap = await loadBiometricStatusMapFn(workers.map((worker) => worker.id));
      return res.render('operacionesPortalActivaciones', {
        role: currentRole(req),
        workers: workers.map((worker) => ({
          id: worker.id,
          label: workerLabel(worker),
          fullName: worker.fullName,
          contractType: contractTypeLabel(worker.contractType),
          isTestProfile: Boolean(worker.isTestProfile),
          biometric: statusMap.get(worker.id) || { enrolled: false }
        })),
        defaultTtlMinutes: ttlMinutes
      });
    } catch (error) {
      console.error('[WORKER_PORTAL_ACTIVATION_ADMIN_LIST_FAILED]', { code: safeErrorCode(error) });
      return res.status(503).render('operacionesPortalActivaciones', {
        role: currentRole(req),
        workers: [],
        defaultTtlMinutes: ttlMinutes,
        loadError: 'No fue posible cargar el personal operativo.'
      });
    }
  });

  router.post('/emitir', requireAttendancePermission, requireAdminJson, async (req, res) => {
    const workerId = normalizeString(req.body?.workerId);
    if (!workerId) return res.status(400).json({ ok: false, error: 'worker_required' });

    try {
      const worker = await findWorkerFn(workerId);
      if (!worker) return res.status(404).json({ ok: false, error: 'worker_not_active' });

      const now = nowFn();
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new Error('activation_admin_now_invalid');
      }

      const activation = await issueActivationFn({
        repository: getRepository(),
        workerId: worker.id,
        createdByUsername: currentUsername(req),
        now,
        ttlMinutes
      });
      const activationUrl = buildActivationUrlFn(resolveOriginFn(), activation.rawToken);

      return res.status(201).json({
        ok: true,
        worker: {
          id: worker.id,
          fullName: worker.fullName,
          contractType: contractTypeLabel(worker.contractType),
          isTestProfile: Boolean(worker.isTestProfile)
        },
        activationUrl,
        expiresAt: activation.expiresAt.toISOString()
      });
    } catch (error) {
      const code = safeErrorCode(error);
      if (code === 'activation_worker_not_active') {
        return res.status(409).json({ ok: false, error: 'worker_not_active' });
      }
      if (code.startsWith('attendance_portal_public_origin_') || code.startsWith('activation_prisma_') || code === 'activation_repository_unavailable') {
        console.error('[WORKER_PORTAL_ACTIVATION_ADMIN_CONFIGURATION_FAILED]', { code });
        return res.status(503).json({ ok: false, error: 'activation_service_unavailable' });
      }
      console.error('[WORKER_PORTAL_ACTIVATION_ADMIN_FAILED]', { code });
      return res.status(500).json({ ok: false, error: 'activation_failed' });
    }
  });

  router.post('/biometria/registrar', requireAttendancePermission, requireAdminJson, biometricJson, async (req, res) => {
    try {
      const workerId = normalizeString(req.body?.workerId, 120);
      if (!workerId) return res.status(400).json({ ok: false, error: 'worker_required' });
      const worker = await findWorkerFn(workerId);
      if (!worker) return res.status(404).json({ ok: false, error: 'worker_not_active' });
      const result = await enrollBiometricFn({
        workerId,
        workerLabel: workerLabel(worker),
        descriptor: req.body?.descriptor,
        realScore: req.body?.realScore,
        liveScore: req.body?.liveScore,
        consentAccepted: req.body?.consentAccepted === true,
        actorUsername: currentUsername(req),
        actorRole: currentRole(req),
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req)
      }, { now: nowFn(), env: options.env || process.env });
      return res.status(201).json({ ok: true, ...result });
    } catch (error) {
      const code = safeErrorCode(error);
      console.warn('[WORKER_BIOMETRIC_ENROLLMENT_FAILED]', { code });
      return res.status(400).json({ ok: false, error: code });
    }
  });

  router.post('/biometria/revocar', requireAttendancePermission, requireAdminJson, biometricJson, async (req, res) => {
    try {
      const workerId = normalizeString(req.body?.workerId, 120);
      if (!workerId) return res.status(400).json({ ok: false, error: 'worker_required' });
      const worker = await findWorkerFn(workerId);
      if (!worker) return res.status(404).json({ ok: false, error: 'worker_not_active' });
      const result = await revokeBiometricFn({
        workerId,
        workerLabel: workerLabel(worker),
        actorUsername: currentUsername(req),
        actorRole: currentRole(req),
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req)
      }, { now: nowFn(), env: options.env || process.env });
      return res.status(200).json({ ok: true, ...result });
    } catch (error) {
      console.warn('[WORKER_BIOMETRIC_REVOCATION_FAILED]', { code: safeErrorCode(error) });
      return res.status(400).json({ ok: false, error: 'biometric_revocation_failed' });
    }
  });

  return router;
}

export const WORKER_PORTAL_ACTIVATION_ADMIN_HEADER = ADMIN_REQUEST_HEADER;
