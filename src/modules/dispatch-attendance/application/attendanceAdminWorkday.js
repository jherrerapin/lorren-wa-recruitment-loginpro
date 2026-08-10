import { randomUUID } from 'node:crypto';
import {
  DISPATCH_BREAK_STATUS,
  STANDARD_DISPATCH_WORKDAY_MINUTES,
  calculateDispatchWorkedTime,
  formatDispatchMinutes
} from '../domain/attendanceWorkdayPolicy.js';
import {
  reviewAttendanceSession,
  validateAttendanceTimelineAgainstAssignment
} from './adminAttendance.js';

const BOGOTA_TIME_ZONE = 'America/Bogota';
const VALID_WORKDAY_REVIEW_ACTIONS = new Set(['VALIDATE', 'REJECT', 'REOPEN', 'CLEAR', 'DELETE_MARK', 'ADD_MARK']);
const VALID_PUNCTUALITY_STATUSES = new Set(['ON_TIME', 'LATE']);
const VALID_CORRECTION_MARK_TYPES = new Set(['ARRIVAL', 'BREAK_START', 'BREAK_END', 'DEPARTURE']);
const CLEAR_MARKS_REVIEW_REASON = 'Marcaciones eliminadas por coordinación para corregir la jornada.';
const DELETE_MARK_REVIEW_REASON = 'Marcación individual eliminada por coordinación para corregir la jornada.';
const ADD_MARK_REVIEW_REASON = 'Marcación individual registrada por coordinación para corregir la jornada.';
const MANUAL_MARK_REVIEW_REASON = 'Marcación manual individual registrada por coordinación.';

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

