const GROUP_PATTERN = /\s*·\s*Grupo\s+(GRP-[A-Z0-9-]+)/i;

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function extractGroupCode(request) {
  const match = normalizeString(request?.serviceName)?.match(GROUP_PATTERN);
  return match?.[1] || null;
}

function cleanServiceName(value) {
  return normalizeString(value)?.replace(GROUP_PATTERN, '').trim() || null;
}

function sortRequestBlocks(requests = []) {
  return [...requests].sort((a, b) => {
    const dateA = new Date(a.serviceDate || 0).getTime();
    const dateB = new Date(b.serviceDate || 0).getTime();
    if (dateA !== dateB) return dateA - dateB;
    return String(a.startTime || '').localeCompare(String(b.startTime || ''), 'es');
  });
}

function serviceDateKey(value) {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 10);
}

function serviceStartDateTime(request) {
  const date = serviceDateKey(request?.serviceDate);
  if (!date) return null;
  const time = request?.startTime || '00:00';
  return new Date(`${date}T${time}:00-05:00`);
}

function getRequestEditLock(requests = []) {
  const hasAssignments = requests.some((request) => (request.assignments || []).length > 0);
  if (hasAssignments) return { editable: false, reason: 'La solicitud ya tiene asignaciones registradas por Operaciones / Despacho.' };

  const now = new Date();
  const hasStarted = requests.some((request) => {
    const start = serviceStartDateTime(request);
    return start && start <= now;
  });
  if (hasStarted) return { editable: false, reason: 'La fecha y hora de inicio del servicio ya pasaron.' };

  return { editable: true, reason: null };
}

function buildHistoryItem(client, requests = []) {
  const sortedRequests = sortRequestBlocks(requests);
  const primary = sortedRequests[0] || null;
  if (!primary) return null;

  const groupCode = extractGroupCode(primary);
  const requestKey = groupCode || primary.id;
  const editLock = getRequestEditLock(sortedRequests);
  const totalRequired = sortedRequests.reduce((sum, request) => sum + (Number(request.requiredWorkers) || 0), 0);
  const activeStatuses = new Set(['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED']);
  const activeCount = sortedRequests.reduce((sum, request) => sum + (request.assignments || []).filter((assignment) => activeStatuses.has(assignment.status)).length, 0);
  const confirmedCount = sortedRequests.reduce((sum, request) => sum + (request.assignments || []).filter((assignment) => assignment.status === 'CONFIRMED').length, 0);

  return {
    requestKey,
    groupCode,
    isGrouped: sortedRequests.length > 1,
    primary,
    requests: sortedRequests,
    createdAt: sortedRequests.reduce((oldest, request) => {
      if (!request.createdAt) return oldest;
      if (!oldest) return request.createdAt;
      return new Date(request.createdAt) < new Date(oldest) ? request.createdAt : oldest;
    }, null),
    serviceName: cleanServiceName(primary.serviceName) || primary.service?.name || 'Sin servicio',
    operationPointName: primary.operationPointName || 'Sin operación',
    cityName: primary.cityName || '',
    serviceDate: primary.serviceDate,
    totalRequired,
    activeCount,
    confirmedCount,
    editable: editLock.editable,
    editBlockedReason: editLock.reason,
    viewUrl: `/operaciones/cliente/${client.publicToken}/solicitudes/${encodeURIComponent(requestKey)}`,
    editUrl: `/operaciones/cliente/${client.publicToken}/solicitudes/${encodeURIComponent(requestKey)}/editar`
  };
}

export async function loadPublicDispatchRequestHistory(prisma, client, limit = 30) {
  const operationPointIds = (client?.operationPoints || []).map((operationPoint) => operationPoint.id);
  if (!client?.publicToken || !operationPointIds.length) return [];

  const serviceRequests = await prisma.dispatchServiceRequest.findMany({
    where: {
      operationPointId: { in: operationPointIds },
      source: 'PUBLIC_LINK'
    },
    include: {
      service: true,
      assignments: { select: { id: true, status: true }, orderBy: { createdAt: 'asc' } }
    },
    orderBy: [{ serviceDate: 'desc' }, { createdAt: 'desc' }],
    take: 200
  });

  const groups = new Map();
  for (const request of serviceRequests) {
    const groupCode = extractGroupCode(request);
    const key = groupCode ? `group:${groupCode}` : `request:${request.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(request);
  }

  return [...groups.values()]
    .map((requests) => buildHistoryItem(client, requests))
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt || b.primary.createdAt || 0) - new Date(a.createdAt || a.primary.createdAt || 0))
    .slice(0, limit);
}
