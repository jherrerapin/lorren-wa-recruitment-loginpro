import express from 'express';

const PENDING_STATUSES = new Set(['PENDING_ASSIGNMENT', 'ASSIGNMENT_PARTIAL', 'PENDING_CONFIRMATION']);

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function isOpsUser(req) {
  const username = normalizeString(req.session?.username || req.username);
  return Boolean(username?.startsWith('operaciones-despacho'));
}

function canUseOps(req) {
  const role = req.session?.userRole || req.userRole;
  const canAccessDispatch = Boolean(req.session?.canAccessDispatch || req.canAccessDispatch);
  return role === 'dev' || canAccessDispatch || isOpsUser(req);
}

function requireOps(req, res, next) {
  const role = req.session?.userRole || req.userRole;
  if (!role) return res.redirect('/login');
  if (!canUseOps(req)) return res.status(403).send('Modulo no habilitado para este usuario');
  return next();
}

function statusLabel(value) {
  return {
    PENDING_ASSIGNMENT: 'Pendiente de asignación',
    ASSIGNMENT_PARTIAL: 'Asignación parcial',
    PENDING_CONFIRMATION: 'Pendiente de confirmación',
    ASSIGNMENT_COMPLETE: 'Asignación completa',
    CANCELLED: 'Cancelada'
  }[value] || value || 'Sin estado';
}

function sourceLabel(value) {
  return {
    INTERNAL: 'Interna',
    PUBLIC_LINK: 'Cliente',
    MANUAL: 'Manual'
  }[value] || value || 'Interna';
}

function formatDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(value));
}

function requestDateKey(value) {
  if (!value) return 'Sin fecha';
  return new Date(value).toISOString().slice(0, 10);
}

function incrementMap(map, key, amount = 1) {
  const safeKey = normalizeString(key) || 'Sin clasificar';
  map.set(safeKey, (map.get(safeKey) || 0) + amount);
}

function mapToRows(map) {
  return Array.from(map.entries())
    .map(([label, total]) => ({ label, total }))
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}

function buildClientRequestWhere(client) {
  const operationPointIds = client.operationPoints.map((operationPoint) => operationPoint.id);
  return {
    OR: [
      ...(operationPointIds.length ? [{ operationPointId: { in: operationPointIds } }] : []),
      { clientName: client.name }
    ]
  };
}

function buildStats(serviceRequests) {
  const statusCounts = new Map();
  const serviceCounts = new Map();
  const operationCounts = new Map();
  const dateCounts = new Map();
  const sourceCounts = new Map();

  let pending = 0;
  let complete = 0;
  let cancelled = 0;
  let totalRequiredWorkers = 0;
  let totalAssignedWorkers = 0;

  serviceRequests.forEach((request) => {
    const status = request.status || 'PENDING_ASSIGNMENT';
    if (PENDING_STATUSES.has(status)) pending += 1;
    if (status === 'ASSIGNMENT_COMPLETE') complete += 1;
    if (status === 'CANCELLED') cancelled += 1;

    totalRequiredWorkers += request.requiredWorkers || 0;
    totalAssignedWorkers += request.assignments?.length || 0;

    incrementMap(statusCounts, statusLabel(status));
    incrementMap(serviceCounts, request.serviceName || request.service?.name || 'Sin servicio');
    incrementMap(operationCounts, request.operationPointName || request.operationPoint?.name || 'Sin operación');
    incrementMap(dateCounts, requestDateKey(request.serviceDate));
    incrementMap(sourceCounts, sourceLabel(request.source));
  });

  const total = serviceRequests.length;
  const completionRate = total ? Math.round((complete / total) * 100) : 0;

  return {
    total,
    pending,
    complete,
    cancelled,
    totalRequiredWorkers,
    totalAssignedWorkers,
    completionRate,
    statusRows: mapToRows(statusCounts),
    serviceRows: mapToRows(serviceCounts),
    operationRows: mapToRows(operationCounts),
    dateRows: mapToRows(dateCounts).sort((a, b) => a.label.localeCompare(b.label)),
    sourceRows: mapToRows(sourceCounts)
  };
}

function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

function buildCsv(serviceRequests) {
  const headers = [
    'ID solicitud', 'Cliente', 'Operacion', 'Ciudad', 'Direccion', 'Servicio', 'Fecha',
    'Hora inicio', 'Hora fin', 'Auxiliares requeridos', 'Auxiliares asignados',
    'Estado', 'Origen', 'Solicitante', 'Telefono solicitante', 'Correo solicitante', 'Notas'
  ];

  const rows = serviceRequests.map((request) => [
    request.id,
    request.clientName,
    request.operationPointName || request.operationPoint?.name || '',
    request.cityName,
    request.address,
    request.serviceName || request.service?.name || '',
    formatDate(request.serviceDate),
    request.startTime,
    request.endTime,
    request.requiredWorkers,
    request.assignments?.length || 0,
    statusLabel(request.status),
    sourceLabel(request.source),
    request.requestedByName,
    request.requestedByPhone,
    request.requestedByEmail,
    request.notes
  ]);

  return '\uFEFF' + [headers, ...rows]
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n');
}

export function dispatchClientStatsRouter(prisma) {
  const router = express.Router();

  router.get('/clientes/:clientId/estadisticas', requireOps, async (req, res) => {
    const client = await prisma.dispatchClient.findUnique({
      where: { id: req.params.clientId },
      include: { operationPoints: { orderBy: { name: 'asc' } }, services: { orderBy: { name: 'asc' } } }
    });
    if (!client) return res.status(404).send('Cliente no encontrado');

    const serviceRequests = await prisma.dispatchServiceRequest.findMany({
      where: buildClientRequestWhere(client),
      include: {
        service: true,
        operationPoint: true,
        assignments: { include: { worker: true }, orderBy: { createdAt: 'asc' } }
      },
      orderBy: [{ serviceDate: 'desc' }, { createdAt: 'desc' }]
    });

    return res.render('operacionesClienteEstadisticas', {
      client,
      serviceRequests,
      stats: buildStats(serviceRequests),
      statusLabel,
      sourceLabel,
      formatDate,
      role: req.session?.userRole || req.userRole,
      baseUrl: `${req.protocol}://${req.get('host')}`
    });
  });

  router.get('/clientes/:clientId/estadisticas/exportar', requireOps, async (req, res) => {
    const client = await prisma.dispatchClient.findUnique({
      where: { id: req.params.clientId },
      include: { operationPoints: { select: { id: true } } }
    });
    if (!client) return res.status(404).send('Cliente no encontrado');

    const serviceRequests = await prisma.dispatchServiceRequest.findMany({
      where: buildClientRequestWhere(client),
      include: {
        service: true,
        operationPoint: true,
        assignments: { include: { worker: true }, orderBy: { createdAt: 'asc' } }
      },
      orderBy: [{ serviceDate: 'desc' }, { createdAt: 'desc' }]
    });

    const safeClientName = String(client.name || 'cliente').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'cliente';
    const filename = `solicitudes_${safeClientName}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(buildCsv(serviceRequests));
  });

  return router;
}
