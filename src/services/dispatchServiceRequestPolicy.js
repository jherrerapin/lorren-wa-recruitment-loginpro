import { dispatchServiceDateKey } from './dispatchDate.js';

export const DISPATCH_SERVICE_REQUEST_EDIT_GRACE_PERIOD_MS = 2 * 60 * 60 * 1000;
export const DISPATCH_SERVICE_REQUEST_LOCKED_MESSAGE = 'Esta solicitud ya superó las 2 horas posteriores a la hora de inicio del servicio y quedó disponible solo para consulta.';

const TIME_HH_MM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function dispatchServiceRequestStartAt(request = {}) {
  const date = dispatchServiceDateKey(request.serviceDate);
  const startTime = String(request.startTime || '').trim();
  if (!date || !TIME_HH_MM_PATTERN.test(startTime)) return null;
  const start = new Date(`${date}T${startTime}:00-05:00`);
  return Number.isNaN(start.getTime()) ? null : start;
}

export function isDispatchServiceRequestEditLocked(request = {}, now = new Date()) {
  const start = dispatchServiceRequestStartAt(request);
  if (!start) return false;
  return now.getTime() >= start.getTime() + DISPATCH_SERVICE_REQUEST_EDIT_GRACE_PERIOD_MS;
}

export function isDispatchTestClientRequest(request = {}) {
  return Boolean(
    request.operationPoint?.client?.isTestClient === true
    || request.service?.client?.isTestClient === true
    || request.client?.isTestClient === true
  );
}

export function buildDispatchServiceRequestPolicy(request = {}, now = new Date()) {
  const editLocked = isDispatchServiceRequestEditLocked(request, now);
  const isTestClient = isDispatchTestClientRequest(request);
  return {
    editLocked,
    isTestClient,
    canEdit: !editLocked,
    canDelete: isTestClient || !editLocked
  };
}

export function dispatchServiceRequestPolicyInclude() {
  return {
    operationPoint: {
      include: {
        client: { select: { id: true, isTestClient: true } }
      }
    },
    service: {
      include: {
        client: { select: { id: true, isTestClient: true } }
      }
    }
  };
}

export async function deleteDispatchServiceRequest(prisma, serviceRequestId, { now = new Date() } = {}) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.dispatchServiceRequest.findUnique({
      where: { id: serviceRequestId },
      include: dispatchServiceRequestPolicyInclude()
    });
    if (!request) return { ok: false, reason: 'not_found' };

    const policy = buildDispatchServiceRequestPolicy(request, now);
    if (!policy.canDelete) return { ok: false, reason: 'locked', policy };

    const assignments = await tx.dispatchAssignment.findMany({
      where: { serviceRequestId },
      select: { id: true }
    });
    const assignmentIds = assignments.map((assignment) => assignment.id);
    if (assignmentIds.length) {
      const sessions = await tx.dispatchAttendanceSession.findMany({
        where: { assignmentId: { in: assignmentIds } },
        select: { id: true }
      });
      const sessionIds = sessions.map((session) => session.id);
      if (sessionIds.length) {
        await tx.dispatchAttendanceReview.deleteMany({ where: { attendanceSessionId: { in: sessionIds } } });
        await tx.dispatchAttendanceMark.deleteMany({ where: { attendanceSessionId: { in: sessionIds } } });
        await tx.dispatchAttendanceSession.deleteMany({ where: { id: { in: sessionIds } } });
      }
    }

    await tx.dispatchServiceRequest.delete({ where: { id: serviceRequestId } });
    return { ok: true, reason: 'deleted', policy };
  });
}