function dateValue(value) {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
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

function pendingCorrectionMarkTypes(reviews) {
  const states = new Map();
  for (const review of Array.isArray(reviews) ? reviews : []) {
    if (['WORKDAY_CLEAR_MARKS', 'MANUAL_WORKDAY'].includes(review?.action)) break;
    if (!['WORKDAY_DELETE_MARK', 'WORKDAY_ADD_MARK'].includes(review?.action)) continue;
    const markType = normalizeString(review?.metadata?.markType)?.toUpperCase() || null;
    if (!markType || !VALID_CORRECTION_MARK_TYPES.has(markType) || states.has(markType)) continue;
    states.set(markType, review.action === 'WORKDAY_DELETE_MARK');
  }
  return [...states.entries()].filter(([, pending]) => pending).map(([markType]) => markType);
}

function markCorrectionPending(reviews, markType) {
  return pendingCorrectionMarkTypes(reviews).includes(markType);
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
        include: {
          marks: { orderBy: { serverReceivedAt: 'desc' } },
          reviews: { orderBy: { createdAt: 'desc' } }
        }
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
      const pendingCorrections = pendingCorrectionMarkTypes(session?.reviews);
      const correctionPending = pendingCorrections.length > 0;
      const arrivalMark = latestMark(marks, 'ARRIVAL');
      const departureMark = latestMark(marks, 'DEPARTURE');
      const breakStartMark = latestMark(marks, 'BREAK_START');
      const breakEndMark = latestMark(marks, 'BREAK_END');
      const arrivalAt = markMoment(arrivalMark) || (session?.arrivalReportedAt ? new Date(session.arrivalReportedAt) : null);
      const departureAt = markMoment(departureMark) || (session?.departureReportedAt ? new Date(session.departureReportedAt) : null);
      const expectedStartAt = session?.expectedStartAt
        ? new Date(session.expectedStartAt)
        : (row.expectedStartAt ? new Date(row.expectedStartAt) : null);
      const expectedEndAt = session?.expectedEndAt ? new Date(session.expectedEndAt) : null;
      const breakStartAt = markMoment(breakStartMark);
      const breakEndAt = markMoment(breakEndMark);
      const defaultWork = arrivalAt && departureAt && !correctionPending
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
      const recognizedWork = arrivalAt && departureAt && !correctionPending
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
      const workedMinutes = correctionPending
        ? null
        : (Number.isInteger(session?.workedMinutes) ? session.workedMinutes : defaultWork?.workedMinutes ?? null);
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
        breakStartMarkId: breakStartMark?.id || null,
        breakEndMarkId: breakEndMark?.id || null,
        pendingCorrectionMarkTypes: pendingCorrections,
        arrivalEvidenceAvailable: Boolean(arrivalMark?.evidenceStorageKey),
        departureEvidenceAvailable: Boolean(departureMark?.evidenceStorageKey),
        arrivalLatitude: numericCoordinate(arrivalMark?.latitude, -90, 90),
        arrivalLongitude: numericCoordinate(arrivalMark?.longitude, -180, 180),
        departureLatitude: numericCoordinate(departureMark?.latitude, -90, 90),
        departureLongitude: numericCoordinate(departureMark?.longitude, -180, 180),
        lateMinutes: reportedLateMinutes(arrivalAt, expectedStartAt),
        departureReportedAt: departureAt?.toISOString() || null,
        departureReportedLabel: formatDateTime(departureAt),
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
        configuredBreakLabel: correctionPending ? 'Corrección de marcación pendiente.' : breakRuleLabel(defaultWork)
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

function correctionMarkType(value) {
  const markType = requireString(value, 'attendance_review_mark_type', { maxLength: 40 }).toUpperCase();
  if (!VALID_CORRECTION_MARK_TYPES.has(markType)) throw new Error('attendance_review_mark_type_invalid');
  return markType;
}

function correctionDateTime(value) {
  if (value instanceof Date) {
    const date = new Date(value.getTime());
    if (Number.isNaN(date.getTime())) throw new Error('attendance_review_mark_reported_at_invalid');
    return date;
  }
  const normalized = requireString(value, 'attendance_review_mark_reported_at', { maxLength: 80 });
  const localDateTime = normalized.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  const candidate = localDateTime
    ? new Date(`${localDateTime[1]}T${localDateTime[2]}:${localDateTime[3]}:${localDateTime[4] || '00'}-05:00`)
    : new Date(normalized);
  if (Number.isNaN(candidate.getTime())) throw new Error('attendance_review_mark_reported_at_invalid');
  return candidate;
}

function inferredEarlyArrivalRecognition(session, marks) {
  const arrivalAt = dateValue(session?.arrivalReportedAt) || markMoment(latestMark(marks, 'ARRIVAL'));
  const departureAt = dateValue(session?.departureReportedAt) || markMoment(latestMark(marks, 'DEPARTURE'));
  if (!arrivalAt || !departureAt || !Number.isInteger(session?.workedMinutes)) return false;
  const expectedStartAt = dateValue(session.expectedStartAt);
  const expectedEndAt = dateValue(session.expectedEndAt);
  const breakStartAt = markMoment(latestMark(marks, 'BREAK_START'));
  const breakEndAt = markMoment(latestMark(marks, 'BREAK_END'));
  const defaultWork = safeWorkCalculation({
    arrivalAt,
    departureAt,
    expectedStartAt,
    expectedEndAt,
    breakStartAt,
    breakEndAt,
    recognizeEarlyArrival: false
  });
  const recognizedWork = safeWorkCalculation({
    arrivalAt,
    departureAt,
    expectedStartAt,
    expectedEndAt,
    breakStartAt,
    breakEndAt,
    recognizeEarlyArrival: true
  });
  return Boolean(
    defaultWork
    && recognizedWork
    && defaultWork.earlyMinutesExcluded > 0
    && session.workedMinutes === recognizedWork.workedMinutes
  );
}

function correctionEarlyArrivalRecognition(session, marks) {
  if (inferredEarlyArrivalRecognition(session, marks)) return true;
  const latestReview = Array.isArray(session?.reviews) ? session.reviews[0] : null;
  return Boolean(
    ['WORKDAY_DELETE_MARK', 'WORKDAY_ADD_MARK'].includes(latestReview?.action)
    && latestReview?.metadata?.recognizeEarlyArrival === true
  );
}

function correctedSessionData(session, marks, now, recognizeEarlyArrival, pendingCorrectionTypes = []) {
  const arrivalAt = markMoment(latestMark(marks, 'ARRIVAL'));
  const departureAt = markMoment(latestMark(marks, 'DEPARTURE'));
  const breakStartAt = markMoment(latestMark(marks, 'BREAK_START'));
  const breakEndAt = markMoment(latestMark(marks, 'BREAK_END'));
  const expectedStartAt = dateValue(session.expectedStartAt);
  const expectedEndAt = dateValue(session.expectedEndAt);
  const pending = new Set(pendingCorrectionTypes);
  const punctualityStatus = arrivalAt
    ? (expectedStartAt && arrivalAt.getTime() > expectedStartAt.getTime() ? 'LATE' : 'ON_TIME')
    : null;

  const base = {
    punctualityStatus,
    arrivalReportedAt: arrivalAt,
    arrivalValidatedAt: null,
    departureReportedAt: departureAt,
    departureValidatedAt: null,
    workedMinutes: null
  };
  if (!arrivalAt) {
    return {
      ...base,
      attendanceStatus: departureAt ? 'DEPARTURE_REPORTED' : 'PENDING',
      validationStatus: departureAt ? 'REVIEW_REQUIRED' : 'PENDING'
    };
  }
  if (!departureAt) {
    return {
      ...base,
      attendanceStatus: 'ARRIVAL_REPORTED',
      validationStatus: 'REVIEW_REQUIRED'
    };
  }
  if (pending.has('BREAK_START') || pending.has('BREAK_END')) {
    return {
      ...base,
      attendanceStatus: 'DEPARTURE_REPORTED',
      validationStatus: 'REVIEW_REQUIRED',
      departureReportedAt: null
    };
  }
  if (breakEndAt && !breakStartAt) {
    return {
      ...base,
      attendanceStatus: 'DEPARTURE_REPORTED',
      validationStatus: 'REVIEW_REQUIRED',
      departureReportedAt: null
    };
  }

  const work = calculateDispatchWorkedTime({
    arrivalAt,
    departureAt,
    expectedStartAt,
    expectedEndAt,
    breakStartAt,
    breakEndAt,
    recognizeEarlyArrival
  });
  return {
    ...base,
    attendanceStatus: 'COMPLETED',
    validationStatus: 'MANUAL_VALIDATED',
    arrivalValidatedAt: session.arrivalValidatedAt || now,
    departureValidatedAt: session.departureValidatedAt || now,
    workedMinutes: work.workedMinutes
  };
}

function correctionMetadata(session, previousMarks, nextMarks, next, now, extra = {}) {
  return {
    workerId: session.assignment?.workerId || null,
    workerName: session.assignment?.worker?.fullName || null,
    serviceRequestId: session.assignment?.serviceRequestId || null,
    assignmentId: session.assignmentId,
    previousMarkCount: previousMarks.length,
    nextMarkCount: nextMarks.length,
    previousArrivalReportedAt: dateValue(session.arrivalReportedAt)?.toISOString() || null,
    newArrivalReportedAt: dateValue(next.arrivalReportedAt)?.toISOString() || null,
    previousDepartureReportedAt: dateValue(session.departureReportedAt)?.toISOString() || null,
    newDepartureReportedAt: dateValue(next.departureReportedAt)?.toISOString() || null,
    previousWorkedMinutes: Number.isInteger(session.workedMinutes) ? session.workedMinutes : null,
    newWorkedMinutes: Number.isInteger(next.workedMinutes) ? next.workedMinutes : null,
    changedAt: now.toISOString(),
    ...extra
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

async function deleteAttendanceWorkdayMark(prisma, input = {}) {
  const sessionId = requireString(input.sessionId, 'attendance_review_session_id', { maxLength: 120 });
  const markId = requireString(input.markId, 'attendance_review_mark_id', { maxLength: 120 });
  const markType = correctionMarkType(input.markType);
  const actorUsername = requireString(input.actorUsername, 'attendance_review_actor', { maxLength: 120 });
  const actorRole = normalizeString(input.actorRole)?.slice(0, 60) || null;
  const now = input.now instanceof Date ? input.now : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('attendance_review_now_invalid');
  if (typeof prisma.$transaction !== 'function') throw new Error('attendance_workday_transaction_required');

  return prisma.$transaction(async (tx) => {
    if (!tx?.dispatchAttendanceMark || typeof tx.dispatchAttendanceMark.delete !== 'function') {
      throw new Error('attendance_workday_mark_delete_required');
    }
    const session = await tx.dispatchAttendanceSession.findUnique({
      where: { id: sessionId },
      include: {
        marks: { orderBy: { serverReceivedAt: 'asc' } },
        reviews: { orderBy: { createdAt: 'desc' } },
        assignment: { include: { worker: true, serviceRequest: true } }
      }
    });
    if (!session) throw new Error('attendance_review_session_not_found');
    const previousMarks = Array.isArray(session.marks) ? [...session.marks] : [];
    const target = previousMarks.find((mark) => mark.id === markId && mark.markType === markType);
    if (!target) throw new Error('attendance_review_mark_not_found');
    const recognizeEarlyArrival = correctionEarlyArrivalRecognition(session, previousMarks);
    const nextMarks = previousMarks.filter((mark) => mark.id !== target.id);
    const pendingCorrections = new Set(pendingCorrectionMarkTypes(session.reviews));
    pendingCorrections.add(markType);
    const next = correctedSessionData(session, nextMarks, now, recognizeEarlyArrival, [...pendingCorrections]);

    await tx.dispatchAttendanceMark.delete({ where: { id: target.id } });
    const updated = await tx.dispatchAttendanceSession.update({ where: { id: session.id }, data: next });
    await tx.dispatchAttendanceReview.create({
      data: {
        attendanceSessionId: session.id,
        action: 'WORKDAY_DELETE_MARK',
        previousAttendanceStatus: session.attendanceStatus,
        newAttendanceStatus: next.attendanceStatus,
        previousValidationStatus: session.validationStatus,
        newValidationStatus: next.validationStatus,
        reason: DELETE_MARK_REVIEW_REASON,
        notes: null,
        actorUsername,
        actorRole,
        metadata: correctionMetadata(session, previousMarks, nextMarks, next, now, {
          markId: target.id,
          markType,
          removedCapturedAt: markMoment(target)?.toISOString() || null,
          removedDecision: target.decision || null,
          removedHadEvidence: Boolean(target.evidenceStorageKey),
          recognizeEarlyArrival
        })
      }
    });
    return updated;
  });
}

async function addAttendanceWorkdayMark(prisma, input = {}) {
  const sessionId = requireString(input.sessionId, 'attendance_review_session_id', { maxLength: 120 });
  const markType = correctionMarkType(input.markType);
  const reportedAt = correctionDateTime(input.reportedAt);
  const actorUsername = requireString(input.actorUsername, 'attendance_review_actor', { maxLength: 120 });
  const actorRole = normalizeString(input.actorRole)?.slice(0, 60) || null;
  const now = input.now instanceof Date ? input.now : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('attendance_review_now_invalid');
  if (typeof prisma.$transaction !== 'function') throw new Error('attendance_workday_transaction_required');

  return prisma.$transaction(async (tx) => {
    if (!tx?.dispatchAttendanceMark || typeof tx.dispatchAttendanceMark.create !== 'function') {
      throw new Error('attendance_workday_mark_writer_required');
    }
    const session = await tx.dispatchAttendanceSession.findUnique({
      where: { id: sessionId },
      include: {
        marks: { orderBy: { serverReceivedAt: 'asc' } },
        reviews: { orderBy: { createdAt: 'desc' } },
        assignment: {
          include: {
            worker: true,
            serviceRequest: { include: { operationPoint: true } }
          }
        }
      }
    });
    if (!session) throw new Error('attendance_review_session_not_found');
    const previousMarks = Array.isArray(session.marks) ? [...session.marks] : [];
    if (latestMark(previousMarks, markType)) throw new Error('attendance_review_mark_exists');
    const correctionPending = markCorrectionPending(session.reviews, markType);
    const manualAddition = !correctionPending && input.manualAddition === true;
    if (!correctionPending && !manualAddition) {
      throw new Error('attendance_review_mark_not_pending_correction');
    }
    if (manualAddition && session.assignment?.serviceRequest?.operationPoint?.manualAttendanceAllowed !== true) {
      throw new Error('attendance_manual_not_allowed');
    }
    const recognizeEarlyArrival = correctionEarlyArrivalRecognition(session, previousMarks);
    const correctionMark = {
      id: `pending-${randomUUID()}`,
      attendanceSessionId: session.id,
      markType,
      clientCapturedAt: reportedAt,
      serverReceivedAt: now,
      decision: 'MANUAL_VALIDATED',
      riskScore: 0,
      riskFlags: []
    };
    const nextMarks = [...previousMarks, correctionMark];
    validateAttendanceTimelineAgainstAssignment(session.assignment?.serviceRequest, {
      arrivalAt: markMoment(latestMark(nextMarks, 'ARRIVAL')),
      breakStartAt: markMoment(latestMark(nextMarks, 'BREAK_START')),
      breakEndAt: markMoment(latestMark(nextMarks, 'BREAK_END')),
      departureAt: markMoment(latestMark(nextMarks, 'DEPARTURE'))
    });
    const pendingCorrections = correctionPending
      ? pendingCorrectionMarkTypes(session.reviews).filter((type) => type !== markType)
      : pendingCorrectionMarkTypes(session.reviews);
    const next = correctedSessionData(session, nextMarks, now, recognizeEarlyArrival, pendingCorrections);

    const created = await tx.dispatchAttendanceMark.create({
      data: {
        attendanceSessionId: session.id,
        markType,
        idempotencyKey: `manual-${randomUUID()}`,
        serverReceivedAt: now,
        clientCapturedAt: reportedAt,
        decision: 'MANUAL_VALIDATED',
        riskScore: 0,
        riskFlags: []
      }
    });
    const persistedMarks = [...previousMarks, created];
    const updated = await tx.dispatchAttendanceSession.update({ where: { id: session.id }, data: next });
    await tx.dispatchAttendanceReview.create({
      data: {
        attendanceSessionId: session.id,
        action: manualAddition ? 'MANUAL_MARK' : 'WORKDAY_ADD_MARK',
        previousAttendanceStatus: session.attendanceStatus,
        newAttendanceStatus: next.attendanceStatus,
        previousValidationStatus: session.validationStatus,
        newValidationStatus: next.validationStatus,
        reason: manualAddition ? MANUAL_MARK_REVIEW_REASON : ADD_MARK_REVIEW_REASON,
        notes: null,
        actorUsername,
        actorRole,
        metadata: correctionMetadata(session, previousMarks, persistedMarks, next, now, {
          markId: created.id,
          markType,
          addedCapturedAt: reportedAt.toISOString(),
          recognizeEarlyArrival,
          manualAddition
        })
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
  if (action === 'DELETE_MARK') {
    return deleteAttendanceWorkdayMark(prisma, { ...input, sessionId });
  }
  if (action === 'ADD_MARK') {
    return addAttendanceWorkdayMark(prisma, { ...input, sessionId });
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