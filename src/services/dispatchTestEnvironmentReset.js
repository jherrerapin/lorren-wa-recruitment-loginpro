import { deleteObjectFromR2 } from './storage.js';
import { recalculateDispatchServiceRequestStatus } from './dispatchOperationalCoverage.js';

export const DISPATCH_TEST_RESET_CONFIRMATION = 'REINICIAR';
export const DISPATCH_TEST_RESET_ONCE_KEY = 'DISPATCH_TEST_ENVIRONMENT_RESET_2026_07_28_V1';

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function ids(rows = []) {
  return unique(rows.map((row) => row?.id));
}

function countResult(result) {
  return Number(result?.count || 0);
}

function buildAuditWhere(snapshot) {
  const entityIds = unique([
    ...snapshot.workerIds,
    ...snapshot.clientIds,
    ...snapshot.operationPointIds,
    ...snapshot.serviceIds,
    ...snapshot.serviceRequestIds,
    ...snapshot.assignmentIds,
    ...snapshot.attendanceSessionIds,
    ...snapshot.attendanceMarkIds,
    ...snapshot.attendanceIdempotencyKeys,
    ...snapshot.deviceIds,
    ...snapshot.activationIds,
    ...snapshot.portalSessionIds
  ]);
  const filters = [];
  if (entityIds.length) {
    filters.push({ entityId: { in: entityIds } });
    filters.push({ entityLabel: { in: entityIds } });
  }
  for (const workerId of snapshot.workerIds) {
    filters.push({ metadata: { path: ['workerId'], equals: workerId } });
  }
  for (const assignmentId of snapshot.assignmentIds) {
    filters.push({ metadata: { path: ['assignmentId'], equals: assignmentId } });
  }
  for (const attendanceSessionId of snapshot.attendanceSessionIds) {
    filters.push({ metadata: { path: ['attendanceSessionId'], equals: attendanceSessionId } });
  }
  return filters.length ? { OR: filters } : null;
}

function buildIncidentWhere(snapshot) {
  const filters = [];
  if (snapshot.serviceRequestIds.length) filters.push({ serviceRequestId: { in: snapshot.serviceRequestIds } });
  if (snapshot.assignmentIds.length) filters.push({ assignmentId: { in: snapshot.assignmentIds } });
  if (snapshot.workerIds.length) filters.push({ workerId: { in: snapshot.workerIds } });
  return filters.length ? { OR: filters } : null;
}

export async function inspectDispatchTestEnvironment(prisma) {
  const [workers, clients] = await Promise.all([
    prisma.dispatchWorker.findMany({
      where: { isTestProfile: true },
      select: { id: true, fullName: true }
    }),
    prisma.dispatchClient.findMany({
      where: { isTestClient: true },
      select: {
        id: true,
        name: true,
        operationPoints: { select: { id: true } },
        services: { select: { id: true } }
      }
    })
  ]);

  const workerIds = ids(workers);
  const clientIds = ids(clients);
  const clientNames = unique(clients.map((client) => client.name));
  const operationPointIds = unique(clients.flatMap((client) => client.operationPoints.map((point) => point.id)));
  const serviceIds = unique(clients.flatMap((client) => client.services.map((service) => service.id)));
  const serviceRequestFilters = [];
  if (operationPointIds.length) serviceRequestFilters.push({ operationPointId: { in: operationPointIds } });
  if (serviceIds.length) serviceRequestFilters.push({ serviceId: { in: serviceIds } });
  if (clientNames.length) serviceRequestFilters.push({ clientName: { in: clientNames } });

  const serviceRequests = serviceRequestFilters.length
    ? await prisma.dispatchServiceRequest.findMany({
      where: { OR: serviceRequestFilters },
      select: { id: true }
    })
    : [];
  const serviceRequestIds = ids(serviceRequests);

  const assignmentFilters = [];
  if (workerIds.length) assignmentFilters.push({ workerId: { in: workerIds } });
  if (serviceRequestIds.length) assignmentFilters.push({ serviceRequestId: { in: serviceRequestIds } });
  const assignments = assignmentFilters.length
    ? await prisma.dispatchAssignment.findMany({
      where: { OR: assignmentFilters },
      select: { id: true, workerId: true, serviceRequestId: true }
    })
    : [];
  const assignmentIds = ids(assignments);

  const attendanceSessions = assignmentIds.length
    ? await prisma.dispatchAttendanceSession.findMany({
      where: { assignmentId: { in: assignmentIds } },
      select: {
        id: true,
        marks: {
          select: {
            id: true,
            idempotencyKey: true,
            evidenceStorageKey: true
          }
        }
      }
    })
    : [];
  const attendanceSessionIds = ids(attendanceSessions);
  const attendanceMarks = attendanceSessions.flatMap((session) => session.marks || []);
  const attendanceMarkIds = ids(attendanceMarks);
  const attendanceIdempotencyKeys = unique(attendanceMarks.map((mark) => mark.idempotencyKey));
  const evidenceStorageKeys = unique(attendanceMarks.map((mark) => mark.evidenceStorageKey));

  const [devices, activations, portalSessions] = workerIds.length
    ? await Promise.all([
      prisma.dispatchWorkerDevice.findMany({ where: { workerId: { in: workerIds } }, select: { id: true } }),
      prisma.dispatchWorkerActivation.findMany({ where: { workerId: { in: workerIds } }, select: { id: true } }),
      prisma.dispatchWorkerPortalSession.findMany({ where: { workerId: { in: workerIds } }, select: { id: true } })
    ])
    : [[], [], []];

  const deletedServiceRequestIds = new Set(serviceRequestIds);
  const survivingAffectedServiceRequestIds = unique(
    assignments
      .map((assignment) => assignment.serviceRequestId)
      .filter((serviceRequestId) => !deletedServiceRequestIds.has(serviceRequestId))
  );

  return {
    workers,
    clients,
    workerIds,
    clientIds,
    clientNames,
    operationPointIds,
    serviceIds,
    serviceRequestIds,
    assignments,
    assignmentIds,
    attendanceSessionIds,
    attendanceMarkIds,
    attendanceIdempotencyKeys,
    evidenceStorageKeys,
    deviceIds: ids(devices),
    activationIds: ids(activations),
    portalSessionIds: ids(portalSessions),
    survivingAffectedServiceRequestIds
  };
}

