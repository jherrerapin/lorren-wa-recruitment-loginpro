import { createHash } from 'node:crypto';
import {
  ACTIVE_DISPATCH_ASSIGNMENT_STATUSES,
  registerDispatchArrival
} from './registerArrival.js';
import { registerDispatchBreak } from './registerBreak.js';
import { registerDispatchDeparture } from './registerDeparture.js';
import { loadCrewAttendancePortalContexts } from './crewAttendanceConfig.js';
import { reviewAttendanceSession } from './adminAttendance.js';

const ONLINE_WEB_CAPTURE_MODE = 'ONLINE_WEB';
const OFFLINE_WEB_CAPTURE_MODE = 'OFFLINE_WEB';
const DUPLICATE_ARRIVAL_FLAG = 'DUPLICATE_ARRIVAL';
const AUTO_VALIDATED = 'AUTO_VALIDATED';
const MANUAL_VALIDATED = 'MANUAL_VALIDATED';
const VALIDATED_STATUSES = new Set([AUTO_VALIDATED, MANUAL_VALIDATED]);
const CREW_DELEGATED_MARK_TYPES = new Set(['BREAK_START', 'BREAK_END', 'DEPARTURE']);
const CREW_MEMBER_MARK_REJECTION_CODES = new Set([
  'attendance_assignment_not_found',
  'attendance_assignment_inactive',
  'attendance_not_enabled',
  'attendance_break_arrival_required',
  'attendance_break_after_departure',
  'attendance_break_before_arrival',
  'attendance_break_operational_window_invalid',
  'attendance_break_already_started',
  'attendance_break_start_required',
  'attendance_break_already_completed',
  'attendance_break_end_before_start',
  'attendance_departure_arrival_required',
  'attendance_departure_already_registered',
  'attendance_departure_before_arrival',
  'attendance_departure_break_end_required',
  'attendance_departure_operational_window_invalid',
  'attendance_offline_capture_expired',
  'attendance_offline_capture_future_invalid',
  'attendance_operation_geofence_required',
  'attendance_location_required',
  'attendance_outside_operation_range',
  'attendance_location_accuracy_insufficient'
]);

function requireString(value, label, maxLength = 200) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}_required`);
  return value.trim().slice(0, maxLength);
}

function requireDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label}_invalid`);
  return date;
}

function normalizeCaptureMode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function normalizeValidatedWorkerIds(value, prefix = 'crew_group_arrival') {
  if (!Array.isArray(value)) throw new Error(`${prefix}_validated_workers_required`);
  const normalized = [];
  const seen = new Set();
  for (const workerId of value) {
    const current = requireString(workerId, `${prefix}_validated_worker_id`, 160);
    if (seen.has(current)) continue;
    seen.add(current);
    normalized.push(current);
  }
  return normalized;
}

function memberIdempotencyKey(rootKey, assignmentId) {
  const digest = createHash('sha256')
    .update(`${rootKey}:${assignmentId}`)
    .digest('hex')
    .slice(0, 48);
  return `crew_${digest}`;
}

function riskFlags(result) {
  return Array.isArray(result?.validation?.riskFlags) ? result.validation.riskFlags : [];
}

function duplicateArrival(result) {
  return result?.recorded === false && riskFlags(result).includes(DUPLICATE_ARRIVAL_FLAG);
}

function arrivalValidated(result) {
  const validationStatus = result?.attendanceSession?.validationStatus
    || result?.validation?.validationStatus
    || null;
  return VALIDATED_STATUSES.has(validationStatus);
}

function reviewReason(input, isLeader) {
  if (input.presenceValidated) {
    return isLeader
      ? 'Llegada de encargado validada mediante sesión activa, geocerca y comprobación local de cuadrilla.'
      : 'Llegada delegada: integrante incluido únicamente después de una prueba local de presencia verificable.';
  }
  return input.forceMajeure
    ? 'Fuerza mayor: uno o más auxiliares estaban sin celular; llegada delegada por responsable de cuadrilla.'
    : 'Llegada delegada y confirmada por responsable de cuadrilla.';
}

