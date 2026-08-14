import { createHash } from 'node:crypto';
import {
  ACTIVE_DISPATCH_ASSIGNMENT_STATUSES,
  registerDispatchArrival
} from './registerArrival.js';
import { loadCrewAttendancePortalContexts } from './crewAttendanceConfig.js';
import { reviewAttendanceSession } from './adminAttendance.js';

const ONLINE_WEB_CAPTURE_MODE = 'ONLINE_WEB';
const OFFLINE_WEB_CAPTURE_MODE = 'OFFLINE_WEB';
const DUPLICATE_ARRIVAL_FLAG = 'DUPLICATE_ARRIVAL';
const AUTO_VALIDATED = 'AUTO_VALIDATED';
const MANUAL_VALIDATED = 'MANUAL_VALIDATED';
const VALIDATED_STATUSES = new Set([AUTO_VALIDATED, MANUAL_VALIDATED]);

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

function normalizeValidatedWorkerIds(value) {
  if (!Array.isArray(value)) throw new Error('crew_group_arrival_validated_workers_required');
  const normalized = [];
  const seen = new Set();
  for (const workerId of value) {
    const current = requireString(workerId, 'crew_group_arrival_validated_worker_id', 160);
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
        // En el flujo legacy una llegada previa distinta sigue bloqueando el fan-out. En el
        // flujo de presencia, la sesión/dispositivo/geocerca del encargado se revalidaron
        // para este nuevo intento, por lo que una llegada ya registrada permite completar
        // exclusivamente a los integrantes detectados que todavía falten.
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
  const alreadyRecordedCount = results.filter((item) => item.status === 'ALREADY_RECORDED').length;
  const failedCount = results.filter((item) => item.status === 'NOT_RECORDED').length;
  const reviewPendingCount = results.filter((item) => item.pendingReview === true).length;
  const delegatedCount = results.filter((item) => item.isLeader === false && ['RECORDED', 'REPLAYED'].includes(item.status)).length;
  const processedCount = previouslyRecordedOutsideSelection
    + newlyRecordedCount
    + replayedCount
    + alreadyRecordedCount;
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