export async function resetDispatchTestEnvironment(prisma, options = {}) {
  const deleteEvidence = options.deleteEvidence || deleteObjectFromR2;
  const recalculateStatus = options.recalculateStatus
    || ((serviceRequestId) => recalculateDispatchServiceRequestStatus(prisma, serviceRequestId));
  const snapshot = await inspectDispatchTestEnvironment(prisma);

  const evidenceResults = await Promise.allSettled(
    snapshot.evidenceStorageKeys.map((storageKey) => deleteEvidence(storageKey))
  );
  const evidenceDeleted = evidenceResults.filter((result) => result.status === 'fulfilled').length;
  const evidenceFailed = evidenceResults.length - evidenceDeleted;

  const auditWhere = buildAuditWhere(snapshot);
  const incidentWhere = buildIncidentWhere(snapshot);

  const deleted = await prisma.$transaction(async (tx) => {
    const summary = {
      auditEvents: 0,
      attendanceReviews: 0,
      attendanceMarks: 0,
      attendanceSessions: 0,
      whatsappConfirmations: 0,
      incidents: 0,
      portalSessions: 0,
      activations: 0,
      devices: 0,
      assignments: 0,
      serviceRequests: 0
    };

    if (auditWhere) summary.auditEvents = countResult(await tx.devAuditEvent.deleteMany({ where: auditWhere }));
    if (snapshot.attendanceSessionIds.length) {
      summary.attendanceReviews = countResult(await tx.dispatchAttendanceReview.deleteMany({
        where: { attendanceSessionId: { in: snapshot.attendanceSessionIds } }
      }));
      summary.attendanceMarks = countResult(await tx.dispatchAttendanceMark.deleteMany({
        where: { attendanceSessionId: { in: snapshot.attendanceSessionIds } }
      }));
      summary.attendanceSessions = countResult(await tx.dispatchAttendanceSession.deleteMany({
        where: { id: { in: snapshot.attendanceSessionIds } }
      }));
    }
    if (snapshot.assignmentIds.length) {
      summary.whatsappConfirmations = countResult(await tx.dispatchWhatsappConfirmation.deleteMany({
        where: { assignmentId: { in: snapshot.assignmentIds } }
      }));
    }
    if (incidentWhere) summary.incidents = countResult(await tx.dispatchIncident.deleteMany({ where: incidentWhere }));
    if (snapshot.workerIds.length) {
      summary.portalSessions = countResult(await tx.dispatchWorkerPortalSession.deleteMany({
        where: { workerId: { in: snapshot.workerIds } }
      }));
      summary.activations = countResult(await tx.dispatchWorkerActivation.deleteMany({
        where: { workerId: { in: snapshot.workerIds } }
      }));
      summary.devices = countResult(await tx.dispatchWorkerDevice.deleteMany({
        where: { workerId: { in: snapshot.workerIds } }
      }));
    }
    if (snapshot.assignmentIds.length) {
      summary.assignments = countResult(await tx.dispatchAssignment.deleteMany({
        where: { id: { in: snapshot.assignmentIds } }
      }));
    }
    if (snapshot.serviceRequestIds.length) {
      summary.serviceRequests = countResult(await tx.dispatchServiceRequest.deleteMany({
        where: { id: { in: snapshot.serviceRequestIds } }
      }));
    }
    return summary;
  });

  for (const serviceRequestId of snapshot.survivingAffectedServiceRequestIds) {
    await recalculateStatus(serviceRequestId);
  }

  return {
    workersPreserved: snapshot.workers.length,
    clientsPreserved: snapshot.clients.length,
    evidenceDeleted,
    evidenceFailed,
    ...deleted
  };
}

export async function resetDispatchTestEnvironmentOnce(prisma, options = {}) {
  const marker = await prisma.botKnowledge.findUnique({
    where: { key: DISPATCH_TEST_RESET_ONCE_KEY },
    select: { value: true }
  });
  if (marker) return { skipped: true, marker: marker.value };

  const result = await resetDispatchTestEnvironment(prisma, options);
  const value = JSON.stringify({ completedAt: new Date().toISOString(), result });
  await prisma.botKnowledge.upsert({
    where: { key: DISPATCH_TEST_RESET_ONCE_KEY },
    update: { value },
    create: { key: DISPATCH_TEST_RESET_ONCE_KEY, value }
  });
  return { skipped: false, ...result };
}