function reviewNotes(input, isLeader) {
  if (input.presenceValidated) {
    const base = 'Marcación grupal desde la app Android: el servidor validó la sesión y dispositivo activo del encargado, su geocerca, la pertenencia a la misma solicitud y una credencial de dispositivo firmada por servidor para cada integrante delegado. Cada proof fue ligado al challenge del intento y su firma ECDSA fue verificada antes del fan-out. No se solicitó reconocimiento facial.';
    return isLeader
      ? `${base} El encargado forma parte del total de la cuadrilla y se procesó una sola vez.`
      : base;
  }
  const base = 'Marcación grupal: la sesión y ubicación del responsable fueron validadas por el servidor y el flujo reportó una lectura Bluetooth consistente con la operación. No se solicitó reconocimiento facial para esta acción grupal.';
  return input.forceMajeure
    ? `${base} Se declaró fuerza mayor por uno o más auxiliares sin celular disponible en el momento de la llegada.`
    : base;
}

function requirePrisma(prisma) {
  if (!prisma?.dispatchAssignment || typeof prisma.dispatchAssignment.findMany !== 'function') {
    throw new Error('crew_group_arrival_assignment_contract_invalid');
  }
  return prisma;
}

function normalizeCrewDelegatedMarkType(value) {
  const markType = requireString(value, 'crew_group_mark_type', 40).toUpperCase();
  if (!CREW_DELEGATED_MARK_TYPES.has(markType)) throw new Error('crew_group_mark_type_invalid');
  return markType;
}

function publicErrorCode(error) {
  const code = typeof error?.code === 'string'
    ? error.code
    : (typeof error?.message === 'string' ? error.message : 'crew_group_mark_failed');
  return /^[A-Za-z0-9_]{1,100}$/.test(code) ? code : 'crew_group_mark_failed';
}

function isCrewMemberMarkRejection(error) {
  return CREW_MEMBER_MARK_REJECTION_CODES.has(publicErrorCode(error));
}

function resultValidationStatus(result) {
  return result?.validation?.validationStatus || result?.attendanceSession?.validationStatus || null;
}

async function validateCrewArrival(prisma, result, input, options) {
  if (!result?.recorded || !result.attendanceSession?.id) {
    return { validated: false, validationStatus: null, pendingReview: false };
  }
  const currentStatus = result.attendanceSession.validationStatus || result.validation?.validationStatus || null;
  if (VALIDATED_STATUSES.has(currentStatus)) {
    return { validated: true, validationStatus: currentStatus, pendingReview: false };
  }

  try {
    await options.reviewAttendanceFn(prisma, {
      sessionId: result.attendanceSession.id,
      action: 'VALIDATE',
      attendanceStatus: result.validation?.reportedPunctuality === 'LATE' ? 'LATE' : 'ON_TIME',
      reason: reviewReason(input, input.isLeader),
      notes: reviewNotes(input, input.isLeader),
      actorUsername: `worker-portal:${input.leaderWorkerId}`,
      actorRole: 'crew-leader',
      now: input.now
    });
    return { validated: true, validationStatus: MANUAL_VALIDATED, pendingReview: false };
  } catch (_error) {
    // La llegada canónica ya existe: una falla de revisión no debe borrar la marca.
    return { validated: false, validationStatus: currentStatus, pendingReview: true };
  }
}

