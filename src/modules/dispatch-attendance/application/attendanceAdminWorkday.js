import {
  getDispatchAttendanceBreakPolicies
} from '../infrastructure/dispatchAttendanceBreakPolicyRepository.js';
import { formatDispatchMinutes } from '../domain/attendanceWorkdayPolicy.js';
import { reviewAttendanceSession } from './adminAttendance.js';

const BOGOTA_TIME_ZONE = 'America/Bogota';
const VALID_WORKDAY_REVIEW_ACTIONS = new Set(['VALIDATE', 'REJECT', 'REOPEN']);
const VALID_PUNCTUALITY_STATUSES = new Set(['ON_TIME', 'LATE']);

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

function formatDateTime(value) {
  if (!value) return 'Sin registro';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sin registro';
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: BOGOTA_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(date);
}

function latestMark(marks, markType) {
  return (Array.isArray(marks) ? marks : [])
    .filter((mark) => mark.markType === markType)
    .sort((left, right) => new Date(right.serverReceivedAt || 0) - new Date(left.serverReceivedAt || 0))[0] || null;
}

function numericCoordinate(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function reportedLateMinutes(arrivalAt, expectedStartAt) {
  if (!validDate(arrivalAt) || !validDate(expectedStartAt)) return 0;
  return Math.max(0, Math.floor((arrivalAt.getTime() - expectedStartAt.getTime()) / 60_000));
}

export async function enrichAttendanceBoardWithWorkday(prisma, board) {
  const rows = Array.isArray(board?.rows) ? board.rows : [];
  if (!rows.length) return board;
  if (!prisma?.dispatchAssignment || typeof prisma.dispatchAssignment.findMany !== 'function') {
    throw new Error('attendance_workday_assignment_reader_required');
  }
  const assignments = await prisma.dispatchAssignment.findMany({
    where: { id: { in: rows.map((row) => row.assignmentId) } },
    include: {
      attendanceSession: {
        include: { marks: { orderBy: { serverReceivedAt: 'desc' } } }
      }
    }
  });
  const assignmentMap = new Map(assignments.map((assignment) => [assignment.id, assignment]));
  const policies = await getDispatchAttendanceBreakPolicies(
    prisma,
    assignments.map((assignment) => assignment.serviceRequestId)
  );

  return {
    ...board,
    rows: rows.map((row) => {
      const assignment = assignmentMap.get(row.assignmentId);
      const session = assignment?.attendanceSession || null;
      const arrivalMark = latestMark(session?.marks, 'ARRIVAL');
      const departureMark = latestMark(session?.marks, 'DEPARTURE');
      const arrivalAt = session?.arrivalReportedAt ? new Date(session.arrivalReportedAt) : null;
      const departureAt = session?.departureReportedAt ? new Date(session.departureReportedAt) : null;
      const expectedStartAt = row.expectedStartAt ? new Date(row.expectedStartAt) : null;
      const grossWorkedMinutes = arrivalAt && departureAt
        ? Math.max(0, Math.floor((departureAt.getTime() - arrivalAt.getTime()) / 60_000))
        : null;
      const workedMinutes = Number.isInteger(session?.workedMinutes) ? session.workedMinutes : null;
      const deducted = grossWorkedMinutes !== null && workedMinutes !== null
        ? Math.max(0, grossWorkedMinutes - workedMinutes)
        : null;
      const policy = policies.get(assignment?.serviceRequestId) || { policy: 'NONE', unpaidBreakMinutes: 0 };

      return {
        ...row,
        serviceRequestId: assignment?.serviceRequestId || null,
        arrivalMarkId: arrivalMark?.id || row.markId || null,
        departureMarkId: departureMark?.id || null,
        arrivalEvidenceAvailable: Boolean(arrivalMark?.evidenceStorageKey),
        departureEvidenceAvailable: Boolean(departureMark?.evidenceStorageKey),
        arrivalLatitude: numericCoordinate(arrivalMark?.latitude, -90, 90),
        arrivalLongitude: numericCoordinate(arrivalMark?.longitude, -180, 180),
        departureLatitude: numericCoordinate(departureMark?.latitude, -90, 90),
        departureLongitude: numericCoordinate(departureMark?.longitude, -180, 180),
        lateMinutes: reportedLateMinutes(arrivalAt, expectedStartAt),
        departureReportedAt: session?.departureReportedAt?.toISOString?.() || null,
        departureReportedLabel: formatDateTime(session?.departureReportedAt),
        grossWorkedMinutes,
        grossWorkedLabel: grossWorkedMinutes === null ? 'Pendiente de salida' : formatDispatchMinutes(grossWorkedMinutes),
        unpaidBreakMinutesDeducted: deducted,
        unpaidBreakLabel: deducted === null ? 'Pendiente' : formatDispatchMinutes(deducted),
        workedMinutes,
        workedLabel: workedMinutes === null ? 'Pendiente de salida' : formatDispatchMinutes(workedMinutes),
        breakPolicy: policy.policy,
        configuredUnpaidBreakMinutes: policy.unpaidBreakMinutes,
        configuredBreakLabel: policy.unpaidBreakMinutes > 0
          ? `${policy.unpaidBreakMinutes} min no remunerados`
          : 'Sin descanso no remunerado'
      };
    })
  };
}

function workdayTransition(session, action, now, requestedAttendanceStatus) {
  if (action === 'VALIDATE') {
    const punctualityStatus = requireString(
      requestedAttendanceStatus,
      'attendance_review_status',
      { maxLength: 40 }
    ).toUpperCase();
    if (!VALID_PUNCTUALITY_STATUSES.has(punctualityStatus)) {
      throw new Error('attendance_review_status_invalid');
    }
    return {
      attendanceStatus: 'COMPLETED',
      validationStatus: 'MANUAL_VALIDATED',
      punctualityStatus,
      arrivalValidatedAt: session.arrivalValidatedAt || now,
      departureValidatedAt: now
    };
  }
  if (action === 'REJECT') {
    return {
      attendanceStatus: 'REJECTED',
      validationStatus: 'REJECTED',
      arrivalValidatedAt: null,
      departureValidatedAt: null
    };
  }
  if (action === 'REOPEN') {
    return {
      attendanceStatus: 'DEPARTURE_REPORTED',
      validationStatus: 'REVIEW_REQUIRED',
      departureValidatedAt: null
    };
  }
  throw new Error('attendance_review_action_invalid');
}

/**
 * Conserva la semántica de jornada cerrada cuando ya existe una salida.
 * Las asistencias que solo tienen llegada siguen usando la autoridad histórica.
 */
export async function reviewAttendanceWorkdaySession(prisma, input = {}) {
  const sessionId = requireString(input.sessionId, 'attendance_review_session_id', { maxLength: 120 });
  if (!prisma?.dispatchAttendanceSession || typeof prisma.dispatchAttendanceSession.findUnique !== 'function') {
    throw new Error('attendance_workday_session_reader_required');
  }
  const snapshot = await prisma.dispatchAttendanceSession.findUnique({
    where: { id: sessionId },
    select: { departureReportedAt: true }
  });
  if (!snapshot) throw new Error('attendance_review_session_not_found');
  if (!snapshot.departureReportedAt) return reviewAttendanceSession(prisma, input);

  const action = requireString(input.action, 'attendance_review_action', { maxLength: 40 }).toUpperCase();
  if (!VALID_WORKDAY_REVIEW_ACTIONS.has(action)) throw new Error('attendance_review_action_invalid');
  const reason = requireString(input.reason, 'attendance_review_reason', { minLength: 5, maxLength: 500 });
  const notes = normalizeString(input.notes)?.slice(0, 1000) || null;
  const actorUsername = requireString(input.actorUsername, 'attendance_review_actor', { maxLength: 120 });
  const actorRole = normalizeString(input.actorRole)?.slice(0, 60) || null;
  const now = input.now instanceof Date ? input.now : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('attendance_review_now_invalid');
  if (typeof prisma.$transaction !== 'function') throw new Error('attendance_workday_transaction_required');

  return prisma.$transaction(async (tx) => {
    const session = await tx.dispatchAttendanceSession.findUnique({
      where: { id: sessionId },
      include: {
        assignment: {
          include: { worker: true, serviceRequest: true }
        }
      }
    });
    if (!session) throw new Error('attendance_review_session_not_found');
    if (!session.departureReportedAt) throw new Error('attendance_review_departure_required');

    const transition = workdayTransition(session, action, now, input.attendanceStatus);
    const updated = await tx.dispatchAttendanceSession.update({
      where: { id: session.id },
      data: transition
    });
    const departureMark = await tx.dispatchAttendanceMark.findFirst({
      where: { attendanceSessionId: session.id, markType: 'DEPARTURE' },
      orderBy: { serverReceivedAt: 'desc' }
    });
    if (departureMark) {
      await tx.dispatchAttendanceMark.update({
        where: { id: departureMark.id },
        data: { decision: transition.validationStatus }
      });
    }
    await tx.dispatchAttendanceReview.create({
      data: {
        attendanceSessionId: session.id,
        action: `WORKDAY_${action}`,
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
          assignmentId: session.assignmentId,
          departureReportedAt: session.departureReportedAt.toISOString(),
          workedMinutes: session.workedMinutes,
          punctualityStatus: transition.punctualityStatus || session.punctualityStatus || null
        }
      }
    });
    return updated;
  });
}
