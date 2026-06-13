import express from 'express';
import ExcelJS from 'exceljs';

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

function safeFileName(value) {
  return String(value || 'cliente')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'cliente';
}

function buildHorario(request) {
  const start = normalizeString(request.startTime) || '-';
  const end = normalizeString(request.endTime);
  return end ? `${start} - ${end}` : start;
}

function commonBorder(color = 'FFE5E7EB') {
  return {
    top: { style: 'thin', color: { argb: color } },
    left: { style: 'thin', color: { argb: color } },
    bottom: { style: 'thin', color: { argb: color } },
    right: { style: 'thin', color: { argb: color } }
  };
}

function applyTitle(sheet, title, subtitle, columnCount) {
  sheet.mergeCells(1, 1, 1, columnCount);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = title;
  titleCell.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E2D3D' } };
  sheet.getRow(1).height = 28;

  sheet.mergeCells(2, 1, 2, columnCount);
  const subtitleCell = sheet.getCell(2, 1);
  subtitleCell.value = subtitle;
  subtitleCell.font = { bold: true, size: 11, color: { argb: 'FF0D7A6B' } };
  subtitleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  sheet.getRow(2).height = 22;
}

function styleHeader(row) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D7A6B' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = commonBorder('FFCBD5E1');
  });
  row.height = 26;
}

function styleDataRow(row, index) {
  row.eachCell((cell) => {
    cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
    cell.border = commonBorder();
    if (index % 2 === 0) {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
    }
  });
}

function styleStatusCell(cell, status) {
  const colors = {
    ASSIGNMENT_COMPLETE: { fg: 'FFDCFCE7', font: 'FF166534' },
    PENDING_CONFIRMATION: { fg: 'FFDBEAFE', font: 'FF1D4ED8' },
    ASSIGNMENT_PARTIAL: { fg: 'FFFEF3C7', font: 'FF92400E' },
    PENDING_ASSIGNMENT: { fg: 'FFFEE2E2', font: 'FFB91C1C' },
    CANCELLED: { fg: 'FFFFEDD5', font: 'FF9A3412' }
  };
  const selected = colors[status] || { fg: 'FFF1F5F9', font: 'FF334155' };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: selected.fg } };
  cell.font = { bold: true, color: { argb: selected.font } };
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
}

function addKeyValueRow(sheet, label, value) {
  const row = sheet.addRow([label, value]);
  row.getCell(1).font = { bold: true, color: { argb: 'FF1E2D3D' } };
  row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
  row.eachCell((cell) => {
    cell.border = commonBorder();
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  });
}

function addBreakdownSection(sheet, title, rows) {
  sheet.addRow([]);
  const titleRow = sheet.addRow([title, 'Total']);
  styleHeader(titleRow);
  if (!rows.length) {
    const emptyRow = sheet.addRow(['Sin registros', 0]);
    styleDataRow(emptyRow, 0);
    return;
  }
  rows.forEach((item, index) => {
    const row = sheet.addRow([item.label, item.total]);
    styleDataRow(row, index);
  });
}

function addSummarySheet(workbook, client, stats) {
  const sheet = workbook.addWorksheet('Resumen');
  sheet.columns = [
    { key: 'label', width: 34 },
    { key: 'value', width: 28 }
  ];

  applyTitle(sheet, `Estadísticas del cliente`, client.name || 'Cliente', 2);
  addKeyValueRow(sheet, 'Total solicitudes', stats.total);
  addKeyValueRow(sheet, 'Solicitudes pendientes', stats.pending);
  addKeyValueRow(sheet, 'Solicitudes completadas', stats.complete);
  addKeyValueRow(sheet, 'Solicitudes canceladas', stats.cancelled);
  addKeyValueRow(sheet, 'Cumplimiento', `${stats.completionRate}%`);
  addKeyValueRow(sheet, 'Auxiliares solicitados', stats.totalRequiredWorkers);
  addKeyValueRow(sheet, 'Auxiliares asignados', stats.totalAssignedWorkers);
  addKeyValueRow(sheet, 'Operaciones creadas', client.operationPoints?.length || 0);
  addKeyValueRow(sheet, 'Servicios creados', client.services?.length || 0);

  addBreakdownSection(sheet, 'Solicitudes por estado', stats.statusRows);
  addBreakdownSection(sheet, 'Servicios más solicitados', stats.serviceRows);
  addBreakdownSection(sheet, 'Operaciones con más solicitudes', stats.operationRows);
  addBreakdownSection(sheet, 'Solicitudes por fecha', stats.dateRows);
  addBreakdownSection(sheet, 'Solicitudes por origen', stats.sourceRows);

  sheet.views = [{ state: 'frozen', ySplit: 2 }];
}

function addRequestsSheet(workbook, client, serviceRequests) {
  const sheet = workbook.addWorksheet('Solicitudes');
  sheet.columns = [
    { key: 'client', width: 28 },
    { key: 'operation', width: 28 },
    { key: 'city', width: 18 },
    { key: 'address', width: 34 },
    { key: 'service', width: 28 },
    { key: 'date', width: 14 },
    { key: 'time', width: 16 },
    { key: 'required', width: 16 },
    { key: 'assigned', width: 16 },
    { key: 'status', width: 24 },
    { key: 'source', width: 14 },
    { key: 'requestedBy', width: 24 },
    { key: 'requestedPhone', width: 18 },
    { key: 'requestedEmail', width: 30 },
    { key: 'notes', width: 40 }
  ];

  applyTitle(sheet, 'Detalle de solicitudes', client.name || 'Cliente', 15);
  sheet.addRow([
    'Cliente',
    'Operación',
    'Ciudad',
    'Dirección',
    'Servicio',
    'Fecha',
    'Horario',
    'Aux. requeridos',
    'Aux. asignados',
    'Estado',
    'Origen',
    'Solicitante',
    'Teléfono solicitante',
    'Correo solicitante',
    'Notas'
  ]);
  styleHeader(sheet.getRow(3));

  serviceRequests.forEach((request, index) => {
    const row = sheet.addRow({
      client: request.clientName || client.name || '',
      operation: request.operationPointName || request.operationPoint?.name || '',
      city: request.cityName || '',
      address: request.address || '',
      service: request.serviceName || request.service?.name || '',
      date: formatDate(request.serviceDate),
      time: buildHorario(request),
      required: request.requiredWorkers || 0,
      assigned: request.assignments?.length || 0,
      status: statusLabel(request.status),
      source: sourceLabel(request.source),
      requestedBy: request.requestedByName || '',
      requestedPhone: request.requestedByPhone || '',
      requestedEmail: request.requestedByEmail || '',
      notes: request.notes || ''
    });
    styleDataRow(row, index);
    styleStatusCell(row.getCell('status'), request.status);
  });

  sheet.getColumn('requestedPhone').numFmt = '@';
  sheet.views = [{ state: 'frozen', ySplit: 3 }];
  sheet.autoFilter = { from: 'A3', to: 'O3' };
}

function buildWorkbook(client, serviceRequests) {
  const stats = buildStats(serviceRequests);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'LoginPro Operaciones';
  workbook.created = new Date();
  workbook.modified = new Date();

  addSummarySheet(workbook, client, stats);
  addRequestsSheet(workbook, client, serviceRequests);

  return workbook;
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
      include: {
        operationPoints: { select: { id: true }, orderBy: { name: 'asc' } },
        services: { select: { id: true }, orderBy: { name: 'asc' } }
      }
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

    const workbook = buildWorkbook(client, serviceRequests);
    const filename = `solicitudes_${safeFileName(client.name)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  });

  return router;
}
