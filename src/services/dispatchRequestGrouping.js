const LEGACY_GROUP_PATTERN = /\s*·\s*Grupo\s+(GRP-[A-Z0-9-]+)/i;

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function sortRequestsByServiceTime(requests) {
  return [...requests].sort((a, b) => {
    const dateA = new Date(a.serviceDate || 0).getTime();
    const dateB = new Date(b.serviceDate || 0).getTime();
    if (dateA !== dateB) return dateA - dateB;
    return String(a.startTime || '').localeCompare(String(b.startTime || ''), 'es');
  });
}

export function extractRequestGroupCode(request) {
  const explicitCode = normalizeString(request?.requestGroupCode);
  if (explicitCode) return explicitCode;
  const match = normalizeString(request?.serviceName)?.match(LEGACY_GROUP_PATTERN);
  return match?.[1] || null;
}

export function stripRequestGroupSuffix(value) {
  return normalizeString(value)?.replace(LEGACY_GROUP_PATTERN, '').trim() || null;
}

export function resolveRequestServiceName(request) {
  return stripRequestGroupSuffix(request?.serviceName) || request?.service?.name || null;
}

export function countAssignments(request, activeStatuses = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED']) {
  const assignments = request?.assignments || [];
  return {
    activeCount: assignments.filter((assignment) => activeStatuses.includes(assignment.status)).length,
    confirmedCount: assignments.filter((assignment) => assignment.status === 'CONFIRMED').length,
    totalCount: assignments.length
  };
}

export function deriveGroupedStatus(requiredWorkers, activeCount, confirmedCount) {
  if (confirmedCount >= requiredWorkers) return 'ASSIGNMENT_COMPLETE';
  if (activeCount >= requiredWorkers) return 'PENDING_CONFIRMATION';
  if (activeCount > 0) return 'ASSIGNMENT_PARTIAL';
  return 'PENDING_ASSIGNMENT';
}

export function buildGroupedServiceRequests(serviceRequests = [], activeStatuses = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED']) {
  const groups = new Map();

  for (const request of serviceRequests) {
    const groupCode = extractRequestGroupCode(request);
    const key = groupCode ? `group:${groupCode}` : `request:${request.id}`;
    if (!groups.has(key)) {
      groups.set(key, { key, groupCode, isGrouped: Boolean(groupCode), requests: [] });
    }
    groups.get(key).requests.push(request);
  }

  return [...groups.values()].map((group) => {
    const requests = sortRequestsByServiceTime(group.requests);
    const primary = requests[0] || {};
    const requiredWorkers = requests.reduce((sum, request) => sum + (Number(request.requiredWorkers) || 0), 0);
    const counts = requests.reduce((summary, request) => {
      const current = countAssignments(request, activeStatuses);
      summary.activeCount += current.activeCount;
      summary.confirmedCount += current.confirmedCount;
      summary.assignmentCount += current.totalCount;
      return summary;
    }, { activeCount: 0, confirmedCount: 0, assignmentCount: 0 });
    const serviceName = resolveRequestServiceName(primary);
    const nextRequest = requests.find((request) => countAssignments(request, activeStatuses).confirmedCount < (Number(request.requiredWorkers) || 0)) || primary;

    return {
      ...group,
      id: group.key,
      primary,
      primaryId: primary.id,
      nextRequestId: nextRequest?.id || primary.id,
      clientName: primary.clientName,
      operationPointName: primary.operationPointName,
      cityName: primary.cityName,
      address: primary.address,
      serviceDate: primary.serviceDate,
      serviceName,
      service: primary.service,
      source: primary.source,
      requestedByName: primary.requestedByName,
      requestedByPhone: primary.requestedByPhone,
      requestedByEmail: primary.requestedByEmail,
      notes: primary.notes,
      requiredWorkers,
      activeCount: counts.activeCount,
      confirmedCount: counts.confirmedCount,
      assignmentCount: counts.assignmentCount,
      status: deriveGroupedStatus(requiredWorkers, counts.activeCount, counts.confirmedCount),
      requests
    };
  }).sort((a, b) => {
    const dateA = new Date(a.serviceDate || 0).getTime();
    const dateB = new Date(b.serviceDate || 0).getTime();
    if (dateA !== dateB) return dateB - dateA;
    return String(b.primary?.createdAt || '').localeCompare(String(a.primary?.createdAt || ''), 'es');
  });
}

export function findGroupForServiceRequest(serviceRequestGroups = [], serviceRequestId) {
  if (!serviceRequestId) return null;
  return serviceRequestGroups.find((group) => group.requests.some((request) => request.id === serviceRequestId)) || null;
}

export function buildGroupedWhereClauseForRequest(serviceRequest) {
  const groupCode = extractRequestGroupCode(serviceRequest);
  if (!groupCode) return { id: serviceRequest.id };
  return { serviceName: { contains: `Grupo ${groupCode}` } };
}
