import { resolveAttendanceFailureDecision } from './adminAttendance.js';

const ATTENDANCE_FAILURE_ENTITY = 'DISPATCH_ATTENDANCE_MARK_FAILURE';
const ATTENDANCE_FAILURE_ACTION = 'MARK_ATTEMPT_FAILED';
const FAILURE_EVENT_ID_PATTERN = /^attendance_failure_[a-f0-9]{48}$/;

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length ? normalized : null;
}

export function normalizeAttendanceFailureMarkType(value) {
  const normalized = normalizeString(value)?.toUpperCase() || null;
  return ['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE'].includes(normalized) ? normalized : null;
}

function failureMoment(event) {
  const metadata = event?.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
    ? event.metadata
    : {};
  const date = new Date(metadata.occurredAt || event?.createdAt || Number.NaN);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

export function attendanceFailureMarkAlreadyRecorded(assignment, markType) {
  const normalized = normalizeAttendanceFailureMarkType(markType);
  const session = assignment?.attendanceSession || null;
  if (!session || !normalized) return false;
  if (normalized === 'ARRIVAL' && session.arrivalReportedAt) return true;
  if (normalized === 'DEPARTURE' && session.departureReportedAt) return true;
  return (Array.isArray(session.marks) ? session.marks : []).some((mark) => (
    normalizeAttendanceFailureMarkType(mark?.markType) === normalized
  ));
}

async function latestFailureForMark(prisma, assignmentId, markType) {
  if (typeof prisma?.devAuditEvent?.findMany !== 'function') {
    throw new Error('attendance_failure_decision_audit_contract_invalid');
  }
  const events = await prisma.devAuditEvent.findMany({
    where: {
      entityType: ATTENDANCE_FAILURE_ENTITY,
      action: ATTENDANCE_FAILURE_ACTION,
      entityId: assignmentId
    },
    orderBy: { createdAt: 'desc' }
  });
  return events
    .filter((event) => {
      const metadata = event?.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
        ? event.metadata
        : {};
      return event?.entityType === ATTENDANCE_FAILURE_ENTITY
        && event?.action === ATTENDANCE_FAILURE_ACTION
        && normalizeString(event?.entityId) === assignmentId
        && normalizeAttendanceFailureMarkType(metadata.markType) === markType;
    })
    .sort((left, right) => failureMoment(right).getTime() - failureMoment(left).getTime())[0] || null;
}

export async function resolveCurrentAttendanceFailureDecision(prisma, input = {}) {
  const requestedFailureEventId = normalizeString(input.failureEventId);
  if (!requestedFailureEventId || !FAILURE_EVENT_ID_PATTERN.test(requestedFailureEventId)) {
    throw new Error('attendance_failure_decision_invalid');
  }
  if (typeof prisma?.devAuditEvent?.findUnique !== 'function' || typeof prisma?.dispatchAssignment?.findUnique !== 'function') {
    throw new Error('attendance_failure_decision_audit_contract_invalid');
  }

  const requestedFailure = await prisma.devAuditEvent.findUnique({ where: { id: requestedFailureEventId } });
  if (requestedFailure?.entityType !== ATTENDANCE_FAILURE_ENTITY || requestedFailure?.action !== ATTENDANCE_FAILURE_ACTION) {
    throw new Error('attendance_failure_decision_not_found');
  }
  const metadata = requestedFailure.metadata && typeof requestedFailure.metadata === 'object' && !Array.isArray(requestedFailure.metadata)
    ? requestedFailure.metadata
    : {};
  const assignmentId = normalizeString(metadata.assignmentId);
  const markType = normalizeAttendanceFailureMarkType(metadata.markType);
  if (!assignmentId || !markType) throw new Error('attendance_failure_decision_context_invalid');

  const assignment = await prisma.dispatchAssignment.findUnique({
    where: { id: assignmentId },
    select: {
      id: true,
      attendanceSession: {
        select: {
          arrivalReportedAt: true,
          departureReportedAt: true,
          marks: { select: { markType: true } }
        }
      }
    }
  });
  if (!assignment) throw new Error('attendance_failure_decision_assignment_not_found');

  if (attendanceFailureMarkAlreadyRecorded(assignment, markType)) {
    return {
      handled: true,
      duplicate: true,
      alreadyRecorded: true,
      status: 'RECORDED',
      assignmentId,
      markType
    };
  }

  const latestFailure = await latestFailureForMark(prisma, assignmentId, markType);
  if (!latestFailure) throw new Error('attendance_failure_decision_not_found');
  const followLatestFailure = input.followLatestFailure === true;
  if (latestFailure.id !== requestedFailureEventId && !followLatestFailure) {
    return {
      handled: true,
      duplicate: true,
      superseded: true,
      status: 'SUPERSEDED',
      assignmentId,
      markType,
      latestFailureEventId: latestFailure.id
    };
  }

  const { followLatestFailure: _followLatestFailure, ...decisionInput } = input;
  return resolveAttendanceFailureDecision(prisma, {
    ...decisionInput,
    failureEventId: followLatestFailure ? latestFailure.id : requestedFailureEventId
  });
}
