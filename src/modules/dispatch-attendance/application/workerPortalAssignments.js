import {
  ACTIVE_DISPATCH_ASSIGNMENT_STATUSES,
  buildDispatchAttendanceExpectedWindow,
  getDispatchArrivalWindowState
} from './registerArrival.js';

const PORTAL_PAST_WINDOW_MS = 24 * 60 * 60 * 1000;
const PORTAL_FUTURE_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
const BOGOTA_TIME_ZONE = 'America/Bogota';

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}_required`);
  return value.trim();
}

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function requireDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!validDate(date)) throw new Error(`${label}_invalid`);
  return date;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
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

function attendanceLabel(session) {
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

function buildPortalAssignment(assignment, now) {
  const request = assignment?.serviceRequest;
  if (!request) throw new Error('worker_portal_assignment_service_request_required');

  const point = request.operationPoint ?? null;
  const session = assignment.attendanceSession ?? null;
  let expectedStartAt = null;
  let expectedEndAt = null;
  let windowState = { open: false, opensAt: null };

  if (request.startTime) {
    const expected = buildDispatchAttendanceExpectedWindow(request);
    expectedStartAt = expected.expectedStartAt;
    expectedEndAt = expected.expectedEndAt;
    windowState = getDispatchArrivalWindowState({
      now,
      expectedStartAt,
      earlyArrivalWindowMinutes: finiteNumber(point?.earlyArrivalWindowMinutes, 0)
    });
  }

  const arrivalReported = Boolean(session?.arrivalReportedAt);
  const attendanceEnabled = point?.attendanceEnabled === true;
  const canRegisterArrival = attendanceEnabled
    && Boolean(expectedStartAt)
    && windowState.open
    && !arrivalReported;
  const photoPolicy = normalizePhotoPolicy(point?.attendancePhotoPolicy);

  let actionLabel = 'Registrar llegada';
  if (arrivalReported) actionLabel = attendanceLabel(session);
  else if (!attendanceEnabled) actionLabel = 'Marcación no habilitada';
  else if (!expectedStartAt) actionLabel = 'Horario pendiente';
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
    attendanceEnabled,
    arrivalReported,
    attendanceStatus: session?.attendanceStatus || 'PENDING',
    validationStatus: session?.validationStatus || 'PENDING',
    punctualityStatus: session?.punctualityStatus || null,
    actionLabel,
    canRegisterArrival,
    photoPolicy,
    photoRequired: photoPolicy !== 'NEVER'
  };
}

function isPortalRelevant(assignment, now) {
  if (assignment.arrivalReported) return true;
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

  return records
    .map((record) => buildPortalAssignment(record, now))
    .filter((record) => isPortalRelevant(record, now))
    .sort((left, right) => {
      const leftTime = left.expectedStartAt ? new Date(left.expectedStartAt).getTime() : Number.MAX_SAFE_INTEGER;
      const rightTime = right.expectedStartAt ? new Date(right.expectedStartAt).getTime() : Number.MAX_SAFE_INTEGER;
      return leftTime - rightTime;
    });
}

export async function loadWorkerPortalAssignmentForArrival(prisma, input = {}) {
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

  return assignment ? buildPortalAssignment(assignment, now) : null;
}