export async function registerCrewArrivalForLeader(prisma, input = {}, injected = {}) {
  requirePrisma(prisma);
  const leaderWorkerId = requireString(input.leaderWorkerId, 'crew_group_arrival_leader_worker_id', 160);
  const leaderAssignmentId = requireString(input.assignmentId, 'crew_group_arrival_assignment_id', 160);
  const idempotencyKey = requireString(input.idempotencyKey, 'crew_group_arrival_idempotency_key', 100);
  const captureMode = normalizeCaptureMode(input.captureMode);
  const now = requireDate(input.now ?? new Date(), 'crew_group_arrival_now');
  const presenceValidated = input.presenceValidated === true;
  const forceMajeure = presenceValidated ? false : input.forceMajeure === true;
  const validatedWorkerIds = presenceValidated
    ? normalizeValidatedWorkerIds(input.validatedWorkerIds)
    : null;

  if (
    captureMode !== ONLINE_WEB_CAPTURE_MODE
    && !(presenceValidated && captureMode === OFFLINE_WEB_CAPTURE_MODE)
  ) return { applied: false };
  if (presenceValidated && !validatedWorkerIds.includes(leaderWorkerId)) {
    throw new Error('crew_group_arrival_leader_presence_required');
  }

  const options = {
    loadCrewContextsFn: injected.loadCrewContextsFn || loadCrewAttendancePortalContexts,
    registerArrivalFn: injected.registerArrivalFn || registerDispatchArrival,
    reviewAttendanceFn: injected.reviewAttendanceFn || reviewAttendanceSession
  };

  const contexts = await options.loadCrewContextsFn(prisma, { workerId: leaderWorkerId });
  const leaderContext = (Array.isArray(contexts) ? contexts : [])
    .find((context) => context?.assignmentId === leaderAssignmentId);

  if (!leaderContext
    || leaderContext.mode !== 'CREW'
    || leaderContext.isCrewLeader !== true
    || leaderContext.crewAvailable !== true
    || !leaderContext.serviceRequestId) {
    return { applied: false };
  }

  const members = await prisma.dispatchAssignment.findMany({
    where: {
      serviceRequestId: leaderContext.serviceRequestId,
      status: { in: [...ACTIVE_DISPATCH_ASSIGNMENT_STATUSES] }
    },
    select: {
      id: true,
      workerId: true,
      attendanceSession: { select: { arrivalReportedAt: true } }
    },
    orderBy: { createdAt: 'asc' }
  });

  if (!members.some((member) => member.id === leaderAssignmentId && member.workerId === leaderWorkerId)) {
    throw new Error('crew_group_arrival_leader_not_assigned');
  }

  const selectedWorkerSet = presenceValidated ? new Set(validatedWorkerIds) : null;
  const selectedMembers = presenceValidated
    ? members.filter((member) => selectedWorkerSet.has(member.workerId))
    : members;
  const previouslyRecordedOutsideSelection = presenceValidated
    ? members.filter((member) => (
        !selectedWorkerSet.has(member.workerId)
        && Boolean(member.attendanceSession?.arrivalReportedAt)
      )).length
    : 0;
  const results = [];
  let leaderResult = null;
  const orderedMembers = [
    ...selectedMembers.filter((member) => member.id === leaderAssignmentId),
    ...selectedMembers.filter((member) => member.id !== leaderAssignmentId)
  ];

  for (const member of orderedMembers) {
    const isLeader = member.id === leaderAssignmentId;
    const memberResult = await options.registerArrivalFn(prisma, {
      assignmentId: member.id,
      expectedWorkerId: member.workerId,
      idempotencyKey: isLeader ? idempotencyKey : memberIdempotencyKey(idempotencyKey, member.id),
      now,
      captureMode,
      clientCapturedAt: input.clientCapturedAt ?? null,
      latitude: input.latitude,
      longitude: input.longitude,
      accuracyMeters: input.accuracyMeters,
      installationIdHash: isLeader || !presenceValidated ? (input.installationIdHash ?? null) : null,
      persistentStorageAvailable: true,
      hasFreshPhoto: false,
      evidenceStorageKey: null,
      evidenceMimeType: null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null
    });

    if (isLeader) {
      leaderResult = memberResult;
      if (!memberResult.recorded) {
        // El flujo legacy conserva el bloqueo. En presencia verificable, una llegada previa
        // del encargado no impide completar a integrantes detectados en un nuevo intento,
        // porque sesión, dispositivo y geocerca del encargado se revalidan otra vez.
        if (!presenceValidated || !duplicateArrival(memberResult)) {
          return {
            applied: true,
            leaderResult,
            summary: null
          };
        }
      } else if (!arrivalValidated(memberResult)) {
        if (!presenceValidated) {
          return {
            applied: true,
            leaderResult,
            summary: null
          };
        }
        const leaderReview = await validateCrewArrival(prisma, memberResult, {
          leaderWorkerId,
          forceMajeure,
          presenceValidated,
          isLeader: true,
          now
        }, options);
        if (!leaderReview.validated) {
          return {
            applied: true,
            leaderResult,
            summary: null
          };
        }
      }
    }

    if (duplicateArrival(memberResult)) {
      results.push({ assignmentId: member.id, isLeader, status: 'ALREADY_RECORDED' });
      continue;
    }
    if (!memberResult.recorded) {
      results.push({ assignmentId: member.id, isLeader, status: 'NOT_RECORDED' });
      continue;
    }

    if (isLeader) {
      results.push({
        assignmentId: member.id,
        isLeader: true,
        status: memberResult.replayed ? 'REPLAYED' : 'RECORDED',
        validationStatus: arrivalValidated(memberResult)
          ? (memberResult.validation?.validationStatus || memberResult.attendanceSession?.validationStatus || null)
          : MANUAL_VALIDATED
      });
      continue;
    }

    const review = await validateCrewArrival(prisma, memberResult, {
      leaderWorkerId,
      forceMajeure,
      presenceValidated,
      isLeader: false,
      now
    }, options);
    results.push({
      assignmentId: member.id,
      isLeader: false,
      status: memberResult.replayed ? 'REPLAYED' : 'RECORDED',
      validationStatus: review.validationStatus || memberResult.validation?.validationStatus || null,
      pendingReview: review.pendingReview,
      forceMajeure
    });
  }

  const newlyRecordedCount = results.filter((item) => item.status === 'RECORDED').length;
  const replayedCount = results.filter((item) => item.status === 'REPLAYED').length;
  const selectedAlreadyRecordedCount = results.filter((item) => item.status === 'ALREADY_RECORDED').length;
  const alreadyRecordedCount = selectedAlreadyRecordedCount + previouslyRecordedOutsideSelection;
  const failedCount = results.filter((item) => item.status === 'NOT_RECORDED').length;
  const reviewPendingCount = results.filter((item) => item.pendingReview === true).length;
  const delegatedCount = results.filter((item) => item.isLeader === false && ['RECORDED', 'REPLAYED'].includes(item.status)).length;
  const processedCount = newlyRecordedCount + replayedCount + alreadyRecordedCount;
  const notDetectedCount = Math.max(
    0,
    members.length - selectedMembers.length - previouslyRecordedOutsideSelection
  );

  return {
    applied: true,
    leaderResult,
    summary: {
      totalMembers: members.length,
      eligibleMembers: selectedMembers.length,
      previouslyRecordedCount: previouslyRecordedOutsideSelection,
      processedCount,
      notDetectedCount,
      newlyRecordedCount,
      replayedCount,
      alreadyRecordedCount,
      failedCount,
      reviewPendingCount,
      delegatedCount,
      forceMajeure,
      presenceValidated,
      results
    }
  };
}

