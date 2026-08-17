import { createHash } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { workerPortalRouter as coreWorkerPortalRouter, applyWorkerPortalSecurityHeaders } from './workerPortalCore.js';
import { createWorkerPortalSessionHandoffRouter } from './workerPortalSessionHandoff.js';
import { resolveWorkerPortalSession } from '../modules/dispatch-attendance/application/activateWorkerPortalSession.js';
import { createPrismaWorkerPortalSessionRepository } from '../modules/dispatch-attendance/infrastructure/prismaWorkerPortalSessionRepository.js';
import { WORKER_PORTAL_SESSION_COOKIE_NAME } from '../modules/dispatch-attendance/domain/workerPortalSessionPolicy.js';
import { resolveAttendanceOperationGeofence } from '../modules/dispatch-attendance/application/attendanceGeofenceResolver.js';
import { ACTIVE_DISPATCH_ASSIGNMENT_STATUSES } from '../modules/dispatch-attendance/application/registerArrival.js';
import { registerCrewArrivalForLeader } from '../modules/dispatch-attendance/application/registerCrewArrival.js';
import {
  issueCrewPresenceCredential,
  verifyCrewPresenceBundle,
  verifyNativeAttendanceLocationProof
} from '../modules/dispatch-attendance/application/crewPresenceCredential.js';
import {
  CREW_BLUETOOTH_OPERATION_CHARACTERISTIC_UUID,
  CREW_BLUETOOTH_SERVICE_UUID,
  loadCrewAttendancePortalContexts
} from '../modules/dispatch-attendance/application/crewAttendanceConfig.js';
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
const NATIVE_ANDROID_USER_AGENT_TOKEN = 'LorrenNative/1';
const ONLINE_WEB_CAPTURE_MODE = 'ONLINE_WEB';
const OFFLINE_WEB_CAPTURE_MODE = 'OFFLINE_WEB';
const BIOMETRIC_MARK_TYPES = new Set(['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE']);
const CREW_PHONE_EXCEPTION_ENTITY_TYPE = 'DISPATCH_CREW_PHONE_EXCEPTION';
const CREW_PHONE_EXCEPTION_ACTION = 'CREW_PHONE_EXCEPTION_DECLARED';
const CREW_PHONE_EXCEPTION_REASON = 'NO_PHONE_AVAILABLE';

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

function isNativeAndroidRequest(req) {
  const userAgent = req.get?.('user-agent');
  return typeof userAgent === 'string' && userAgent.includes(NATIVE_ANDROID_USER_AGENT_TOKEN);
}

function parseNativeAttendanceLocationProof(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim() || value.length > 16_384) {
    throw new Error('attendance_native_location_required');
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    return parsed;
  } catch {
    throw new Error('attendance_native_location_invalid');
  }
}

function nativeAttendanceLocationPublicError(error) {
  const code = typeof error?.message === 'string' ? error.message : 'attendance_native_location_invalid';
  if (code === 'crew_presence_secret_required') {
    return [503, 'native_location_temporarily_unavailable', 'No fue posible validar la ubicación nativa en este momento.'];
  }
  if (code === 'attendance_mock_location_detected') {
    return [409, code, 'Android detectó una ubicación simulada. Desactiva la ubicación de prueba antes de marcar.'];
  }
  if (code === 'attendance_native_location_time_mismatch') {
    return [409, code, 'La ubicación nativa venció. Actualiza la ubicación e intenta nuevamente.'];
  }
  if (code === 'attendance_native_location_required') {
    return [400, code, 'La app necesita una ubicación nativa válida para esta marcación.'];
  }
  return [409, /^[A-Za-z0-9_]{1,100}$/.test(code) ? code : 'attendance_native_location_invalid', 'No fue posible validar la ubicación firmada de este teléfono.'];
}

function crewPhoneExceptionAuditId(idempotencyKey, assignmentId) {
  const digest = createHash('sha256')
    .update(`${idempotencyKey}:${assignmentId}`)
    .digest('hex')
    .slice(0, 48);
  return `crew_phone_${digest}`;
}

