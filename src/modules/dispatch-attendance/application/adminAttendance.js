import { randomUUID } from 'node:crypto';
import { calculateDispatchWorkedTime } from '../domain/attendanceWorkdayPolicy.js';
import { buildDispatchAttendanceExpectedWindow } from './registerArrival.js';

const ACTIVE_ASSIGNMENT_STATUSES = Object.freeze([
  'ASSIGNED',
  'CONFIRMATION_PENDING',
  'CONFIRMED'
]);
const VALID_MANUAL_STATUSES = new Set(['ON_TIME', 'LATE']);
const VALID_REVIEW_ACTIONS = new Set(['VALIDATE', 'REJECT', 'REOPEN']);
const DEFAULT_ABSENCE_GRACE_MINUTES = 15;
const BOGOTA_TIME_ZONE = 'America/Bogota';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length ? normalized : null;
}

function requireString(value, label, { minLength = 1, maxLength = 500 } = {}) {
  const normalized = normalizeString(value);
  if (!normalized) throw new Error(`${label}_required`);
  if (normalized.length < minLength) throw new Error(`${label}_too_short`);
  if (normalized.length > maxLength) throw new Error(`${label}_too_long`);
  return normalized;
}

function manualDateTime(value, label) {
  if (value instanceof Date) {
    const date = new Date(value.getTime());
    if (Number.isNaN(date.getTime())) throw new Error(`${label}_invalid`);
    return date;
  }
  const normalized = normalizeString(value);
  if (!normalized) throw new Error(`${label}_required`);
  const localDateTime = normalized.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  const candidate = localDateTime
    ? new Date(`${localDateTime[1]}T${localDateTime[2]}:${localDateTime[3]}:${localDateTime[4] || '00'}-05:00`)
    : new Date(normalized);
  if (Number.isNaN(candidate.getTime())) throw new Error(`${label}_invalid`);
  return candidate;
}

function hasManualWorkdayInput(input = {}) {
  return input.arrivalReportedAt !== undefined || input.departureReportedAt !== undefined;
}

function enabledFlag(value) {
  if (value === true) return true;
  const normalized = normalizeString(value)?.toLowerCase();
  return normalized === 'true' || normalized === 'on' || normalized === '1';
}

