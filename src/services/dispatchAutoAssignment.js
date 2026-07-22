import {
  buildDispatchServiceDateWhere,
  dispatchServiceDateKey
} from './dispatchDate.js';

const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const CONFIRMED_ASSIGNMENT_STATUS = 'CONFIRMED';
const AUTO_ASSIGNMENT_NOTE = 'Autoasignado por historial confirmado en esta operación.';
const BOGOTA_METRO_CITY_KEYS = new Set(['bogota', 'siberia', 'madrid', 'funza', 'mosquera']);

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function cityKey(value) {
  const normalized = normalizeText(value);
  if (!normalized) return '';
  if (normalized.includes('bogota')) return 'bogota';
  if (normalized.includes('siberia')) return 'siberia';
  if (normalized.includes('madrid')) return 'madrid';
  if (normalized.includes('funza')) return 'funza';
  if (normalized.includes('mosquera')) return 'mosquera';
  return normalized;
}

function parseTimeMinutes(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function timeRangesOverlap(first = {}, second = {}) {
  const firstStart = parseTimeMinutes(first.startTime);
  const secondStart = parseTimeMinutes(second.startTime);
  if (firstStart === null || secondStart === null) return false;

  const firstEnd = parseTimeMinutes(first.endTime);
  const secondEnd = parseTimeMinutes(second.endTime);
  if (firstEnd === null || secondEnd === null) return firstStart === secondStart;
  if (firstEnd <= firstStart || secondEnd <= secondStart) return firstStart === secondStart;

  return firstStart < secondEnd && secondStart < firstEnd;
}

function workerMatchesRequestCity(worker, requestCityName) {
  const requestKey = cityKey(requestCityName);
  if (!requestKey) return true;

  const workerCityKeys = new Set([
    cityKey(worker?.residenceCity),
    ...(worker?.cities || []).map((entry) => cityKey(entry?.city?.name))
  ].filter(Boolean));

  // Registros históricos antiguos pueden no tener todavía ciudades relacionadas.
  if (!workerCityKeys.size) return true;
  if (BOGOTA_METRO_CITY_KEYS.has(requestKey)) {
    return [...workerCityKeys].some((key) => BOGOTA_METRO_CITY_KEYS.has(key));
  }
  return workerCityKeys.has(requestKey);
}

export function rankHistoricalWorkers(historyAssignments = []) {
  const byWorker = new Map();

  for (const assignment of historyAssignments) {
    const worker = assignment?.worker;
    const workerId = assignment?.workerId || worker?.id;
    if (!workerId || !worker || worker.operationalStatus !== 'CONTRATADO') continue;

    const confirmedAt = new Date(assignment.updatedAt || assignment.createdAt || 0);
    const timestamp = Number.isNaN(confirmedAt.getTime()) ? 0 : confirmedAt.getTime();
    const current = byWorker.get(workerId) || {
      workerId,
      worker,
      confirmedCount: 0,
      lastConfirmedAt: 0
    };
    current.confirmedCount += 1;
    current.lastConfirmedAt = Math.max(current.lastConfirmedAt, timestamp);
    byWorker.set(workerId, current);
  }

  return [...byWorker.values()].sort((left, right) => (
    right.confirmedCount - left.confirmedCount
    || right.lastConfirmedAt - left.lastConfirmedAt
    || String(left.worker?.fullName || '').localeCompare(String(right.worker?.fullName || ''), 'es')
    || String(left.workerId).localeCompare(String(right.workerId))
  ));
}

export function filterAssignmentsForServiceDate(assignments = [], serviceDate) {
  const selectedDate = dispatchServiceDateKey(serviceDate);
  if (!selectedDate) return [];
  return assignments.filter(
    (assignment) => dispatchServiceDateKey(assignment?.serviceRequest?.serviceDate) === selectedDate
  );
}

export function selectAutoAssignmentCandidates({
  rankedWorkers = [],
  activeAssignments = [],
  request = {},
  limit = 0
} = {}) {
  const safeLimit = Math.max(0, Math.trunc(Number(limit) || 0));
  if (!safeLimit) return [];

  const assignmentsByWorker = new Map();
  for (const assignment of activeAssignments) {
    if (!assignmentsByWorker.has(assignment.workerId)) assignmentsByWorker.set(assignment.workerId, []);
    assignmentsByWorker.get(assignment.workerId).push(assignment);
  }

  return rankedWorkers.filter((candidate) => {
    if (!workerMatchesRequestCity(candidate.worker, request.cityName)) return false;
    const workerAssignments = assignmentsByWorker.get(candidate.workerId) || [];
    return !workerAssignments.some((assignment) => timeRangesOverlap(request, assignment.serviceRequest || assignment));
  }).slice(0, safeLimit);
}

async function recalculateRequestStatus(prisma, serviceRequestId) {
  const request = await prisma.dispatchServiceRequest.findUnique({
    where: { id: serviceRequestId },
    select: { requiredWorkers: true }
  });
  if (!request) return null;

  const [activeCount, confirmedCount] = await Promise.all([
    prisma.dispatchAssignment.count({
      where: { serviceRequestId, status: { in: ACTIVE_ASSIGNMENT_STATUSES } }
    }),
    prisma.dispatchAssignment.count({
      where: { serviceRequestId, status: CONFIRMED_ASSIGNMENT_STATUS }
    })
  ]);

  let status = 'PENDING_ASSIGNMENT';
  if (confirmedCount >= request.requiredWorkers) status = 'ASSIGNMENT_COMPLETE';
  else if (activeCount >= request.requiredWorkers) status = 'PENDING_CONFIRMATION';
  else if (activeCount > 0) status = 'ASSIGNMENT_PARTIAL';

  await prisma.dispatchServiceRequest.update({
    where: { id: serviceRequestId },
    data: { status }
  });

  return { status, activeCount, confirmedCount, requiredWorkers: request.requiredWorkers };
}

export async function autoAssignServiceRequest(prisma, serviceRequestId, options = {}) {
  const request = await prisma.dispatchServiceRequest.findUnique({
    where: { id: serviceRequestId },
    include: {
      assignments: {
        where: { status: { in: ACTIVE_ASSIGNMENT_STATUSES } },
        select: { workerId: true, status: true }
      }
    }
  });

  if (!request?.operationPointId) return { assignedCount: 0, reason: 'missing_operation_point' };

  const remainingSlots = Math.max(
    Number(request.requiredWorkers || 0) - (request.assignments || []).length,
    0
  );
  if (!remainingSlots) {
    await recalculateRequestStatus(prisma, request.id);
    return { assignedCount: 0, reason: 'coverage_already_assigned' };
  }

  const historyAssignments = await prisma.dispatchAssignment.findMany({
    where: {
      status: CONFIRMED_ASSIGNMENT_STATUS,
      serviceRequestId: { not: request.id },
      serviceRequest: { operationPointId: request.operationPointId },
      worker: { operationalStatus: 'CONTRATADO' }
    },
    select: {
      workerId: true,
      createdAt: true,
      updatedAt: true,
      worker: {
        select: {
          id: true,
          fullName: true,
          residenceCity: true,
          operationalStatus: true,
          cities: {
            select: {
              city: { select: { name: true } }
            }
          }
        }
      }
    }
  });

  const rankedWorkers = rankHistoricalWorkers(historyAssignments);
  if (!rankedWorkers.length) return { assignedCount: 0, reason: 'no_confirmed_history' };

  const rankedWorkerIds = rankedWorkers.map((candidate) => candidate.workerId);
  const selectedDate = dispatchServiceDateKey(request.serviceDate);
  const sameDateWhere = buildDispatchServiceDateWhere(selectedDate);
  const activeAssignmentCandidates = await prisma.dispatchAssignment.findMany({
    where: {
      workerId: { in: rankedWorkerIds },
      serviceRequestId: { not: request.id },
      status: { in: ACTIVE_ASSIGNMENT_STATUSES },
      serviceRequest: { serviceDate: sameDateWhere.serviceDate }
    },
    select: {
      workerId: true,
      serviceRequest: {
        select: {
          id: true,
          serviceDate: true,
          startTime: true,
          endTime: true
        }
      }
    }
  });
  const activeAssignments = filterAssignmentsForServiceDate(activeAssignmentCandidates, selectedDate);

  const alreadyAssignedWorkerIds = new Set((request.assignments || []).map((assignment) => assignment.workerId));
  const candidates = selectAutoAssignmentCandidates({
    rankedWorkers: rankedWorkers.filter((candidate) => !alreadyAssignedWorkerIds.has(candidate.workerId)),
    activeAssignments,
    request,
    limit: remainingSlots
  });

  if (!candidates.length) return { assignedCount: 0, reason: 'no_eligible_history' };

  const createdByUsername = options.createdByUsername || request.createdByUsername || 'AUTO_HISTORY';
  const result = await prisma.dispatchAssignment.createMany({
    data: candidates.map((candidate) => ({
      serviceRequestId: request.id,
      workerId: candidate.workerId,
      status: 'CONFIRMATION_PENDING',
      notes: AUTO_ASSIGNMENT_NOTE,
      createdByUsername
    })),
    skipDuplicates: true
  });

  const status = await recalculateRequestStatus(prisma, request.id);
  return {
    assignedCount: result.count,
    workerIds: candidates.map((candidate) => candidate.workerId),
    status
  };
}

export async function autoAssignServiceRequests(prisma, serviceRequests = [], options = {}) {
  const results = [];

  // Secuencial: cada bloque ve las autoasignaciones previas y puede evitar cruces horarios.
  for (const request of serviceRequests) {
    const serviceRequestId = typeof request === 'string' ? request : request?.id;
    if (!serviceRequestId) continue;
    try {
      results.push({
        serviceRequestId,
        ...(await autoAssignServiceRequest(prisma, serviceRequestId, options))
      });
    } catch (error) {
      console.error('[DISPATCH_AUTO_ASSIGNMENT_ERROR]', {
        serviceRequestId,
        message: error?.message || 'unknown_error'
      });
      results.push({ serviceRequestId, assignedCount: 0, reason: 'error' });
    }
  }

  return results;
}
