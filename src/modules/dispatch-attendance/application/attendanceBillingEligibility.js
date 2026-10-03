import { dispatchServiceDateKey } from '../../../services/dispatchDate.js';
import {
  ATTENDANCE_POINT_ENABLEMENT_ACTION,
  ATTENDANCE_POINT_ENABLEMENT_ENTITY_TYPE
} from './updatePointConfig.js';

export const ATTENDANCE_BILLING_ELIGIBILITY_ENTITY_TYPE = 'DISPATCH_ATTENDANCE_BILLING_ELIGIBILITY';
export const ATTENDANCE_BILLING_ELIGIBILITY_ACTION = 'ATTENDANCE_BILLING_ELIGIBILITY_LOCKED';
export const ATTENDANCE_BILLING_MUTATION_ACTION = 'ATTENDANCE_BILLING_POST_START_MUTATION';

const CONFIRMED_ASSIGNMENT_STATUS = 'CONFIRMED';

function text(value, maxLength = 240) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function metadata(event) {
  return event?.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
    ? event.metadata
    : {};
}

function eventMoment(event) {
  const value = event?.createdAt instanceof Date ? event.createdAt : new Date(event?.createdAt);
  return Number.isNaN(value.getTime()) ? null : value;
}

export function attendanceBillingServiceMoment(serviceRequest = {}) {
  const dateKey = dispatchServiceDateKey(serviceRequest?.serviceDate);
  const clock = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(serviceRequest?.startTime || '').trim());
  if (!dateKey || !clock) return null;
  const value = new Date(`${dateKey}T${clock[1]}:${clock[2]}:00-05:00`);
  return Number.isNaN(value.getTime()) ? null : value;
}

export function attendanceEnabledAtService(events = [], serviceRequest = {}) {
  const pointId = serviceRequest?.operationPointId || serviceRequest?.operationPoint?.id || null;
  const moment = attendanceBillingServiceMoment(serviceRequest);
  if (!pointId || !moment) return false;

  const pointEvents = events.filter((event) => event?.entityId === pointId && eventMoment(event));
  if (!pointEvents.length) return serviceRequest?.operationPoint?.attendanceEnabled === true;

  let latestBefore = null;
  let latestBeforeTime = Number.NEGATIVE_INFINITY;
  let firstAfter = null;
  let firstAfterTime = Number.POSITIVE_INFINITY;
  for (const event of pointEvents) {
    const at = eventMoment(event).getTime();
    if (at <= moment.getTime() && at > latestBeforeTime) {
      latestBefore = event;
      latestBeforeTime = at;
    }
    if (at > moment.getTime() && at < firstAfterTime) {
      firstAfter = event;
      firstAfterTime = at;
    }
  }
  if (latestBefore) return metadata(latestBefore).attendanceEnabled === true;
  const previous = metadata(firstAfter).previousAttendanceEnabled;
  if (previous === true || previous === false) return previous;
  return serviceRequest?.operationPoint?.attendanceEnabled === true;
}

