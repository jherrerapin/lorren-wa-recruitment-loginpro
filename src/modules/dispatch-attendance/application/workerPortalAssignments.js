import {
  ACTIVE_DISPATCH_ASSIGNMENT_STATUSES,
  buildDispatchAttendanceExpectedWindow,
  getDispatchArrivalWindowState
} from './registerArrival.js';
import {
  getDispatchAttendanceBreakPolicies,
  getDispatchAttendanceBreakPolicy
} from '../infrastructure/dispatchAttendanceBreakPolicyRepository.js';
import { formatDispatchMinutes } from '../domain/attendanceWorkdayPolicy.js';

const PORTAL_PAST_WINDOW_MS = 24 * 60 * 60 * 1000;
const PORTAL_FUTURE_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
const DEFAULT_ABSENCE_GRACE_MINUTES = 15;
const BOGOTA_TIME_ZONE = 'America/Bogota';

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}_required`);
  return value.trim();
}

function requireDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label}_invalid`);
  return date;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegativeMinutes(value, fallback) {
  return Math.max(0, finiteNumber(value, fallback));
}

function requireAssignmentReader(prisma, methodName) {
  if (!prisma?.dispatchAssignment || typeof prisma.dispatchAssignment[methodName] !== 'function') {
    throw new Error(`worker_portal_assignment_${methodName}_required`);
  }
}

function formatDate(value) {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: BOGOTA_TIME_ZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(value);
}

function formatTime(value) {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: BOGOTA_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(value);
}

function formatDateTime(value) {
  if (!value) return null;
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: BOGOTA_TIME_ZONE,
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(value);
}

function arrivalLabel(session) {
  if (!session?.arrivalReportedAt) return null;
  if (session.validationStatus === 'AUTO_VALIDATED') {
    return session.punctualityStatus === 'LATE'
      ? 'Llegada validada · tarde'
      : 'Llegada validada · a tiempo';
  }
  if (session.validationStatus === 'REVIEW_REQUIRED') return 'Llegada registrada · en revisión';
  if (session.validationStatus === 'REJECTED') return 'Llegada rechazada';
  return 'Llegada registrada';
}

function normalizePhotoPolicy(value) {
  return ['NEVER', 'RISK_ONLY', 'ALWAYS'].includes(value) ? value : 'RISK_ONLY';
}

function boundedArrivalWindow({ now, expectedStartAt, point }) {
  const baseWindow = getDispatchArrivalWindowState({
    now,
    expectedStartAt,
    earlyArrivalWindowMinutes: nonNegativeMinutes(point?.earlyArrivalWindowMinutes, 0)
  });
  const absenceGraceMinutes = nonNegativeMinutes(
    point?.absenceGraceMinutes,
    DEFAULT_ABSENCE_GRACE_MINUTES
  );
  const closesAt = new Date(expectedStartAt.getTime() + absenceGraceMinutes * 60_000);
  const expired = now.getTime() > closesAt.getTime();
  return {
    open: baseWindow.open && !expired,
    opensAt: baseWindow.opensAt,
    closesAt,
    expired
  };
}

function breakLabel(policy) {
  return policy.unpaidBreakMinutes > 0
    ? `${policy.unpaidBreakMinutes} min no remunerados`
    : 'Sin descanso no remunerado';
}

