import express from 'express';
import ExcelJS from 'exceljs';

const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const CONFIRMED_ASSIGNMENT_STATUS = 'CONFIRMED';

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

function todayIsoDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' })).toISOString().slice(0, 10);
}

function normalizeDateParam(value) {
  const rawValue = normalizeString(value);
  if (!rawValue) return todayIsoDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawValue)) return todayIsoDate();
  const parsed = new Date(`${rawValue}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return todayIsoDate();
  return rawValue;
}

function buildUtcDayRange(dateText) {
  const start = new Date(`${dateText}T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

function statusLabel(value) {
  return ({
    PENDING_ASSIGNMENT: 'Pendiente de asignación',
    ASSIGNMENT_PARTIAL: 'Asignación parcial',
    PENDING_CONFIRMATION: 'Pendiente de confirmación',
    ASSIGNMENT_COMPLETE: 'Asignación completa',
    CANCELLED: 'Cancelada'
  }[value] || value || 'Pendiente');
}

function formatDate(value) {
  if (!value) return '-';
  return new Date(value).toISOString().slice(0, 10);
}

function cleanSheetName(value, fallback) {
  const base = normalizeString(value) || fallback;
  return base.replace(/[\\/*?:[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || fallback;
}

function buildHorario(request) {
  return request.endTime ? `${request.startTime || '-'} - ${request.endTime}` : (request.startTime || '-');
}

function activeAssignments(request) {
  return (request.assignments || []).filter((assignment) => ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status));
}

function confirmedAssignments(request) {
  return (request.assignments || []).filter((assignment) => assignment.status === CONFIRMED_ASSIGNMENT_STATUS);
}

function assignedWorkerNames(request) {
  const names = activeAssignments(request).map((assignment) => assignment.worker?.fullName).filter(Boolean);
  return names.length ? names.join(', ') : '-';
}

function groupByClient(requests) {
  const map = new Map();
  for (const request of requests) {
    const key = request.clientName || 'Sin cliente';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(request);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b, 'es'));
}

function applyTitle(worksheet, title, subtitle, columnCount) {
  worksheet.mergeCells(1, 1, 1, columnCount);
  const titleCell = worksheet.getCell(1, 1);
  titleCell.value = title;
  titleCell.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E2D3D' } };
  worksheet.getRow(1).height = 28;

  worksheet.mergeCells(2, 1, 2, columnCount);
  const subtitleCell = worksheet.getCell(2, 1);
  subtitleCell.value = subtitle;
  subtitleCell.font = { bold: true, size: 11, color: { argb: 'FF0D7A6B' } };
  subtitleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  worksheet.getRow(2).height = 22;
}

function commonBorder(color = 'FFE5E7EB') {
  return {
    top: { style: 'thin', color: { argb: color } },
    left: { style: 'thin', color: { argb: color } },
    bottom: { style: 'thin', color: { argb: color } },
    right: { style: 'thin', color: { argb: color } }
  };
}

function styleHeader(row) {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D7A6B' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = commonBorder('FFCBD5E1');
  });
  row.height = 24;
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
    PENDING_ASSIGNMENT: { fg: 'FFFEE2E2', font: 'FFB91C1C' }
  };
  const selected = colors[status] || { fg: 'FFF1F5F9', font: 'FF334155' };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: selected.fg } };
  cell.font = { bold: true, color: { argb: selected.font } };
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
}

async function buildOperationsDashboardMetrics(prisma, selectedDate) {
  const { start, end } = buildUtcDayRange(selectedDate);
  const whereForDate = { serviceDate: { gte: start, lt: end } };
  const pendingStatuses = ['PENDING_ASSIGNMENT', 'ASSIGNMENT_PARTIAL', 'PENDING_CONFIRMATION'];

  const [totalRequests, pendingRequests, completedRequests, openIncidents] = await Promise.all([
    prisma.dispatchServiceRequest.count({ where: whereForDate }),
    prisma.dispatchServiceRequest.count({ where: { ...whereForDate, status: { in: pendingStatuses } } }),
    prisma.dispatchServiceRequest.count({ where: { ...whereForDate, status: 'ASSIGNMENT_COMPLETE' } }),
    prisma.dispatchIncident.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] }, serviceRequest: whereForDate } })
  ]);
  return { totalRequests, pendingRequests, completedRequests, openIncidents };
}

async function loadScheduleRequests(prisma, selectedDate) {
  const { start, end } = buildUtcDayRange(selectedDate);
  return prisma.dispatchServiceRequest.findMany({
    where: { serviceDate: { gte: start, lt: end } },
    include: {
      service: true,
      assignments: {
        include: { worker: true },
        orderBy: [{ status: 'asc' }, { createdAt: 'asc' }]
      }
    },
    orderBy: [{ clientName: 'asc' }, { operationPointName: 'asc' }, { startTime: 'asc' }, { createdAt: 'asc' }]
  });
}

function addSummarySheet(workbook, selectedDate, requestsByClient, requests) {
  const sheet = workbook.addWorksheet('Resumen');
  sheet.columns = [
    { key: 'client', width: 32 },
    { key: 'requests', width: 14 },
    { key: 'required', width: 16 },
    { key: 'active', width: 18 },
    { key: 'confirmed', width: 14 },
    { key: 'pending', width: 14 }
  ];
  applyTitle(sheet, 'Programación operativa por cliente', `Fecha de servicio: ${selectedDate}`, 6);
  sheet.addRow(['Cliente', 'Solicitudes', 'Aux. requeridos', 'Asignados activos', 'Confirmados', 'Pendientes']);
  styleHeader(sheet.getRow(3));

  requestsByClient.forEach(([clientName, clientRequests], index) => {
    const required = clientRequests.reduce((sum, request) => sum + Number(request.requiredWorkers || 0), 0);
    const active = clientRequests.reduce((sum, request) => sum + activeAssignments(request).length, 0);
    const confirmed = clientRequests.reduce((sum, request) => sum + confirmedAssignments(request).length, 0);
    const row = sheet.addRow({ client: clientName, requests: clientRequests.length, required, active, confirmed, pending: Math.max(0, required - confirmed) });
    styleDataRow(row, index);
  });

  const totalRequired = requests.reduce((sum, request) => sum + Number(request.requiredWorkers || 0), 0);
  const totalConfirmed = requests.reduce((sum, request) => sum + confirmedAssignments(request).length, 0);
  const totals = sheet.addRow({
    client: 'TOTAL GENERAL',
    requests: requests.length,
    required: totalRequired,
    active: requests.reduce((sum, request) => sum + activeAssignments(request).length, 0),
    confirmed: totalConfirmed,
    pending: Math.max(0, totalRequired - totalConfirmed)
  });
  totals.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E2D3D' } };
    cell.border = commonBorder('FFCBD5E1');
  });
  sheet.views = [{ state: 'frozen', ySplit: 3 }];
  sheet.autoFilter = { from: 'A3', to: 'F3' };
}

function addClientSheet(workbook, clientName, selectedDate, requests, sheetIndex) {
  const sheet = workbook.addWorksheet(cleanSheetName(clientName, `Cliente ${sheetIndex}`));
  sheet.columns = [
    { key: 'operation', width: 28 },
    { key: 'city', width: 18 },
    { key: 'service', width: 28 },
    { key: 'date', width: 14 },
    { key: 'time', width: 16 },
    { key: 'required', width: 14 },
    { key: 'active', width: 16 },
    { key: 'confirmed', width: 14 },
    { key: 'status', width: 24 },
    { key: 'workers', width: 46 },
    { key: 'requestedBy', width: 26 },
    { key: 'notes', width: 34 }
  ];
  applyTitle(sheet, `Programación — ${clientName}`, `Fecha de servicio: ${selectedDate}`, 12);
  sheet.addRow(['Operación / punto', 'Ciudad', 'Servicio', 'Fecha', 'Horario', 'Aux. requeridos', 'Asignados activos', 'Confirmados', 'Estado', 'Auxiliares programados', 'Solicitante', 'Observaciones']);
  styleHeader(sheet.getRow(3));

  requests.forEach((request, index) => {
    const row = sheet.addRow({
      operation: request.operationPointName || 'Sin operación',
      city: request.cityName || '-',
      service: request.serviceName || request.service?.name || 'Sin servicio',
      date: formatDate(request.serviceDate),
      time: buildHorario(request),
      required: request.requiredWorkers || 0,
      active: activeAssignments(request).length,
      confirmed: confirmedAssignments(request).length,
      status: statusLabel(request.status),
      workers: assignedWorkerNames(request),
      requestedBy: [request.requestedByName, request.requestedByPhone].filter(Boolean).join(' · ') || '-',
      notes: request.notes || '-'
    });
    styleDataRow(row, index);
    styleStatusCell(row.getCell('status'), request.status);
  });

  sheet.views = [{ state: 'frozen', ySplit: 3 }];
  sheet.autoFilter = { from: 'A3', to: 'L3' };
}

async function buildScheduleWorkbook(prisma, selectedDate) {
  const requests = await loadScheduleRequests(prisma, selectedDate);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'LoginPro Operaciones';
  workbook.created = new Date();
  workbook.modified = new Date();

  const requestsByClient = groupByClient(requests);
  addSummarySheet(workbook, selectedDate, requestsByClient, requests);
  requestsByClient.forEach(([clientName, clientRequests], index) => addClientSheet(workbook, clientName, selectedDate, clientRequests, index + 1));

  if (!requests.length) {
    const sheet = workbook.addWorksheet('Sin programación');
    applyTitle(sheet, 'Sin programación registrada', `Fecha de servicio: ${selectedDate}`, 3);
    sheet.addRow(['No hay solicitudes de servicio programadas para esta fecha.']);
    sheet.mergeCells(3, 1, 3, 3);
  }

  return workbook;
}

async function renderOperationsDashboard(req, res, prisma) {
  const selectedDate = normalizeDateParam(req.query.fecha || req.query.date);
  const metrics = await buildOperationsDashboardMetrics(prisma, selectedDate);
  return res.render('operacionesDashboard', { pageTitle: 'Operaciones / Despacho', subtitle: 'Gestión operativa de solicitudes, asignaciones, novedades y reemplazos.', activeSection: 'dashboard', selectedDate, metrics, role: req.session?.userRole || req.userRole, canAccessDispatch: Boolean(req.session?.canAccessDispatch || req.canAccessDispatch) });
}

export function dispatchDashboardMetricsRouter(prisma) {
  const router = express.Router();
  router.get('/', requireOps, async (req, res) => renderOperationsDashboard(req, res, prisma));
  router.get('/abrir', requireOps, async (req, res) => renderOperationsDashboard(req, res, prisma));
  router.get('/programacion.xlsx', requireOps, async (req, res) => {
    const selectedDate = normalizeDateParam(req.query.fecha || req.query.date);
    const workbook = await buildScheduleWorkbook(prisma, selectedDate);
    const filename = `programacion-despacho-${selectedDate}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  });
  return router;
}