async function auditCrewPhoneException(prisma, input = {}) {
  if (!prisma?.devAuditEvent || typeof prisma.devAuditEvent.upsert !== 'function') {
    throw new Error('crew_phone_exception_audit_contract_invalid');
  }
  const id = crewPhoneExceptionAuditId(input.idempotencyKey, input.assignmentId);
  try {
    return await prisma.devAuditEvent.upsert({
      where: { id },
      update: {},
      create: {
        id,
        entityType: CREW_PHONE_EXCEPTION_ENTITY_TYPE,
        entityId: input.assignmentId,
        entityLabel: `assignment:${input.assignmentId}`,
        action: CREW_PHONE_EXCEPTION_ACTION,
        actorUsername: `worker-portal:${input.leaderWorkerId}`,
        actorRole: 'crew-leader',
        actorSource: 'worker-portal',
        ipAddress: input.ipAddress || null,
        userAgent: input.userAgent || null,
        metadata: {
          serviceRequestId: input.serviceRequestId,
          assignmentId: input.assignmentId,
          workerId: input.workerId,
          leaderWorkerId: input.leaderWorkerId,
          attemptId: input.idempotencyKey,
          reason: CREW_PHONE_EXCEPTION_REASON,
          declaredAt: input.clientCapturedAt.toISOString(),
          reviewRequired: true
        }
      }
    });
  } catch (error) {
    if (error?.message === 'crew_phone_exception_audit_contract_invalid') throw error;
    throw new Error('crew_phone_exception_audit_failed');
  }
}

function strictError(res, status, error, message) {
  applyWorkerPortalSecurityHeaders(res);
  return res.status(status).json({ ok: false, error, message });
}