function buildPortalAssignment(assignment, now, breakPolicy) {
  const request = assignment?.serviceRequest;
  if (!request) throw new Error('worker_portal_assignment_service_request_required');

  const point = request.operationPoint ?? null;
  const session = assignment.attendanceSession ?? null;
  let expectedStartAt = null;
  let expectedEndAt = null;
  let windowState = { open: false, opensAt: null, closesAt: null, expired: false };

  if (request.startTime) {
    const expected = buildDispatchAttendanceExpectedWindow(request);
    expectedStartAt = expected.expectedStartAt;
    expectedEndAt = expected.expectedEndAt;
    windowState = boundedArrivalWindow({ now, expectedStartAt, point });
  }

  const arrivalReported = Boolean(session?.arrivalReportedAt);
  const departureReported = Boolean(session?.departureReportedAt);
  const attendanceEnabled = point?.attendanceEnabled === true;
  const canRegisterArrival = attendanceEnabled
    && Boolean(expectedStartAt)
    && windowState.open
    && !arrivalReported;
  const canRegisterDeparture = attendanceEnabled
    && arrivalReported
    && !departureReported
    && session?.validationStatus !== 'REJECTED';
  const photoPolicy = normalizePhotoPolicy(point?.attendancePhotoPolicy);

  let actionType = 'ARRIVAL';
  let actionLabel = 'Registrar llegada';
  if (departureReported) {
    actionType = 'DONE';
    actionLabel = `Jornada finalizada · ${formatDispatchMinutes(session?.workedMinutes)}`;
  } else if (arrivalReported) {
    actionType = 'DEPARTURE';
    actionLabel = 'Registrar salida';
  } else if (!expectedStartAt) actionLabel = 'Horario pendiente';
  else if (windowState.expired) actionLabel = 'Jornada vencida';
  else if (!attendanceEnabled) actionLabel = 'Marcación no habilitada';
  else if (!windowState.open) actionLabel = `Disponible desde ${formatTime(windowState.opensAt)}`;

  return {
    id: assignment.id,
    clientName: request.clientName || 'Cliente por confirmar',
    operationPointName: request.operationPointName || point?.name || 'Operación por confirmar',
    cityName: request.cityName || point?.cityName || 'Ciudad por confirmar',
    address: request.address || point?.address || 'Dirección por confirmar',
    dateLabel: formatDate(requireDate(request.serviceDate, 'worker_portal_assignment_service_date')),
    timeLabel: expectedStartAt
      ? `${formatTime(expectedStartAt)}${expectedEndAt ? ` – ${formatTime(expectedEndAt)}` : ''}`
      : 'Horario por confirmar',
    expectedStartAt: expectedStartAt?.toISOString() || null,
    expectedEndAt: expectedEndAt?.toISOString() || null,
    arrivalWindowOpen: windowState.open,
    arrivalWindowOpensAt: windowState.opensAt?.toISOString() || null,
    arrivalWindowClosesAt: windowState.closesAt?.toISOString() || null,
    arrivalWindowExpired: windowState.expired,
    attendanceEnabled,
    arrivalReported,
    arrivalReportedLabel: formatDateTime(session?.arrivalReportedAt),
    departureReported,
    departureReportedLabel: formatDateTime(session?.departureReportedAt),
    workedMinutes: session?.workedMinutes ?? null,
    workedLabel: session?.workedMinutes === null || session?.workedMinutes === undefined
      ? null
      : formatDispatchMinutes(session.workedMinutes),
    breakPolicy: breakPolicy.policy,
    unpaidBreakMinutes: breakPolicy.unpaidBreakMinutes,
    breakLabel: breakLabel(breakPolicy),
    attendanceStatus: session?.attendanceStatus || 'PENDING',
    validationStatus: session?.validationStatus || 'PENDING',
    punctualityStatus: session?.punctualityStatus || null,
    arrivalStatusLabel: arrivalLabel(session),
    actionType,
    actionLabel,
    canRegisterArrival,
    canRegisterDeparture,
    photoPolicy,
    photoRequired: photoPolicy !== 'NEVER'
  };
}

function isPortalRelevant(assignment, now) {
  if (assignment.arrivalReported && !assignment.departureReported) return true;
  if (assignment.departureReported) {
    const departure = assignment.departureReportedLabel ? new Date(assignment.expectedStartAt || 0).getTime() : 0;
    return !departure || departure >= now.getTime() - PORTAL_PAST_WINDOW_MS;
  }
  if (!assignment.expectedStartAt) return true;
  const start = new Date(assignment.expectedStartAt).getTime();
  return start >= now.getTime() - PORTAL_PAST_WINDOW_MS
    && start <= now.getTime() + PORTAL_FUTURE_WINDOW_MS;
}

export async function loadWorkerPortalAssignments(prisma, input = {}) {
  requireAssignmentReader(prisma, 'findMany');
  const workerId = requireNonEmptyString(input.workerId, 'worker_portal_worker_id');
  const now = input.now === undefined ? new Date() : requireDate(input.now, 'worker_portal_now');
  const records = await prisma.dispatchAssignment.findMany({
    where: {
      workerId,
      status: { in: [...ACTIVE_DISPATCH_ASSIGNMENT_STATUSES] }
    },
    include: {
      attendanceSession: true,
      serviceRequest: { include: { operationPoint: true } }
    }
  });
  const policies = await getDispatchAttendanceBreakPolicies(
    prisma,
    records.map((record) => record.serviceRequestId)
  );

  return records
    .map((record) => buildPortalAssignment(
      record,
      now,
      policies.get(record.serviceRequestId) || { policy: 'NONE', unpaidBreakMinutes: 0 }
    ))
    .filter((record) => isPortalRelevant(record, now))
    .sort((left, right) => {
      const leftTime = left.expectedStartAt ? new Date(left.expectedStartAt).getTime() : Number.MAX_SAFE_INTEGER;
      const rightTime = right.expectedStartAt ? new Date(right.expectedStartAt).getTime() : Number.MAX_SAFE_INTEGER;
      return leftTime - rightTime;
    });
}

export async function loadWorkerPortalAssignmentForMark(prisma, input = {}) {
  requireAssignmentReader(prisma, 'findFirst');
  const workerId = requireNonEmptyString(input.workerId, 'worker_portal_worker_id');
  const assignmentId = requireNonEmptyString(input.assignmentId, 'worker_portal_assignment_id');
  const now = input.now === undefined ? new Date() : requireDate(input.now, 'worker_portal_now');
  const assignment = await prisma.dispatchAssignment.findFirst({
    where: {
      id: assignmentId,
      workerId,
      status: { in: [...ACTIVE_DISPATCH_ASSIGNMENT_STATUSES] }
    },
    include: {
      attendanceSession: true,
      serviceRequest: { include: { operationPoint: true } }
    }
  });
  if (!assignment) return null;
  const policy = await getDispatchAttendanceBreakPolicy(prisma, assignment.serviceRequestId);
  return buildPortalAssignment(assignment, now, policy);
}

export const loadWorkerPortalAssignmentForArrival = loadWorkerPortalAssignmentForMark;