export async function loadAttendanceBillingEnablementEvents(prisma, assignments = []) {
  const pointIds = [...new Set(assignments
    .map((assignment) => assignment?.serviceRequest?.operationPointId || assignment?.serviceRequest?.operationPoint?.id)
    .filter(Boolean))];
  if (!pointIds.length || !prisma?.devAuditEvent?.findMany) return [];
  return prisma.devAuditEvent.findMany({
    where: {
      entityType: ATTENDANCE_POINT_ENABLEMENT_ENTITY_TYPE,
      entityId: { in: pointIds },
      action: ATTENDANCE_POINT_ENABLEMENT_ACTION
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
  });
}

function eligibilityEntityId(assignment = {}) {
  const serviceDate = dispatchServiceDateKey(assignment?.serviceRequest?.serviceDate);
  const assignmentId = text(assignment?.id, 180);
  return serviceDate && assignmentId ? `${serviceDate}:${assignmentId}` : null;
}

function publicSnapshot(event) {
  const value = metadata(event);
  return {
    id: event?.id || null,
    entityId: event?.entityId || null,
    createdAt: event?.createdAt || null,
    assignmentId: text(value.assignmentId, 180),
    serviceRequestId: text(value.serviceRequestId, 180),
    workerId: text(value.workerId, 180),
    fullName: text(value.fullName, 240) || 'Auxiliar sin nombre',
    documentType: text(value.documentType, 40),
    documentNumber: text(value.documentNumber, 120),
    serviceDate: text(value.serviceDate, 10),
    startTime: text(value.startTime, 8),
    serviceMoment: text(value.serviceMoment, 40),
    operationPointId: text(value.operationPointId, 180),
    operationPointName: text(value.operationPointName, 240),
    hadAttendanceSession: value.hadAttendanceSession === true,
    statusAtLock: text(value.statusAtLock, 40) || CONFIRMED_ASSIGNMENT_STATUS,
    lockReason: text(value.lockReason, 80) || 'SERVICE_START_REACHED'
  };
}

export async function loadAttendanceBillingEligibilitySnapshots(prisma, input = {}) {
  if (!prisma?.devAuditEvent?.findMany) return [];
  const cycleStart = text(input.cycleStart, 10);
  const cycleEndExclusive = text(input.cycleEndExclusive, 10);
  const monthPrefix = cycleStart?.slice(0, 7);
  const events = await prisma.devAuditEvent.findMany({
    where: {
      entityType: ATTENDANCE_BILLING_ELIGIBILITY_ENTITY_TYPE,
      action: ATTENDANCE_BILLING_ELIGIBILITY_ACTION,
      ...(monthPrefix ? { entityId: { startsWith: `${monthPrefix}-` } } : {})
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
  });
  const seen = new Set();
  return events
    .map(publicSnapshot)
    .filter((item) => {
      if (!item.assignmentId || !item.serviceDate) return false;
      if (cycleStart && item.serviceDate < cycleStart) return false;
      if (cycleEndExclusive && item.serviceDate >= cycleEndExclusive) return false;
      if (seen.has(item.assignmentId)) return false;
      seen.add(item.assignmentId);
      return true;
    });
}

function assignmentSnapshotData(assignment, now, input = {}) {
  const serviceRequest = assignment?.serviceRequest || {};
  const worker = assignment?.worker || {};
  const serviceDate = dispatchServiceDateKey(serviceRequest.serviceDate);
  const moment = attendanceBillingServiceMoment(serviceRequest);
  return {
    assignmentId: assignment.id,
    serviceRequestId: assignment.serviceRequestId || serviceRequest.id || null,
    workerId: worker.id || assignment.workerId || null,
    fullName: text(worker.fullName, 240) || 'Auxiliar sin nombre',
    documentType: text(worker.documentType, 40),
    documentNumber: text(worker.documentNumber, 120),
    serviceDate,
    startTime: text(serviceRequest.startTime, 8),
    serviceMoment: moment?.toISOString() || null,
    operationPointId: serviceRequest.operationPointId || serviceRequest.operationPoint?.id || null,
    operationPointName: text(serviceRequest.operationPointName || serviceRequest.operationPoint?.name, 240),
    attendanceEnabledAtService: true,
    statusAtLock: assignment.status,
    hadAttendanceSession: Boolean(assignment.attendanceSession),
    lockReason: 'SERVICE_START_REACHED',
    lockedAt: now.toISOString(),
    actorUsername: text(input.actorUsername, 160),
    actorRole: text(input.actorRole, 80),
    actorSource: text(input.actorSource, 120) || 'attendance-billing-counter'
  };
}

export async function ensureAttendanceBillingEligibilityForAssignment(prisma, assignment, input = {}) {
  if (!assignment?.id || !assignment?.worker || assignment.worker.isTestProfile === true) {
    return { locked: false, reason: 'assignment_not_eligible' };
  }
  if (assignment.status !== CONFIRMED_ASSIGNMENT_STATUS) return { locked: false, reason: 'assignment_not_confirmed' };

  const moment = attendanceBillingServiceMoment(assignment.serviceRequest);
  if (!moment) return { locked: false, reason: 'service_start_missing' };
  const now = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
  if (Number.isNaN(now.getTime())) throw new Error('attendance_billing_now_invalid');
  if (now.getTime() < moment.getTime()) return { locked: false, reason: 'service_not_started' };

  const events = Array.isArray(input.enablementEvents)
    ? input.enablementEvents
    : await loadAttendanceBillingEnablementEvents(prisma, [assignment]);
  if (!attendanceEnabledAtService(events, assignment.serviceRequest)) {
    return { locked: false, reason: 'attendance_not_enabled_at_service' };
  }
  if (!prisma?.devAuditEvent?.findFirst || !prisma?.devAuditEvent?.create) {
    throw new Error('attendance_billing_eligibility_prisma_contract_invalid');
  }

  const entityId = eligibilityEntityId(assignment);
  if (!entityId) return { locked: false, reason: 'eligibility_identity_missing' };
  const existing = await prisma.devAuditEvent.findFirst({
    where: {
      entityType: ATTENDANCE_BILLING_ELIGIBILITY_ENTITY_TYPE,
      entityId,
      action: ATTENDANCE_BILLING_ELIGIBILITY_ACTION
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
  });
  if (existing) return { locked: false, existing: true, reason: 'already_locked', snapshot: publicSnapshot(existing) };

  const snapshot = assignmentSnapshotData(assignment, now, input);
  if (input.readOnly) return { locked: false, reason: 'preview_only', snapshot };
  const event = await prisma.devAuditEvent.create({
    data: {
      entityType: ATTENDANCE_BILLING_ELIGIBILITY_ENTITY_TYPE,
      entityId,
      entityLabel: `${snapshot.fullName} · ${snapshot.serviceDate} ${snapshot.startTime}`,
      action: ATTENDANCE_BILLING_ELIGIBILITY_ACTION,
      actorUsername: snapshot.actorUsername,
      actorRole: snapshot.actorRole,
      actorSource: snapshot.actorSource,
      metadata: snapshot
    }
  });
  return { locked: true, existing: false, reason: 'locked', snapshot: publicSnapshot(event) };
}

export async function ensureAttendanceBillingEligibilitySnapshots(prisma, assignments = [], input = {}) {
  const enablementEvents = Array.isArray(input.enablementEvents)
    ? input.enablementEvents
    : await loadAttendanceBillingEnablementEvents(prisma, assignments);
  const results = [];
  for (const assignment of assignments) {
    results.push(await ensureAttendanceBillingEligibilityForAssignment(prisma, assignment, {
      ...input,
      enablementEvents
    }));
  }
  return results;
}

async function assignmentForMutation(prisma, assignmentId) {
  if (!assignmentId || !prisma?.dispatchAssignment?.findUnique) return null;
  return prisma.dispatchAssignment.findUnique({
    where: { id: assignmentId },
    select: {
      id: true,
      workerId: true,
      serviceRequestId: true,
      status: true,
      worker: {
        select: {
          id: true,
          fullName: true,
          documentType: true,
          documentNumber: true,
          isTestProfile: true
        }
      },
      serviceRequest: {
        select: {
          id: true,
          serviceDate: true,
          startTime: true,
          operationPointId: true,
          operationPointName: true,
          operationPoint: { select: { id: true, name: true, attendanceEnabled: true } }
        }
      },
      attendanceSession: { select: { id: true } }
    }
  });
}

async function recordPostStartMutation(prisma, snapshot, mutation, input = {}) {
  if (!snapshot?.assignmentId || !prisma?.devAuditEvent?.create) return null;
  return prisma.devAuditEvent.create({
    data: {
      entityType: ATTENDANCE_BILLING_ELIGIBILITY_ENTITY_TYPE,
      entityId: snapshot.entityId || `${snapshot.serviceDate}:${snapshot.assignmentId}`,
      entityLabel: `${snapshot.fullName} · ${snapshot.serviceDate} ${snapshot.startTime}`,
      action: ATTENDANCE_BILLING_MUTATION_ACTION,
      actorUsername: text(input.actorUsername, 160),
      actorRole: text(input.actorRole, 80),
      actorSource: 'attendance-billing-mutation-guard',
      metadata: {
        assignmentId: snapshot.assignmentId,
        workerId: snapshot.workerId,
        fullName: snapshot.fullName,
        documentNumber: snapshot.documentNumber,
        serviceDate: snapshot.serviceDate,
        startTime: snapshot.startTime,
        serviceMoment: snapshot.serviceMoment,
        operationPointId: snapshot.operationPointId,
        operationPointName: snapshot.operationPointName,
        mutation,
        billingEligibilityPreserved: true
      }
    }
  });
}

function requestActor(req = {}) {
  return {
    actorUsername: req.session?.username || req.username || null,
    actorRole: req.session?.userRole || req.userRole || null,
    actorSource: 'attendance-billing-mutation-guard'
  };
}

export function attendanceBillingMutationGuard(prisma) {
  return async (req, res, next) => {
    if (String(req.method || '').toUpperCase() !== 'POST') return next();
    const path = String(req.path || req.originalUrl || '').split('?')[0];
    const directMutation = path === '/admin/operaciones/asignaciones/unassign'
      ? 'UNASSIGN_AFTER_SERVICE_START'
      : path === '/admin/operaciones/asignaciones/no-confirmado'
        ? 'NO_CONFIRMADO_AFTER_SERVICE_START'
        : null;
    if (!directMutation) return next();

    const assignmentId = text(req.body?.assignmentId, 180);
    if (!assignmentId) return next();
    try {
      const assignment = await assignmentForMutation(prisma, assignmentId);
      if (!assignment) return next();
      const eligibility = await ensureAttendanceBillingEligibilityForAssignment(prisma, assignment, {
        now: new Date(),
        ...requestActor(req)
      });
      const snapshot = eligibility.snapshot || null;
      if (snapshot) {
        res.on('finish', () => {
          if (res.statusCode >= 400) return;
          recordPostStartMutation(prisma, snapshot, directMutation, requestActor(req))
            .catch((error) => console.warn('[ATTENDANCE_BILLING_MUTATION_AUDIT_FAILED]', error?.message || error));
        });
      }
    } catch (error) {
      console.warn('[ATTENDANCE_BILLING_MUTATION_GUARD_FAILED]', error?.message || error);
    }
    return next();
  };
}

export async function loadAttendanceBillingSupportLog(prisma, input = {}) {
  if (!prisma?.devAuditEvent?.findMany) return [];
  const take = Math.max(1, Math.min(200, Number(input.take) || 100));
  const rows = await prisma.devAuditEvent.findMany({
    where: {
      entityType: ATTENDANCE_BILLING_ELIGIBILITY_ENTITY_TYPE,
      action: { in: [ATTENDANCE_BILLING_ELIGIBILITY_ACTION, ATTENDANCE_BILLING_MUTATION_ACTION] }
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take
  });
  return rows.map((row) => {
    const value = metadata(row);
    return {
      id: row.id,
      action: row.action,
      assignmentId: text(value.assignmentId, 180),
      fullName: text(value.fullName, 240) || 'Auxiliar sin nombre',
      documentNumber: text(value.documentNumber, 120),
      serviceDate: text(value.serviceDate, 10),
      startTime: text(value.startTime, 8),
      operationPointName: text(value.operationPointName, 240),
      mutation: text(value.mutation, 100),
      actorUsername: text(row.actorUsername, 160),
      actorRole: text(row.actorRole, 80),
      createdAt: row.createdAt || null
    };
  });
}