export async function registerCrewMarkForLeader(prisma, input = {}, injected = {}) {
  requirePrisma(prisma);
  const leaderWorkerId = requireString(input.leaderWorkerId, 'crew_group_mark_leader_worker_id', 160);
  const leaderAssignmentId = requireString(input.assignmentId, 'crew_group_mark_assignment_id', 160);
  const idempotencyKey = requireString(input.idempotencyKey, 'crew_group_mark_idempotency_key', 100);
  const markType = normalizeCrewDelegatedMarkType(input.markType);
  const captureMode = normalizeCaptureMode(input.captureMode);
  const now = requireDate(input.now ?? new Date(), 'crew_group_mark_now');
  const presenceValidated = input.presenceValidated === true;
  const validatedWorkerIds = presenceValidated
    ? normalizeValidatedWorkerIds(input.validatedWorkerIds, 'crew_group_mark')
    : null;
  if (![ONLINE_WEB_CAPTURE_MODE, OFFLINE_WEB_CAPTURE_MODE].includes(captureMode)) {
    throw new Error('crew_group_mark_capture_mode_invalid');
  }
  if (presenceValidated && !validatedWorkerIds.includes(leaderWorkerId)) {
    throw new Error('crew_group_mark_leader_presence_required');
  }

  const options = {
    loadCrewContextsFn: injected.loadCrewContextsFn || loadCrewAttendancePortalContexts,
    registerBreakFn: injected.registerBreakFn || registerDispatchBreak,
    registerDepartureFn: injected.registerDepartureFn || registerDispatchDeparture
  };
  const contexts = await options.loadCrewContextsFn(prisma, { workerId: leaderWorkerId });
  const leaderContext = (Array.isArray(contexts) ? contexts : [])
    .find((context) => context?.assignmentId === leaderAssignmentId);
  if (!leaderContext
    || leaderContext.mode !== 'CREW'
    || leaderContext.isCrewLeader !== true
    || leaderContext.crewAvailable !== true
    || !leaderContext.serviceRequestId) {
    return { applied: false };
  }

  const members = await prisma.dispatchAssignment.findMany({
    where: {
      serviceRequestId: leaderContext.serviceRequestId,
      status: { in: [...ACTIVE_DISPATCH_ASSIGNMENT_STATUSES] }
    },
    select: { id: true, workerId: true },
    orderBy: { createdAt: 'asc' }
  });
  if (!members.some((member) => member.id === leaderAssignmentId && member.workerId === leaderWorkerId)) {
    throw new Error('crew_group_mark_leader_not_assigned');
  }

  const selectedWorkerSet = presenceValidated ? new Set(validatedWorkerIds) : null;
  const selectedMembers = presenceValidated
    ? members.filter((member) => selectedWorkerSet.has(member.workerId))
    : members;
  const registerMarkFn = markType === 'DEPARTURE'
    ? options.registerDepartureFn
    : options.registerBreakFn;
  const orderedMembers = [
    ...selectedMembers.filter((member) => member.id === leaderAssignmentId),
    ...selectedMembers.filter((member) => member.id !== leaderAssignmentId)
  ];
  const results = [];
  let leaderResult = null;

  for (const member of orderedMembers) {
    const isLeader = member.id === leaderAssignmentId;
    const markInput = {
      assignmentId: member.id,
      expectedWorkerId: member.workerId,
      idempotencyKey: isLeader ? idempotencyKey : memberIdempotencyKey(idempotencyKey, member.id),
      markType,
      now,
      captureMode,
      clientCapturedAt: input.clientCapturedAt ?? null,
      latitude: input.latitude,
      longitude: input.longitude,
      accuracyMeters: input.accuracyMeters,
      installationIdHash: isLeader ? (input.installationIdHash ?? null) : null,
      persistentStorageAvailable: input.persistentStorageAvailable === true,
      hasFreshPhoto: isLeader && input.hasFreshPhoto === true,
      evidenceStorageKey: isLeader ? (input.evidenceStorageKey ?? null) : null,
      evidenceMimeType: isLeader ? (input.evidenceMimeType ?? null) : null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null
    };

    try {
      const memberResult = await registerMarkFn(prisma, markInput);
      if (isLeader) leaderResult = memberResult;
      if (!memberResult?.recorded) {
        if (isLeader) return { applied: true, leaderResult, summary: null };
        results.push({ assignmentId: member.id, isLeader: false, status: 'NOT_RECORDED' });
        continue;
      }
      const validationStatus = resultValidationStatus(memberResult);
      results.push({
        assignmentId: member.id,
        isLeader,
        status: memberResult.replayed ? 'REPLAYED' : 'RECORDED',
        validationStatus,
        pendingReview: validationStatus === 'REVIEW_REQUIRED'
      });
    } catch (error) {
      if (isLeader || !isCrewMemberMarkRejection(error)) throw error;
      results.push({
        assignmentId: member.id,
        isLeader: false,
        status: 'NOT_RECORDED',
        error: publicErrorCode(error)
      });
    }
  }

  const newlyRecordedCount = results.filter((item) => item.status === 'RECORDED').length;
  const replayedCount = results.filter((item) => item.status === 'REPLAYED').length;
  const failedCount = results.filter((item) => item.status === 'NOT_RECORDED').length;
  const reviewPendingCount = results.filter((item) => item.pendingReview === true).length;
  const delegatedCount = results.filter((item) => item.isLeader === false && ['RECORDED', 'REPLAYED'].includes(item.status)).length;
  const notDetectedCount = presenceValidated ? Math.max(0, members.length - selectedMembers.length) : 0;

  return {
    applied: true,
    leaderResult,
    summary: {
      markType,
      totalMembers: members.length,
      eligibleMembers: selectedMembers.length,
      processedCount: newlyRecordedCount + replayedCount,
      notDetectedCount,
      newlyRecordedCount,
      replayedCount,
      failedCount,
      reviewPendingCount,
      delegatedCount,
      presenceValidated,
      results
    }
  };
}