function normalizeDateInput(value, fallback) {
  const normalized = normalizeString(value);
  if (!normalized || !/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return fallback;
  const candidate = new Date(`${normalized}T00:00:00.000Z`);
  return Number.isNaN(candidate.getTime()) ? fallback : normalized;
}

function todayInBogota(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BOGOTA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function dateRange(input = {}, now = new Date()) {
  const today = todayInBogota(now);
  const from = normalizeDateInput(input.from, today);
  const to = normalizeDateInput(input.to, from);
  const orderedFrom = from <= to ? from : to;
  const orderedTo = from <= to ? to : from;
  return {
    from: orderedFrom,
    to: orderedTo,
    gte: new Date(`${orderedFrom}T00:00:00.000Z`),
    lte: new Date(`${orderedTo}T23:59:59.999Z`)
  };
}

function finiteNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numericCoordinate(value, min, max) {
  const parsed = finiteNumber(value, null);
  return parsed !== null && parsed >= min && parsed <= max ? parsed : null;
}

function formatDate(value) {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: BOGOTA_TIME_ZONE,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).format(value);
}

function formatDateTime(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return 'Sin registro';
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: BOGOTA_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(value);
}

function formatTime(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return 'Sin horario';
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: BOGOTA_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(value);
}

function toRiskFlags(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function latestByDate(items, fieldName) {
  if (!Array.isArray(items) || !items.length) return null;
  return [...items].sort((left, right) => {
    const leftTime = new Date(left?.[fieldName] || 0).getTime();
    const rightTime = new Date(right?.[fieldName] || 0).getTime();
    return rightTime - leftTime;
  })[0] || null;
}

function attendanceWindow(assignment) {
  const request = assignment.serviceRequest;
  if (!request?.startTime) {
    return { expectedStartAt: null, expectedEndAt: null, closesAt: null };
  }
  const expected = buildDispatchAttendanceExpectedWindow(request);
  const graceMinutes = Math.max(
    0,
    finiteNumber(request.operationPoint?.absenceGraceMinutes, DEFAULT_ABSENCE_GRACE_MINUTES)
  );
  return {
    ...expected,
    closesAt: new Date(expected.expectedStartAt.getTime() + graceMinutes * 60_000)
  };
}

function boardStatus({ session, expectedStartAt, closesAt, now }) {
  if (session?.validationStatus === 'REVIEW_REQUIRED') return 'REVIEW_REQUIRED';
  if (session?.validationStatus === 'AUTO_VALIDATED') return 'AUTO_VALIDATED';
  if (session?.validationStatus === 'MANUAL_VALIDATED') return 'MANUAL_VALIDATED';
  if (session?.validationStatus === 'REJECTED') return 'REJECTED';
  if (session?.arrivalReportedAt) return 'REVIEW_REQUIRED';
  if (expectedStartAt && closesAt && now.getTime() > closesAt.getTime()) return 'NO_SHOW';
  return 'PENDING';
}

function statusLabel(status) {
  const labels = {
    REVIEW_REQUIRED: 'Pendiente de revisión',
    AUTO_VALIDATED: 'Validada automáticamente',
    MANUAL_VALIDATED: 'Validada manualmente',
    REJECTED: 'Marcación rechazada',
    NO_SHOW: 'No registró llegada',
    PENDING: 'Pendiente de llegada'
  };
  return labels[status] || status;
}

function punctualityLabel(value) {
  if (value === 'ON_TIME') return 'A tiempo';
  if (value === 'LATE') return 'Tarde';
  return 'Sin clasificar';
}

function searchText(row) {
  return [
    row.workerName,
    row.documentNumber,
    row.phone,
    row.clientName,
    row.operationPointName,
    row.cityName,
    row.address
  ].filter(Boolean).join(' ').toLocaleLowerCase('es-CO');
}

function buildBoardRow(assignment, now) {
  const request = assignment.serviceRequest;
  const point = request?.operationPoint || null;
  const session = assignment.attendanceSession || null;
  const mark = latestByDate(session?.marks, 'serverReceivedAt');
  const review = latestByDate(session?.reviews, 'createdAt');
  const expected = attendanceWindow(assignment);
  const status = boardStatus({
    session,
    expectedStartAt: expected.expectedStartAt,
    closesAt: expected.closesAt,
    now
  });
  const pointLatitude = numericCoordinate(point?.attendanceLatitude, -90, 90);
  const pointLongitude = numericCoordinate(point?.attendanceLongitude, -180, 180);
  const markLatitude = numericCoordinate(mark?.latitude, -90, 90);
  const markLongitude = numericCoordinate(mark?.longitude, -180, 180);

  return {
    assignmentId: assignment.id,
    sessionId: session?.id || null,
    markId: mark?.id || null,
    workerName: assignment.worker?.fullName || 'Auxiliar sin nombre',
    documentType: assignment.worker?.documentType || null,
    documentNumber: assignment.worker?.documentNumber || null,
    phone: assignment.worker?.phone || null,
    clientName: request?.clientName || 'Cliente sin nombre',
    operationPointName: request?.operationPointName || point?.name || 'Punto sin nombre',
    cityName: request?.cityName || point?.cityName || 'Ciudad sin definir',
    address: request?.address || point?.address || 'Dirección sin definir',
    serviceDateLabel: request?.serviceDate ? formatDate(request.serviceDate) : 'Fecha sin definir',
    serviceDateIso: request?.serviceDate ? request.serviceDate.toISOString().slice(0, 10) : null,
    scheduleLabel: expected.expectedStartAt
      ? `${formatTime(expected.expectedStartAt)}${expected.expectedEndAt ? ` – ${formatTime(expected.expectedEndAt)}` : ''}`
      : 'Horario pendiente',
    expectedStartAt: expected.expectedStartAt?.toISOString() || null,
    expectedEndAt: expected.expectedEndAt?.toISOString() || null,
    arrivalReportedAt: session?.arrivalReportedAt?.toISOString() || null,
    arrivalReportedLabel: formatDateTime(session?.arrivalReportedAt),
    status,
    statusLabel: statusLabel(status),
    attendanceStatus: session?.attendanceStatus || 'PENDING',
    validationStatus: session?.validationStatus || 'PENDING',
    punctualityStatus: session?.punctualityStatus || null,
    punctualityLabel: punctualityLabel(session?.punctualityStatus),
    riskScore: Math.max(0, finiteNumber(session?.riskScore, finiteNumber(mark?.riskScore, 0))),
    riskFlags: toRiskFlags(session?.riskFlags || mark?.riskFlags),
    accuracyMeters: finiteNumber(mark?.accuracyMeters, null),
    distanceToPointMeters: finiteNumber(mark?.distanceToPointMeters, null),
    insideGeofence: typeof mark?.insideGeofence === 'boolean' ? mark.insideGeofence : null,
    evidenceAvailable: Boolean(mark?.evidenceStorageKey),
    pointLatitude,
    pointLongitude,
    markLatitude,
    markLongitude,
    geofenceRadiusMeters: Math.max(1, finiteNumber(point?.geofenceRadiusMeters, 100)),
    manualAttendanceAllowed: point?.manualAttendanceAllowed === true,
    attendanceEnabled: point?.attendanceEnabled === true,
    lastReview: review ? {
      action: review.action,
      reason: review.reason,
      notes: review.notes,
      actorUsername: review.actorUsername,
      createdAtLabel: formatDateTime(review.createdAt)
    } : null
  };
}

function buildMetrics(rows) {
  const metrics = {
    total: rows.length,
    pendingReview: 0,
    autoValidated: 0,
    manualValidated: 0,
    late: 0,
    rejected: 0,
    noShow: 0
  };
  rows.forEach((row) => {
    if (row.status === 'REVIEW_REQUIRED') metrics.pendingReview += 1;
    if (row.status === 'AUTO_VALIDATED') metrics.autoValidated += 1;
    if (row.status === 'MANUAL_VALIDATED') metrics.manualValidated += 1;
    if (row.punctualityStatus === 'LATE') metrics.late += 1;
    if (row.status === 'REJECTED') metrics.rejected += 1;
    if (row.status === 'NO_SHOW') metrics.noShow += 1;
  });
  return metrics;
}

function requireAdminPrisma(prisma) {
  const contracts = {
    dispatchAssignment: ['findMany', 'findUnique'],
    dispatchAttendanceSession: ['findUnique', 'create', 'update'],
    dispatchAttendanceMark: ['findFirst', 'create', 'update'],
    dispatchAttendanceReview: ['create']
  };
  Object.entries(contracts).forEach(([model, methods]) => {
    if (!prisma?.[model] || methods.some((method) => typeof prisma[model][method] !== 'function')) {
      throw new Error(`attendance_admin_${model}_contract_invalid`);
    }
  });
  if (typeof prisma.$transaction !== 'function') {
    throw new Error('attendance_admin_transaction_required');
  }
}

export async function loadAttendanceAdminBoard(prisma, input = {}) {
  requireAdminPrisma(prisma);
  const now = input.now instanceof Date ? input.now : new Date();
  const range = dateRange(input, now);
  const requestedStatus = normalizeString(input.status) || 'ALL';
  const requestedClient = normalizeString(input.client) || 'ALL';
  const query = normalizeString(input.q)?.toLocaleLowerCase('es-CO') || null;

  const assignments = await prisma.dispatchAssignment.findMany({
    where: {
      status: { in: [...ACTIVE_ASSIGNMENT_STATUSES] },
      serviceRequest: {
        serviceDate: { gte: range.gte, lte: range.lte }
      }
    },
    include: {
      worker: true,
      serviceRequest: { include: { operationPoint: true } },
      attendanceSession: {
        include: {
          marks: { orderBy: { serverReceivedAt: 'desc' } },
          reviews: { orderBy: { createdAt: 'desc' } }
        }
      }
    }
  });

  const allRows = assignments
    .map((assignment) => buildBoardRow(assignment, now))
    .sort((left, right) => {
      const leftTime = new Date(left.expectedStartAt || `${left.serviceDateIso}T23:59:59.999Z`).getTime();
      const rightTime = new Date(right.expectedStartAt || `${right.serviceDateIso}T23:59:59.999Z`).getTime();
      return leftTime - rightTime;
    });

  const clients = [...new Set(allRows.map((row) => row.clientName).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'es'));
  const rows = allRows.filter((row) => {
    if (requestedStatus !== 'ALL' && row.status !== requestedStatus) return false;
    if (requestedClient !== 'ALL' && row.clientName !== requestedClient) return false;
    if (query && !searchText(row).includes(query)) return false;
    return true;
  });

  return {
    range: { from: range.from, to: range.to },
    filters: {
      status: requestedStatus,
      client: requestedClient,
      q: normalizeString(input.q) || ''
    },
    clients,
    rows,
    metrics: buildMetrics(allRows)
  };
}

function reviewTransition(session, action, requestedAttendanceStatus) {
  if (!session?.arrivalReportedAt) throw new Error('attendance_review_arrival_required');
  if (action === 'VALIDATE') {
    const attendanceStatus = requireString(requestedAttendanceStatus, 'attendance_review_status');
    if (!VALID_MANUAL_STATUSES.has(attendanceStatus)) {
      throw new Error('attendance_review_status_invalid');
    }
    return {
      attendanceStatus,
      validationStatus: 'MANUAL_VALIDATED',
      punctualityStatus: attendanceStatus,
      arrivalValidatedAt: new Date()
    };
  }
  if (action === 'REJECT') {
    return {
      attendanceStatus: 'REJECTED',
      validationStatus: 'REJECTED',
      punctualityStatus: session.punctualityStatus,
      arrivalValidatedAt: null
    };
  }
  if (action === 'REOPEN') {
    return {
      attendanceStatus: 'ARRIVAL_REPORTED',
      validationStatus: 'REVIEW_REQUIRED',
      punctualityStatus: session.punctualityStatus,
      arrivalValidatedAt: null
    };
  }
  throw new Error('attendance_review_action_invalid');
}

export async function reviewAttendanceSession(prisma, input = {}) {
  requireAdminPrisma(prisma);
  const sessionId = requireString(input.sessionId, 'attendance_review_session_id', { maxLength: 120 });
  const action = requireString(input.action, 'attendance_review_action', { maxLength: 40 }).toUpperCase();
  if (!VALID_REVIEW_ACTIONS.has(action)) throw new Error('attendance_review_action_invalid');
  const reason = requireString(input.reason, 'attendance_review_reason', { minLength: 5, maxLength: 500 });
  const notes = normalizeString(input.notes)?.slice(0, 1000) || null;
  const actorUsername = requireString(input.actorUsername, 'attendance_review_actor', { maxLength: 120 });
  const actorRole = normalizeString(input.actorRole)?.slice(0, 60) || null;
  const now = input.now instanceof Date ? input.now : new Date();

  return prisma.$transaction(async (tx) => {
    const session = await tx.dispatchAttendanceSession.findUnique({
      where: { id: sessionId },
      include: {
        assignment: {
          include: {
            worker: true,
            serviceRequest: { include: { operationPoint: true } }
          }
        }
      }
    });
    if (!session) throw new Error('attendance_review_session_not_found');
    const transition = reviewTransition(session, action, input.attendanceStatus);
    transition.arrivalValidatedAt = transition.validationStatus === 'MANUAL_VALIDATED' ? now : null;

    const updated = await tx.dispatchAttendanceSession.update({
      where: { id: session.id },
      data: transition
    });
    const latestMark = await tx.dispatchAttendanceMark.findFirst({
      where: { attendanceSessionId: session.id, markType: 'ARRIVAL' },
      orderBy: { serverReceivedAt: 'desc' }
    });
    if (latestMark) {
      await tx.dispatchAttendanceMark.update({
        where: { id: latestMark.id },
        data: { decision: transition.validationStatus }
      });
    }
    await tx.dispatchAttendanceReview.create({
      data: {
        attendanceSessionId: session.id,
        action,
        previousAttendanceStatus: session.attendanceStatus,
        newAttendanceStatus: transition.attendanceStatus,
        previousValidationStatus: session.validationStatus,
        newValidationStatus: transition.validationStatus,
        reason,
        notes,
        actorUsername,
        actorRole,
        metadata: {
          workerId: session.assignment.workerId,
          workerName: session.assignment.worker?.fullName || null,
          serviceRequestId: session.assignment.serviceRequestId,
          assignmentId: session.assignmentId
        }
      }
    });
    return updated;
  });
}

export async function registerManualAttendance(prisma, input = {}) {
  requireAdminPrisma(prisma);
  const assignmentId = requireString(input.assignmentId, 'attendance_manual_assignment_id', { maxLength: 120 });
  const manualWorkday = hasManualWorkdayInput(input);
  const attendanceStatus = manualWorkday
    ? null
    : requireString(input.attendanceStatus, 'attendance_manual_status', { maxLength: 40 }).toUpperCase();
  if (!manualWorkday && !VALID_MANUAL_STATUSES.has(attendanceStatus)) {
    throw new Error('attendance_manual_status_invalid');
  }
  const reason = manualWorkday
    ? (normalizeString(input.reason)?.slice(0, 500) || 'Jornada manual registrada por coordinación.')
    : requireString(input.reason, 'attendance_manual_reason', { minLength: 5, maxLength: 500 });
  const notes = normalizeString(input.notes)?.slice(0, 1000) || null;
  const actorUsername = requireString(input.actorUsername, 'attendance_manual_actor', { maxLength: 120 });
  const actorRole = normalizeString(input.actorRole)?.slice(0, 60) || null;
  const arrivalAt = manualWorkday
    ? manualDateTime(input.arrivalReportedAt, 'attendance_manual_arrival_reported_at')
    : (input.reportedAt ? new Date(input.reportedAt) : (input.now instanceof Date ? input.now : new Date()));
  if (Number.isNaN(arrivalAt.getTime())) throw new Error('attendance_manual_reported_at_invalid');
  const departureAt = manualWorkday
    ? manualDateTime(input.departureReportedAt, 'attendance_manual_departure_reported_at')
    : null;
  const breakTaken = manualWorkday && enabledFlag(input.breakTaken);
  const breakStartAt = breakTaken
    ? manualDateTime(input.breakStartAt, 'attendance_manual_break_start_at')
    : null;
  const breakEndAt = breakTaken
    ? manualDateTime(input.breakEndAt, 'attendance_manual_break_end_at')
    : null;
  const validationAt = input.now instanceof Date ? new Date(input.now.getTime()) : new Date();
  if (Number.isNaN(validationAt.getTime())) throw new Error('attendance_manual_now_invalid');

  return prisma.$transaction(async (tx) => {
    const assignment = await tx.dispatchAssignment.findUnique({
      where: { id: assignmentId },
      include: {
        worker: true,
        attendanceSession: true,
        serviceRequest: { include: { operationPoint: true } }
      }
    });
    if (!assignment) throw new Error('attendance_manual_assignment_not_found');
    if (!ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status)) {
      throw new Error('attendance_manual_assignment_inactive');
    }
    const point = assignment.serviceRequest?.operationPoint;
    if (point?.manualAttendanceAllowed !== true) {
      throw new Error('attendance_manual_not_allowed');
    }
    if (assignment.attendanceSession?.arrivalReportedAt || assignment.attendanceSession?.departureReportedAt) {
      throw new Error('attendance_manual_arrival_exists');
    }

    const expected = buildDispatchAttendanceExpectedWindow(assignment.serviceRequest);
    const punctualityStatus = manualWorkday
      ? (arrivalAt.getTime() > expected.expectedStartAt.getTime() ? 'LATE' : 'ON_TIME')
      : attendanceStatus;
    const work = manualWorkday
      ? calculateDispatchWorkedTime({
          arrivalAt,
          departureAt,
          expectedStartAt: expected.expectedStartAt,
          expectedEndAt: expected.expectedEndAt,
          breakStartAt,
          breakEndAt,
          recognizeEarlyArrival: false
        })
      : null;
    const nextAttendanceStatus = manualWorkday ? 'COMPLETED' : attendanceStatus;
    const sessionData = {
      attendanceStatus: nextAttendanceStatus,
      validationStatus: 'MANUAL_VALIDATED',
      punctualityStatus,
      arrivalReportedAt: arrivalAt,
      arrivalValidatedAt: manualWorkday ? validationAt : arrivalAt,
      source: 'MANUAL',
      riskScore: 0,
      riskFlags: [],
      ...(manualWorkday ? {
        departureReportedAt: departureAt,
        departureValidatedAt: validationAt,
        workedMinutes: work.workedMinutes
      } : {})
    };
    const session = assignment.attendanceSession
      ? await tx.dispatchAttendanceSession.update({
          where: { id: assignment.attendanceSession.id },
          data: sessionData
        })
      : await tx.dispatchAttendanceSession.create({
          data: {
            assignmentId: assignment.id,
            expectedStartAt: expected.expectedStartAt,
            expectedEndAt: expected.expectedEndAt,
            ...sessionData
          }
        });

    const createManualMark = async (markType, capturedAt) => tx.dispatchAttendanceMark.create({
      data: {
        attendanceSessionId: session.id,
        markType,
        idempotencyKey: `manual-${randomUUID()}`,
        serverReceivedAt: manualWorkday ? validationAt : arrivalAt,
        clientCapturedAt: capturedAt,
        decision: 'MANUAL_VALIDATED',
        riskScore: 0,
        riskFlags: []
      }
    });

    await createManualMark('ARRIVAL', arrivalAt);
    if (breakTaken) {
      await createManualMark('BREAK_START', breakStartAt);
      await createManualMark('BREAK_END', breakEndAt);
    }
    if (manualWorkday) await createManualMark('DEPARTURE', departureAt);

    await tx.dispatchAttendanceReview.create({
      data: {
        attendanceSessionId: session.id,
        action: manualWorkday ? 'MANUAL_WORKDAY' : 'MANUAL_MARK',
        previousAttendanceStatus: assignment.attendanceSession?.attendanceStatus || null,
        newAttendanceStatus: nextAttendanceStatus,
        previousValidationStatus: assignment.attendanceSession?.validationStatus || null,
        newValidationStatus: 'MANUAL_VALIDATED',
        reason,
        notes,
        actorUsername,
        actorRole,
        metadata: {
          workerId: assignment.workerId,
          workerName: assignment.worker?.fullName || null,
          serviceRequestId: assignment.serviceRequestId,
          assignmentId: assignment.id,
          ...(manualWorkday ? {
            manualArrivalReportedAt: arrivalAt.toISOString(),
            manualDepartureReportedAt: departureAt.toISOString(),
            breakTaken,
            manualBreakStartAt: breakStartAt?.toISOString() || null,
            manualBreakEndAt: breakEndAt?.toISOString() || null,
            workedMinutes: work.workedMinutes,
            punctualityStatus
          } : {
            manualReportedAt: arrivalAt.toISOString()
          })
        }
      }
    });
    return session;
  });
}
