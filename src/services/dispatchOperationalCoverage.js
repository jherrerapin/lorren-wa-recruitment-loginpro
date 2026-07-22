export const ACTIVE_DISPATCH_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
export const CONFIRMED_DISPATCH_ASSIGNMENT_STATUS = 'CONFIRMED';

export function isOperationalDispatchWorker(worker) {
  return !Boolean(worker?.isTestProfile);
}

export function operationalAssignments(request = {}) {
  return (request.assignments || []).filter((assignment) => (
    ACTIVE_DISPATCH_ASSIGNMENT_STATUSES.includes(assignment?.status)
    && isOperationalDispatchWorker(assignment?.worker)
  ));
}

export function confirmedOperationalAssignments(request = {}) {
  return (request.assignments || []).filter((assignment) => (
    assignment?.status === CONFIRMED_DISPATCH_ASSIGNMENT_STATUS
    && isOperationalDispatchWorker(assignment?.worker)
  ));
}

export function deriveDispatchRequestOperationalState(request = {}) {
  const requiredWorkers = Math.max(0, Number(request.requiredWorkers || 0));
  const activeCount = operationalAssignments(request).length;
  const confirmedCount = confirmedOperationalAssignments(request).length;
  let status = 'PENDING_ASSIGNMENT';
  if (confirmedCount >= requiredWorkers && requiredWorkers > 0) status = 'ASSIGNMENT_COMPLETE';
  else if (activeCount >= requiredWorkers && requiredWorkers > 0) status = 'PENDING_CONFIRMATION';
  else if (activeCount > 0) status = 'ASSIGNMENT_PARTIAL';
  return { status, activeCount, confirmedCount, requiredWorkers };
}

export async function recalculateDispatchServiceRequestStatus(prisma, serviceRequestId) {
  const request = await prisma.dispatchServiceRequest.findUnique({
    where: { id: serviceRequestId },
    select: {
      id: true,
      requiredWorkers: true,
      assignments: {
        where: { status: { in: ACTIVE_DISPATCH_ASSIGNMENT_STATUSES } },
        select: {
          status: true,
          worker: { select: { isTestProfile: true } }
        }
      }
    }
  });
  if (!request) return null;
  const state = deriveDispatchRequestOperationalState(request);
  await prisma.dispatchServiceRequest.update({
    where: { id: serviceRequestId },
    data: { status: state.status }
  });
  return state;
}