async function requireStrictAttendanceLocation(prisma, res, point, input = {}, options = {}) {
  const latitude = finiteNumber(input.latitude, { min: -90, max: 90 });
  const longitude = finiteNumber(input.longitude, { min: -180, max: 180 });
  const accuracyMeters = finiteNumber(input.accuracyMeters, { min: 0, max: 100_000 });
  if (latitude === null || longitude === null || accuracyMeters === null) {
    strictError(res, 400, 'mark_request_invalid', 'No fue posible validar la ubicación.');
    return null;
  }

  const resolved = await resolveAttendanceOperationGeofence(
    prisma,
    point,
    { latitude, longitude, accuracyMeters },
    options
  );
  if (resolved.accepted !== true) {
    const publicError = {
      attendance_operation_geofence_required: [
        409,
        'operation_geofence_required',
        'La operación no tiene una geocerca válida configurada.'
      ],
      attendance_location_accuracy_insufficient: [
        409,
        'location_accuracy_insufficient',
        'La precisión del GPS no es suficiente. Intenta nuevamente al aire libre.'
      ],
      attendance_outside_operation_range: [
        409,
        'outside_operation_range',
        'Debes estar dentro del rango de una operación registrada para marcar asistencia.'
      ],
      attendance_location_required: [
        400,
        'mark_request_invalid',
        'No fue posible validar la ubicación.'
      ]
    }[resolved.errorCode] || [409, 'outside_operation_range', 'No fue posible validar una operación registrada para esta marcación.'];
    strictError(res, publicError[0], publicError[1], publicError[2]);
    return null;
  }

  return {
    latitude,
    longitude,
    accuracyMeters,
    distanceMeters: resolved.distanceMeters,
    operationPointId: resolved.operationPointId,
    crossOperation: resolved.crossOperation === true
  };
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

function crewPresencePublicError(error) {
  const code = typeof error?.message === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(error.message)
    ? error.message
    : 'crew_presence_error';
  if (
    code === 'crew_presence_secret_required'
    || code === 'crew_phone_exception_audit_failed'
    || code.endsWith('_contract_invalid')
  ) return [503, 'crew_presence_temporarily_unavailable'];
  if (code === 'attendance_offline_capture_expired') return [409, 'offline_capture_expired'];
  if (code === 'attendance_offline_capture_future_invalid') return [409, 'offline_capture_future_invalid'];
  if (
    code === 'crew_presence_leader_not_available'
    || code === 'crew_presence_leader_not_assigned'
    || code === 'crew_presence_leader_device_inactive'
    || code === 'crew_presence_service_request_mismatch'
    || code === 'crew_presence_attempt_mismatch'
    || code === 'crew_presence_native_location_required'
    || code === 'crew_presence_native_location_time_mismatch'
    || code === 'crew_presence_mock_location_detected'
    || code === 'crew_group_arrival_leader_presence_required'
  ) return [409, code];
  return [400, code];
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
  const loadCrewPortalContextsFn = options.loadCrewPortalContextsFn
    || ((input) => loadCrewAttendancePortalContexts(prisma, input));
  const issueCrewPresenceCredentialFn = options.issueCrewPresenceCredentialFn || issueCrewPresenceCredential;
  const verifyCrewPresenceBundleFn = options.verifyCrewPresenceBundleFn
    || ((input, verifyOptions) => verifyCrewPresenceBundle(prisma, input, verifyOptions));
  const verifyNativeAttendanceLocationProofFn = options.verifyNativeAttendanceLocationProofFn
    || ((input, verifyOptions) => verifyNativeAttendanceLocationProof(input, verifyOptions));
  const registerCrewPresenceArrivalFn = options.registerCrewPresenceArrivalFn
    || ((input) => registerCrewArrivalForLeader(prisma, input));
  const auditCrewPhoneExceptionFn = options.auditCrewPhoneExceptionFn
    || ((input) => auditCrewPhoneException(prisma, input));
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
    limits: { fileSize: MAX_ATTENDANCE_EVIDENCE_BYTES, files: 1, fields: 12, fieldSize: 16 * 1024 }
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

  function requireNativeAttendanceLocation(req, res, portalSession, expected, now) {
    try {
      const proof = parseNativeAttendanceLocationProof(req.body?.nativeLocationProof);
      let verificationAt = now;
      if (expected.captureMode === OFFLINE_WEB_CAPTURE_MODE) {
        const proofCapturedAt = new Date(Number(proof?.capturedAt));
        if (!Number.isNaN(proofCapturedAt.getTime())) verificationAt = proofCapturedAt;
      }
      return verifyNativeAttendanceLocationProofFn({
        workerId: portalSession.workerId,
        deviceId: portalSession.deviceId,
        assignmentId: expected.assignmentId,
        markType: expected.markType,
        idempotencyKey: expected.idempotencyKey,
        proof,
        now: verificationAt
      }, {
        env: options.env || process.env,
        secret: options.crewPresenceSecret
      });
    } catch (error) {
      const [status, code, message] = nativeAttendanceLocationPublicError(error);
      strictError(res, status, code, message);
      return null;
    }
  }

  function applyVerifiedNativeLocationToBody(req, verified) {
    req.body.latitude = String(verified.latitude);
    req.body.longitude = String(verified.longitude);
    req.body.accuracyMeters = String(verified.accuracyMeters);
    req.body.clientCapturedAt = verified.clientCapturedAt;
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
      const captureMode = normalizedString(req.body?.captureMode, 40)?.toUpperCase();
      if (
        !markType
        || !idempotencyKey
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

      const requestedCrewGroup = markType === 'ARRIVAL'
        && captureMode === ONLINE_WEB_CAPTURE_MODE
        && req.get?.('x-lorren-crew-group') === 'true';
      let locationInput = req.body;
      if (!requestedCrewGroup && isNativeAndroidRequest(req)) {
        locationInput = requireNativeAttendanceLocation(req, res, portalSession, {
          assignmentId: assignment.id,
          markType,
          idempotencyKey,
          captureMode
        }, now);
        if (!locationInput) return;
        applyVerifiedNativeLocationToBody(req, locationInput);
      }
      const location = await requireStrictAttendanceLocation(
        prisma,
        res,
        assignment.serviceRequest.operationPoint,
        locationInput,
        { allowCrossOperation: !requestedCrewGroup }
      );
      if (!location) return;

      if (requestedCrewGroup) {
        const contexts = await loadCrewPortalContextsFn({ workerId: portalSession.workerId });
        const crewContext = (Array.isArray(contexts) ? contexts : [])
          .find((context) => context?.assignmentId === assignment.id);
        const observedOperationPointId = normalizedString(req.get?.('x-lorren-crew-operation-point-id'), 160);
        const assignmentOperationPointId = normalizedString(assignment.serviceRequest?.operationPoint?.id, 160);
        if (
          !crewContext
          || crewContext.mode !== 'CREW'
          || crewContext.isCrewLeader !== true
          || crewContext.crewAvailable !== true
          || !crewContext.operationPointId
          || crewContext.operationPointId !== assignmentOperationPointId
          || observedOperationPointId !== crewContext.operationPointId
        ) {
          return strictError(
            res,
            409,
            'crew_group_not_available',
            'La llegada grupal no está disponible para esta asignación o el dispositivo Bluetooth no corresponde a la operación.'
          );
        }
        req.lorrenCrewGroup = true;
        req.lorrenCrewForceMajeure = req.get?.('x-lorren-crew-force-majeure') === 'true';
      }

      if (BIOMETRIC_MARK_TYPES.has(markType) && captureMode === ONLINE_WEB_CAPTURE_MODE && !requestedCrewGroup) {
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
        operationPointId: location.operationPointId,
        crossOperation: location.crossOperation,
        distanceMeters: location.distanceMeters,
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

  router.post('/cuadrillas/proximidad/contexto', biometricJson, async (req, res) => {
    if (!requirePortalRequest(req, res)) return;
    try {
      const now = nowFn();
      const portalSession = await resolvePortalSession(req, now);
      if (!portalSession) return strictError(res, 401, 'portal_session_required', 'Tu sesión del portal venció.');
      const assignments = await loadCrewPortalContextsFn({ workerId: portalSession.workerId });
      return res.status(200).json({
        ok: true,
        protocol: {
          serviceUuid: CREW_BLUETOOTH_SERVICE_UUID,
          operationCharacteristicUuid: CREW_BLUETOOTH_OPERATION_CHARACTERISTIC_UUID
        },
        assignments
      });
    } catch (error) {
      console.error('[WORKER_PORTAL_CREW_PROXIMITY_CONTEXT_FAILED]', {
        code: typeof error?.message === 'string' ? error.message : 'unknown'
      });
      return strictError(
        res,
        503,
        'crew_proximity_temporarily_unavailable',
        'No fue posible preparar la validación Bluetooth de la cuadrilla.'
      );
    }
  });

  router.post('/cuadrillas/presencia/credencial', biometricJson, async (req, res) => {
    if (!requirePortalRequest(req, res)) return;
    try {
      const now = nowFn();
      const portalSession = await resolvePortalSession(req, now);
      if (!portalSession) return strictError(res, 401, 'portal_session_required', 'Tu sesión del portal venció.');
      const publicKey = normalizedString(req.body?.publicKey, 4096);
      if (!publicKey) return strictError(res, 400, 'crew_presence_public_key_required', 'No fue posible preparar este teléfono para asistencia.');
      const issued = issueCrewPresenceCredentialFn({
        workerId: portalSession.workerId,
        deviceId: portalSession.deviceId,
        publicKey,
        now
      }, {
        env: options.env || process.env,
        secret: options.crewPresenceSecret,
        ttlMs: options.crewPresenceCredentialTtlMs
      });
      return res.status(201).json({
        ok: true,
        credential: issued.credential,
        expiresAt: issued.expiresAt,
        keyHash: issued.keyHash
      });
    } catch (error) {
      const [status, code] = crewPresencePublicError(error);
      if (status >= 500) console.error('[WORKER_PORTAL_CREW_PRESENCE_CREDENTIAL_FAILED]', { code });
      return strictError(res, status, code, 'No fue posible preparar este teléfono para asistencia.');
    }
  });

  router.post('/cuadrillas/presencia/sincronizar', biometricJson, async (req, res) => {
    if (!requirePortalRequest(req, res)) return;
    try {
      const now = nowFn();
      const portalSession = await resolvePortalSession(req, now);
      if (!portalSession) return strictError(res, 401, 'portal_session_required', 'Tu sesión del portal venció.');

      const assignmentId = normalizedString(req.body?.assignmentId, 160);
      const serviceRequestId = normalizedString(req.body?.serviceRequestId, 160);
      const idempotencyKey = normalizedString(req.body?.idempotencyKey, 100);
      const clientCapturedAt = new Date(req.body?.clientCapturedAt);
      if (!assignmentId || !serviceRequestId || !idempotencyKey || Number.isNaN(clientCapturedAt.getTime())) {
        return strictError(res, 400, 'crew_presence_sync_invalid', 'La comprobación de cuadrilla no es válida.');
      }

      const assignment = await loadBiometricAssignmentFn(portalSession.workerId, assignmentId, now);
      if (
        !assignment
        || assignment.serviceRequest?.id !== serviceRequestId
        || assignment.serviceRequest?.operationPoint?.attendanceEnabled !== true
      ) {
        return strictError(res, 409, 'assignment_not_available', 'La cuadrilla ya no está disponible para marcar llegada.');
      }

      const verified = await verifyCrewPresenceBundleFn({
        leaderWorkerId: portalSession.workerId,
        leaderDeviceId: portalSession.deviceId,
        assignmentId,
        serviceRequestId,
        idempotencyKey,
        clientCapturedAt,
        proofBundle: req.body?.proofBundle,
        now
      }, {
        env: options.env || process.env,
        secret: options.crewPresenceSecret,
        loadCrewContextsFn: (_prisma, input) => loadCrewPortalContextsFn(input)
      });
      const location = await requireStrictAttendanceLocation(
        prisma,
        res,
        assignment.serviceRequest.operationPoint,
        verified.leaderLocation,
        { allowCrossOperation: false }
      );
      if (!location) return;

      const verifiedMembers = Array.isArray(verified.members) ? verified.members : [];
      const memberByWorkerId = new Map(verifiedMembers.map((member) => [member.workerId, member]));
      await Promise.all((verified.phoneExceptionWorkerIds || []).map(async (workerId) => {
        const member = memberByWorkerId.get(workerId);
        if (!member) throw new Error('crew_phone_exception_member_contract_invalid');
        await auditCrewPhoneExceptionFn({
          leaderWorkerId: portalSession.workerId,
          serviceRequestId,
          assignmentId: member.assignmentId,
          workerId,
          idempotencyKey,
          clientCapturedAt: verified.clientCapturedAt,
          ipAddress: normalizedString(req.ip, 120),
          userAgent: normalizedString(req.get?.('user-agent'), 500)
        });
      }));

      const result = await registerCrewPresenceArrivalFn({
        leaderWorkerId: portalSession.workerId,
        assignmentId,
        idempotencyKey,
        now,
        captureMode: OFFLINE_WEB_CAPTURE_MODE,
        clientCapturedAt: verified.clientCapturedAt,
        latitude: location.latitude,
        longitude: location.longitude,
        accuracyMeters: location.accuracyMeters,
        installationIdHash: verified.leaderInstallationIdHash,
        presenceValidated: true,
        validatedWorkerIds: verified.validatedWorkerIds,
        forceMajeure: false,
        ipAddress: normalizedString(req.ip, 120),
        userAgent: normalizedString(req.get?.('user-agent'), 500)
      });

      if (!result?.applied) {
        return strictError(res, 409, 'crew_presence_group_not_available', 'La marcación por cuadrilla ya no está disponible.');
      }
      if (!result.summary) {
        return strictError(res, 409, 'crew_presence_leader_arrival_conflict', 'La llegada del encargado no permitió completar esta marcación grupal.');
      }

      const summary = result.summary;
      const processedCount = summary.newlyRecordedCount + summary.replayedCount + summary.alreadyRecordedCount;
      const validatedSet = new Set(verified.validatedWorkerIds || []);
      const phoneExceptionSet = new Set(verified.phoneExceptionWorkerIds || []);
      const resultByAssignment = new Map((summary.results || []).map((item) => [item.assignmentId, item]));
      const memberStatuses = verifiedMembers.map((member) => {
        const canonicalResult = resultByAssignment.get(member.assignmentId);
        let status = 'PENDING';
        if (validatedSet.has(member.workerId)) status = 'VERIFIED';
        else if (phoneExceptionSet.has(member.workerId)) status = 'NO_PHONE_REVIEW';
        else if (member.arrivalReported || canonicalResult?.status === 'ALREADY_RECORDED') status = 'REGISTERED';
        return {
          assignmentId: member.assignmentId,
          workerId: member.workerId,
          isLeader: member.workerId === portalSession.workerId,
          status
        };
      });
      const verifiedCount = memberStatuses.filter((member) => member.status === 'VERIFIED').length;
      const registeredCount = memberStatuses.filter((member) => member.status === 'REGISTERED').length;
      const pendingCount = memberStatuses.filter((member) => member.status === 'PENDING').length;
      const phoneExceptionCount = memberStatuses.filter((member) => member.status === 'NO_PHONE_REVIEW').length;
      const notDetectedCount = pendingCount;
      const requiresReview = summary.failedCount > 0
        || summary.reviewPendingCount > 0
        || phoneExceptionCount > 0;
      let message = `${verifiedCount} integrante${verifiedCount === 1 ? '' : 's'} verificado${verifiedCount === 1 ? '' : 's'}.`;
      if (registeredCount > 0) message += ` ${registeredCount} ya estaba${registeredCount === 1 ? '' : 'n'} registrado${registeredCount === 1 ? '' : 's'}.`;
      if (pendingCount > 0) message += ` ${pendingCount} queda${pendingCount === 1 ? '' : 'n'} pendiente${pendingCount === 1 ? '' : 's'}.`;
      if (phoneExceptionCount > 0) message += ` ${phoneExceptionCount} sin teléfono queda${phoneExceptionCount === 1 ? '' : 'n'} por revisar.`;
      if (summary.failedCount > 0 || summary.reviewPendingCount > 0) {
        message += ' Una o más marcaciones requieren revisión.';
      }

      return res.status(200).json({
        ok: true,
        crewGroup: true,
        presenceValidated: true,
        serviceRequestId,
        totalMembers: summary.totalMembers,
        detectedMembers: summary.eligibleMembers,
        processedCount,
        newlyRecordedCount: summary.newlyRecordedCount,
        replayedCount: summary.replayedCount,
        alreadyRecordedCount: summary.alreadyRecordedCount,
        failedCount: summary.failedCount,
        reviewPendingCount: summary.reviewPendingCount,
        notDetectedCount,
        verifiedProofCount: verified.verifiedProofCount,
        rejectedProofCount: verified.rejectedProofCount,
        phoneExceptionCount,
        rejectedPhoneExceptionCount: verified.rejectedPhoneExceptionCount || 0,
        memberStatuses,
        requiresReview,
        message
      });
    } catch (error) {
      const [status, code] = crewPresencePublicError(error);
      if (status >= 500) console.error('[WORKER_PORTAL_CREW_PRESENCE_SYNC_FAILED]', { code });
      return strictError(res, status, code, 'No fue posible sincronizar la llegada de la cuadrilla.');
    }
  });

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
      let locationInput = req.body;
      if (isNativeAndroidRequest(req)) {
        locationInput = requireNativeAttendanceLocation(req, res, portalSession, {
          assignmentId: context.assignmentId,
          markType: context.markType,
          idempotencyKey: context.idempotencyKey,
          captureMode: ONLINE_WEB_CAPTURE_MODE
        }, now);
        if (!locationInput) return;
      }
      const location = await requireStrictAttendanceLocation(
        prisma,
        res,
        context.assignment.serviceRequest.operationPoint,
        locationInput
      );
      if (!location) return;
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
