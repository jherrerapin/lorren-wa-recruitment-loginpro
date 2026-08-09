import {
  DISPATCH_BREAK_STATUS,
  STANDARD_DISPATCH_WORKDAY_MINUTES,
  calculateDispatchWorkedTime,
  formatDispatchMinutes
} from '../domain/attendanceWorkdayPolicy.js';
import { reviewAttendanceSession } from './adminAttendance.js';

const BOGOTA_TIME_ZONE = 'America/Bogota';
const VALID_WORKDAY_REVIEW_ACTIONS = new Set(['VALIDATE', 'REJECT', 'REOPEN', 'CLEAR']);
const VALID_PUNCTUALITY_STATUSES = new Set(['ON_TIME', 'LATE']);
const CLEAR_MARKS_REVIEW_REASON = 'Marcaciones eliminadas por coordinación para corregir la jornada.';

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

function markMoment(mark) {
  const raw = mark?.clientCapturedAt || mark?.serverReceivedAt;
  if (!raw) return null;
  const date = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function latestMark(marks, markType) {
  return (Array.isArray(marks) ? marks : [])
    .filter((mark) => mark.markType === markType)
    .sort((left, right) => (markMoment(right)?.getTime() || 0) - (markMoment(left)?.getTime() || 0))[0] || null;
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

function safeWorkCalculation(input) {
  try {
    return calculateDispatchWorkedTime(input);
  } catch {
    return null;
  }
}

function breakRuleLabel(work) {
  if (!work) return 'Pendiente de salida';
  if (work.breakStatus === DISPATCH_BREAK_STATUS.INCOMPLETE) {
    return 'Se tomó 1 h 30 min de almuerzo por no marcar la terminación.';
  }
  if (work.breakStatus === DISPATCH_BREAK_STATUS.NONE) {
    return 'No tomó almuerzo; ese tiempo cuenta como trabajado.';
  }
  if (work.shortBreakMinutesCredited > 0) {
    return `Tomó ${formatDispatchMinutes(work.actualBreakMinutes)} de almuerzo; ${formatDispatchMinutes(work.shortBreakMinutesCredited)} se sumaron al tiempo trabajado.`;
  }
  return `Almuerzo descontado según las marcaciones reales: ${formatDispatchMinutes(work.actualBreakMinutes)}.`;
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

  return {
    ...board,
    rows: rows.map((row) => {
      const assignment = assignmentMap.get(row.assignmentId);
      const session = assignment?.attendanceSession || null;
      const marks = session?.marks || [];
      const arrivalMark = latestMark(marks, 'ARRIVAL');
      const departureMark = latestMark(marks, 'DEPARTURE');
      const breakStartMark = latestMark(marks, 'BREAK_START');
      const breakEndMark = latestMark(marks, 'BREAK_END');
      const arrivalAt = session?.arrivalReportedAt ? new Date(session.arrivalReportedAt) : null;
      const departureAt = session?.departureReportedAt ? new Date(session.departureReportedAt) : null;
      const expectedStartAt = session?.expectedStartAt
        ? new Date(session.expectedStartAt)
        : (row.expectedStartAt ? new Date(row.expectedStartAt) : null);
      const expectedEndAt = session?.expectedEndAt ? new Date(session.expectedEndAt) : null;
      const breakStartAt = markMoment(breakStartMark);
      const breakEndAt = markMoment(breakEndMark);
      const defaultWork = arrivalAt && departureAt
        ? safeWorkCalculation({
            arrivalAt,
            departureAt,
            expectedStartAt,
            expectedEndAt,
            breakStartAt,
            breakEndAt,
            recognizeEarlyArrival: false
          })
        : null;
      const recognizedWork = arrivalAt && departureAt
        ? safeWorkCalculation({
            arrivalAt,
            departureAt,
            expectedStartAt,
            expectedEndAt,
            breakStartAt,
            breakEndAt,
            recognizeEarlyArrival: true
          })
        : null;
      const workedMinutes = Number.isInteger(session?.workedMinutes)
        ? session.workedMinutes
        : defaultWork?.workedMinutes ?? null;
      const earlyTimeRecognized = Boolean(
        defaultWork
        && recognizedWork
        && defaultWork.earlyMinutesExcluded > 0
        && workedMinutes === recognizedWork.workedMinutes
      );
      const ordinaryWorkedMinutes = workedMinutes === null
        ? null
        : Math.min(workedMinutes, STANDARD_DISPATCH_WORKDAY_MINUTES);
      const overtimeMinutes = workedMinutes === null
        ? null
        : Math.max(0, workedMinutes - STANDARD_DISPATCH_WORKDAY_MINUTES);

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
        effectiveWorkStartAt: defaultWork?.effectiveWorkStartAt?.toISOString?.() || null,
        effectiveWorkStartLabel: defaultWork ? formatDateTime(defaultWork.effectiveWorkStartAt) : 'Pendiente',
        recordedSpanMinutes: defaultWork?.recordedSpanMinutes ?? null,
        recordedSpanLabel: defaultWork ? formatDispatchMinutes(defaultWork.recordedSpanMinutes) : 'Pendiente de salida',
        grossWorkedMinutes: defaultWork?.grossWorkedMinutes ?? null,
        grossWorkedLabel: defaultWork ? formatDispatchMinutes(defaultWork.grossWorkedMinutes) : 'Pendiente de salida',
        earlyMinutesExcluded: earlyTimeRecognized ? 0 : (defaultWork?.earlyMinutesExcluded ?? 0),
        earlyMinutesExcludedLabel: formatDispatchMinutes(earlyTimeRecognized ? 0 : (defaultWork?.earlyMinutesExcluded ?? 0)),
        earlyTimeRecognized,
        canRecognizeEarlyArrival: Boolean(defaultWork?.earlyMinutesExcluded > 0),
        breakStarted: Boolean(breakStartAt),
        breakEnded: Boolean(breakEndAt),
        breakOpen: Boolean(breakStartAt && !breakEndAt),
        breakStartAt: breakStartAt?.toISOString() || null,
        breakEndAt: breakEndAt?.toISOString() || null,
        breakStartLabel: formatDateTime(breakStartAt),
        breakEndLabel: formatDateTime(breakEndAt),
        breakStatus: defaultWork?.breakStatus || null,
        breakPenaltyApplied: defaultWork?.breakStatus === DISPATCH_BREAK_STATUS.INCOMPLETE,
        actualBreakMinutes: defaultWork?.actualBreakMinutes ?? null,
        shortBreakMinutesCredited: defaultWork?.shortBreakMinutesCredited ?? 0,
        shortBreakMinutesCreditedLabel: formatDispatchMinutes(defaultWork?.shortBreakMinutesCredited ?? 0),
        unpaidBreakMinutesDeducted: defaultWork?.unpaidBreakMinutesDeducted ?? 0,
        unpaidBreakLabel: formatDispatchMinutes(defaultWork?.unpaidBreakMinutesDeducted ?? 0),
        workedMinutes,
        workedLabel: workedMinutes === null ? 'Pendiente de salida' : formatDispatchMinutes(workedMinutes),
        ordinaryWorkedMinutes,
        ordinaryWorkedLabel: ordinaryWorkedMinutes === null ? 'Pendiente de salida' : formatDispatchMinutes(ordinaryWorkedMinutes),
        overtimeMinutes,
        overtimeLabel: overtimeMinutes === null ? 'Pendiente de salida' : formatDispatchMinutes(overtimeMinutes),
        standardWorkdayMinutes: STANDARD_DISPATCH_WORKDAY_MINUTES,
        standardWorkdayLabel: formatDispatchMinutes(STANDARD_DISPATCH_WORKDAY_MINUTES),
        breakPolicy: 'ACTUAL_MARKS_WITH_INCOMPLETE_PENALTY',
        configuredUnpaidBreakMinutes: 0,
        configuredBreakLabel: breakRuleLabel(defaultWork)
      };
    })
  };
}

function clearedSessionData() {
  return {
    attendanceStatus: 'PENDING',
    validationStatus: 'PENDING',
    punctualityStatus: null,
    riskScore: 0,
    riskFlags: [],
    arrivalReportedAt: null,
    arrivalValidatedAt: null,
    departureReportedAt: null,
    departureValidatedAt: null,
    workedMinutes: null
  };
}

async function clearAttendanceWorkdayMarks(prisma, input = {}) {
  const sessionId = requireString(input.sessionId, 'attendance_review_session_id', { maxLength: 120 });
  const actorUsername = requireString(input.actorUsername, 'attendance_review_actor', { maxLength: 120 });
  const actorRole = normalizeString(input.actorRole)?.slice(0, 60) || null;
  const now = input.now instanceof Date ? input.now : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('attendance_review_now_invalid');
  if (typeof prisma.$transaction !== 'function') throw new Error('attendance_workday_transaction_required');

  return prisma.$transaction(async (tx) => {
    if (!tx?.dispatchAttendanceSession || typeof tx.dispatchAttendanceSession.findUnique !== 'function' || typeof tx.dispatchAttendanceSession.update !== 'function') {
      throw new Error('attendance_workday_session_writer_required');
    }
    if (!tx?.dispatchAttendanceMark || typeof tx.dispatchAttendanceMark.deleteMany !== 'function') {
      throw new Error('attendance_workday_mark_delete_required');
    }
    if (!tx?.dispatchAttendanceReview || typeof tx.dispatchAttendanceReview.create !== 'function') {
      throw new Error('attendance_workday_review_writer_required');
    }

    const session = await tx.dispatchAttendanceSession.findUnique({
      where: { id: sessionId },
      include: {
        marks: { orderBy: { serverReceivedAt: 'asc' } },
        assignment: {
          include: { worker: true, serviceRequest: true }
        }
      }
    });
    if (!session) throw new Error('attendance_review_session_not_found');
    const marks = Array.isArray(session.marks) ? session.marks : [];
    if (!marks.length && !session.arrivalReportedAt && !session.departureReportedAt) {
      throw new Error('attendance_review_no_marks_to_clear');
    }

    const removedMarks = marks.map((mark) => ({
      markType: mark.markType || null,
      capturedAt: markMoment(mark)?.toISOString() || null,
      decision: mark.decision || null,
      hadEvidence: Boolean(mark.evidenceStorageKey)
    }));
    const next = clearedSessionData();

    await tx.dispatchAttendanceMark.deleteMany({
      where: { attendanceSessionId: session.id }
    });
    const updated = await tx.dispatchAttendanceSession.update({
      where: { id: session.id },
      data: next
    });
    await tx.dispatchAttendanceReview.create({
      data: {
        attendanceSessionId: session.id,
        action: 'WORKDAY_CLEAR_MARKS',
        previousAttendanceStatus: session.attendanceStatus,
        newAttendanceStatus: next.attendanceStatus,
        previousValidationStatus: session.validationStatus,
        newValidationStatus: next.validationStatus,
        reason: CLEAR_MARKS_REVIEW_REASON,
        notes: null,
        actorUsername,
        actorRole,
        metadata: {
          workerId: session.assignment?.workerId || null,
          workerName: session.assignment?.worker?.fullName || null,
          serviceRequestId: session.assignment?.serviceRequestId || null,
          assignmentId: session.assignmentId,
          removedMarkCount: marks.length,
          removedMarks,
          previousArrivalReportedAt: session.arrivalReportedAt?.toISOString?.() || null,
          previousDepartureReportedAt: session.departureReportedAt?.toISOString?.() || null,
          previousWorkedMinutes: Number.isInteger(session.workedMinutes) ? session.workedMinutes : null,
          clearedAt: now.toISOString()
        }
      }
    });
    return updated;
  });
}

function workdayTransition(session, action, now, requestedAttendanceStatus, workedMinutes) {
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
      departureValidatedAt: now,
      workedMinutes
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

export async function reviewAttendanceWorkdaySession(prisma, input = {}) {
  const sessionId = requireString(input.sessionId, 'attendance_review_session_id', { maxLength: 120 });
  const action = requireString(input.action, 'attendance_review_action', { maxLength: 40 }).toUpperCase();
  if (!VALID_WORKDAY_REVIEW_ACTIONS.has(action)) throw new Error('attendance_review_action_invalid');
  if (action === 'CLEAR') {
    return clearAttendanceWorkdayMarks(prisma, { ...input, sessionId });
  }

  if (!prisma?.dispatchAttendanceSession || typeof prisma.dispatchAttendanceSession.findUnique !== 'function') {
    throw new Error('attendance_workday_session_reader_required');
  }
  const snapshot = await prisma.dispatchAttendanceSession.findUnique({
    where: { id: sessionId },
    select: { departureReportedAt: true }
  });
  if (!snapshot) throw new Error('attendance_review_session_not_found');
  if (!snapshot.departureReportedAt) return reviewAttendanceSession(prisma, input);

  const reason = requireString(input.reason, 'attendance_review_reason', { minLength: 5, maxLength: 500 });
  const notes = normalizeString(input.notes)?.slice(0, 1000) || null;
  const actorUsername = requireString(input.actorUsername, 'attendance_review_actor', { maxLength: 120 });
  const actorRole = normalizeString(input.actorRole)?.slice(0, 60) || null;
  const recognizeEarlyArrival = input.recognizeEarlyArrival === true;
  const now = input.now instanceof Date ? input.now : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('attendance_review_now_invalid');
  if (typeof prisma.$transaction !== 'function') throw new Error('attendance_workday_transaction_required');

  return prisma.$transaction(async (tx) => {
    const session = await tx.dispatchAttendanceSession.findUnique({
      where: { id: sessionId },
      include: {
        marks: { orderBy: { serverReceivedAt: 'asc' } },
        assignment: {
          include: { worker: true, serviceRequest: true }
        }
      }
    });
    if (!session) throw new Error('attendance_review_session_not_found');
    if (!session.departureReportedAt) throw new Error('attendance_review_departure_required');

    const breakStartAt = markMoment(latestMark(session.marks, 'BREAK_START'));
    const breakEndAt = markMoment(latestMark(session.marks, 'BREAK_END'));
    const work = calculateDispatchWorkedTime({
      arrivalAt: session.arrivalReportedAt,
      departureAt: session.departureReportedAt,
      expectedStartAt: session.expectedStartAt,
      expectedEndAt: session.expectedEndAt,
      breakStartAt,
      breakEndAt,
      recognizeEarlyArrival
    });
    const transition = workdayTransition(session, action, now, input.attendanceStatus, work.workedMinutes);
    const updated = await tx.dispatchAttendanceSession.update({
      where: { id: session.id },
      data: transition
    });
    const departureMark = latestMark(session.marks, 'DEPARTURE');
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
          workedMinutes: action === 'VALIDATE' ? work.workedMinutes : session.workedMinutes,
          ordinaryWorkedMinutes: work.ordinaryWorkedMinutes,
          overtimeMinutes: work.overtimeMinutes,
          recordedSpanMinutes: work.recordedSpanMinutes,
          unpaidBreakMinutesDeducted: work.unpaidBreakMinutesDeducted,
          actualBreakMinutes: work.actualBreakMinutes,
          shortBreakMinutesCredited: work.shortBreakMinutesCredited,
          breakStatus: work.breakStatus,
          breakPenaltyMinutes: work.breakPenaltyMinutes,
          earlyMinutesExcluded: work.earlyMinutesExcluded,
          recognizeEarlyArrival,
          breakStartAt: breakStartAt?.toISOString() || null,
          breakEndAt: breakEndAt?.toISOString() || null,
          punctualityStatus: transition.punctualityStatus || session.punctualityStatus || null
        }
      }
    });
    return updated;
  });
}
