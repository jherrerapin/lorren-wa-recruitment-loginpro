import express from 'express';
import multer from 'multer';
import { workerPortalRouter as coreWorkerPortalRouter, applyWorkerPortalSecurityHeaders } from './workerPortalCore.js';
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
  WORKER_BIOMETRIC_ACTION
} from '../services/workerBiometricService.js';

export * from './workerPortalCore.js';

const HUMAN_CDN_ORIGIN = 'https://cdn.jsdelivr.net';
const STRICT_MARK_PATHS = [
  '/asignaciones/:assignmentId/llegada',
  '/asignaciones/:assignmentId/inicio-almuerzo',
  '/asignaciones/:assignmentId/fin-almuerzo',
  '/asignaciones/:assignmentId/salida'
];
const BIOMETRIC_MARK_TYPES = new Set(['ARRIVAL', 'DEPARTURE']);

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

function strictError(res, status, error, message) {
  applyWorkerPortalSecurityHeaders(res);
  return res.status(status).json({ ok: false, error, message });
}

function verifiedBiometricMetadata(metadata, expected) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  return metadata.decision === 'VERIFIED'
    && metadata.verified === true
    && String(metadata.workerId || '') === String(expected.workerId)
    && String(metadata.assignmentId || '') === String(expected.assignmentId)
    && String(metadata.markType || '') === String(expected.markType);
}

function expandBiometricCsp(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace("script-src ", `script-src ${HUMAN_CDN_ORIGIN} `)
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

function routeLayer(router, path, method = 'post') {
  return router.stack.find((layer) => layer.route?.path === path && layer.route.methods?.[method]);
}

function prependRouteHandlers(router, path, handlers) {
  const target = routeLayer(router, path);
  if (!target) throw new Error(`worker_portal_strict_route_missing:${path}`);
  const temporary = express.Router();
  temporary.post(path, ...handlers);
  target.route.stack.unshift(...temporary.stack[0].route.stack);
}

function usesInjectedAttendanceCore(options = {}) {
  return [options.registerArrivalFn, options.registerDepartureFn, options.registerBreakFn]
    .some((candidate) => typeof candidate === 'function');
}

export function workerPortalRouter(prisma, options = {}) {
  const repositoryFactory = options.repositoryFactory || (() => createPrismaWorkerPortalSessionRepository(prisma));
  const resolveSessionFn = options.resolveSessionFn || resolveWorkerPortalSession;
  const nowFn = options.nowFn || (() => new Date());
  const injectedCore = usesInjectedAttendanceCore(options);
  let repository = options.repository || null;

  const markUpload = options.strictMarkUpload || options.markUpload || options.arrivalUpload || multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTENDANCE_EVIDENCE_BYTES, files: 1, fields: 12, fieldSize: 4 * 1024 }
  }).single('selfie');

  function getRepository() {
    if (!repository) repository = repositoryFactory();
    if (!repository) throw new Error('worker_portal_repository_unavailable');
    return repository;
  }

  async function strictMarkGuard(req, res, next) {
    try {
      applyWorkerPortalSecurityHeaders(res);
      if (req.get?.('x-requested-with') !== 'worker-portal') {
        return strictError(res, 400, 'mark_request_invalid', 'Solicitud de marcación inválida.');
      }

      const now = nowFn();
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new Error('worker_portal_strict_now_invalid');
      }

      const rawSessionToken = req.cookies?.[WORKER_PORTAL_SESSION_COOKIE_NAME];
      if (!rawSessionToken) return strictError(res, 401, 'portal_session_required', 'Tu sesión del portal venció.');
      const portalSession = await resolveSessionFn({ repository: getRepository(), rawSessionToken, now });
      if (!portalSession) return strictError(res, 401, 'portal_session_required', 'Tu sesión del portal venció.');

      const markType = markTypeFromPath(req.path);
      const idempotencyKey = normalizedString(req.body?.idempotencyKey, 120);
      const latitude = finiteNumber(req.body?.latitude, { min: -90, max: 90 });
      const longitude = finiteNumber(req.body?.longitude, { min: -180, max: 180 });
      const accuracyMeters = finiteNumber(req.body?.accuracyMeters, { min: 0, max: 100_000 });
      if (!markType || !idempotencyKey || latitude === null || longitude === null || accuracyMeters === null) {
        return strictError(res, 400, 'mark_request_invalid', 'No fue posible validar la ubicación.');
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

      if (BIOMETRIC_MARK_TYPES.has(markType)) {
        if (String(req.body?.captureMode || '').toUpperCase() === 'OFFLINE_WEB') {
          return strictError(res, 409, 'online_biometric_required', 'La entrada y la salida requieren conexión para validar el rostro.');
        }
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
          markType
        })) {
          return strictError(res, 409, 'biometric_verification_required', 'Debes completar correctamente la validación facial para marcar.');
        }
      }

      req.lorrenStrictAttendance = { workerId: portalSession.workerId, markType, distanceMeters, insideGeofence: true };
      return next();
    } catch (error) {
      console.error('[WORKER_PORTAL_STRICT_MARK_GUARD_FAILED]', {
        code: typeof error?.message === 'string' ? error.message : 'unknown'
      });
      return strictError(res, 503, 'mark_temporarily_unavailable', 'No fue posible validar la marcación en este momento.');
    }
  }

  const router = coreWorkerPortalRouter(prisma, injectedCore ? {
    ...options,
    repository: getRepository()
  } : {
    ...options,
    repository: getRepository(),
    markUpload: (_req, _res, next) => next(),
    arrivalUpload: undefined
  });

  const cspRouter = express.Router();
  cspRouter.use(installBiometricCspBridge);
  router.stack.unshift(...cspRouter.stack);
  if (!injectedCore) {
    STRICT_MARK_PATHS.forEach((path) => prependRouteHandlers(router, path, [markUpload, strictMarkGuard]));
  }
  return router;
}
