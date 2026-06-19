import express from 'express';
import ExcelJS from 'exceljs';

const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const CONFIRMED_ASSIGNMENT_STATUS = 'CONFIRMED';
const PENDING_REQUEST_STATUSES = ['PENDING_ASSIGNMENT', 'ASSIGNMENT_PARTIAL', 'PENDING_CONFIRMATION'];
const OPEN_INCIDENT_STATUSES = ['OPEN', 'IN_PROGRESS'];
const EDIT_GRACE_PERIOD_MS = 2 * 60 * 60 * 1000;

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

function serviceRequestDateText(request) {
  if (!request?.serviceDate) return todayIsoDate();
  return new Date(request.serviceDate).toISOString().slice(0, 10);
}

function serviceRequestStartAt(request) {
  const date = serviceRequestDateText(request);
  const startTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(request?.startTime || '')) ? request.startTime : '00:00';
  const start = new Date(`${date}T${startTime}:00-05:00`);
  return Number.isNaN(start.getTime()) ? null : start;
}

function isServiceRequestEditLocked(request, now = new Date()) {
  const start = serviceRequestStartAt(request);
  if (!start) return false;
  return now.getTime() > start.getTime() + EDIT_GRACE_PERIOD_MS;
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

function assignmentStatusLabel(value) {
  return ({
    ASSIGNED: 'Asignado',
    CONFIRMATION_PENDING: 'Pendiente confirmación',
    CONFIRMED: 'Confirmado',
    NO_CONFIRMO: 'No confirmó',
    CANCELLED: 'Cancelado'
  }[value] || value || '-');
}

function cleanSheetName(value, fallback) {
  const base = normalizeString(value) || fallback;
  return base.replace(/[\\/*?:[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || fallback;
}

function activeAssignments(request) {
  return (request.assignments || []).filter((assignment) => ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status));
}

function confirmedAssignments(request) {
  return (request.assignments || []).filter((assignment) => assignment.status === CONFIRMED_ASSIGNMENT_STATUS);
}

function workerDocumentLabel(worker) {
  const documentType = normalizeString(worker?.documentType);
  const documentNumber = normalizeString(worker?.documentNumber);
  if (documentType && documentNumber) return `${documentType} ${documentNumber}`;
  if (documentNumber) return documentNumber;
  return 'Sin documento registrado';
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

function buildHorario(request) {
  if (request.endTime) return `${request.startTime || '-'} - ${request.endTime}`;
  return request.startTime || '-';
}

function buildWorkerLine(assignment, index) {
  const worker = assignment?.worker || {};
  const name = normalizeString(worker.fullName) || 'Auxiliar';
  const document = workerDocumentLabel(worker);
  const status = assignmentStatusLabel(assignment?.status);
  return `${index + 1}. Auxiliar: ${name}\n   Documento: ${document}\n   Estado: ${status}`;
}

function buildAssignedWorkersCell(request) {
  const assignments = activeAssignments(request);
  if (!assignments.length) return 'Sin auxiliares asignados';
  return assignments.map((assignment, index) => buildWorkerLine(assignment, index)).join('\n\n');
}

function buildRequestWorkerBlock(request, index) {
  const operation = request.operationPointName || 'Sin operación';
  const service = request.serviceName || request.service?.name || 'Sin servicio';
  return `Bloque ${index + 1}\nHorario: ${buildHorario(request)}\nOperación: ${operation}\nServicio: ${service}\n${buildAssignedWorkersCell(request)}`;
}

function buildClientWorkersSummary(requests) {
  if (!requests.some((request) => activeAssignments(request).length)) return 'Sin auxiliares asignados';
  return requests.map((request, index) => buildRequestWorkerBlock(request, index)).join('\n\n');
}

function buildCoverageText(request) {
  const active = activeAssignments(request).length;
  const confirmed = confirmedAssignments(request).length;
  const required = Number(request.requiredWorkers || 0);
  return `${active}/${required} asignados · ${confirmed}/${required} confirmados`;
}

function calculateRowHeight(request) {
  const assignmentCount = Math.max(1, activeAssignments(request).length);
  return Math.min(260, Math.max(42, 30 + assignmentCount * 48));
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
  row.height = 30;
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

  const [totalRequests, pendingRequests, completedRequests, openIncidents] = await Promise.all([
    prisma.dispatchServiceRequest.count({ where: whereForDate }),
    prisma.dispatchServiceRequest.count({ where: { ...whereForDate, status: { in: PENDING_REQUEST_STATUSES } } }),
    prisma.dispatchServiceRequest.count({ where: { ...whereForDate, status: 'ASSIGNMENT_COMPLETE' } }),
    prisma.dispatchIncident.count({ where: { status: { in: OPEN_INCIDENT_STATUSES }, serviceRequest: whereForDate } })
  ]);
  return { totalRequests, pendingRequests, completedRequests, openIncidents };
}

function normalizeSummaryType(value) {
  const type = normalizeString(value) || 'total';
  return ['total', 'pending', 'complete', 'incidents'].includes(type) ? type : 'total';
}

function summaryTypeMeta(type) {
  return ({
    total: {
      title: 'Solicitudes del día',
      description: 'Todas las solicitudes programadas para la fecha seleccionada.'
    },
    pending: {
      title: 'Solicitudes pendientes',
      description: 'Solicitudes que aún requieren asignación, cobertura parcial o confirmación.'
    },
    complete: {
      title: 'Solicitudes con asignación completa',
      description: 'Solicitudes cuya cobertura ya está confirmada para la fecha seleccionada.'
    },
    incidents: {
      title: 'Solicitudes con novedades abiertas',
      description: 'Solicitudes de la fecha seleccionada que tienen novedades abiertas o en proceso.'
    }
  }[type]);
}

function buildSummaryWhere(selectedDate, type) {
  const { start, end } = buildUtcDayRange(selectedDate);
  const where = { serviceDate: { gte: start, lt: end } };
  if (type === 'pending') where.status = { in: PENDING_REQUEST_STATUSES };
  if (type === 'complete') where.status = 'ASSIGNMENT_COMPLETE';
  if (type === 'incidents') where.incidents = { some: { status: { in: OPEN_INCIDENT_STATUSES } } };
  return where;
}

async function loadSummaryServiceRequests(prisma, selectedDate, type) {
  return prisma.dispatchServiceRequest.findMany({
    where: buildSummaryWhere(selectedDate, type),
    include: {
      service: true,
      assignments: {
        include: { worker: true },
        orderBy: [{ status: 'asc' }, { createdAt: 'asc' }]
      },
      incidents: {
        where: { status: { in: OPEN_INCIDENT_STATUSES } },
        include: { worker: true, assignment: { include: { worker: true } } },
        orderBy: { createdAt: 'desc' }
      }
    },
    orderBy: [{ clientName: 'asc' }, { operationPointName: 'asc' }, { startTime: 'asc' }, { createdAt: 'asc' }]
  });
}

async function guardEditableServiceRequest(prisma, req, res, next) {
  const serviceRequest = await prisma.dispatchServiceRequest.findUnique({
    where: { id: req.params.id },
    select: { id: true, serviceDate: true, startTime: true }
  });
  if (!serviceRequest || !isServiceRequestEditLocked(serviceRequest)) return next();
  const selectedDate = serviceRequestDateText(serviceRequest);
  const message = 'Esta solicitud ya superó las 2 horas posteriores a la hora del servicio. Solo puede consultarse.';
  if (req.method === 'GET') {
    return res.redirect(`/admin/operaciones/solicitudes/resumen?fecha=${encodeURIComponent(selectedDate)}&tipo=total&message=${encodeURIComponent(message)}`);
  }
  return res.status(403).send(message);
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
    { key: 'pending', width: 14 },
    { key: 'workers', width: 82 }
  ];
  applyTitle(sheet, 'Programación operativa por cliente', `Fecha de servicio: ${selectedDate}`, 7);
  sheet.addRow(['Cliente', 'Solicitudes', 'Aux. requeridos', 'Asignados activos', 'Confirmados', 'Pendientes', 'Detalle de auxiliares por horario']);
  styleHeader(sheet.getRow(3));

  requestsByClient.forEach(([clientName, clientRequests], index) => {
    const required = clientRequests.reduce((sum, request) => sum + Number(request.requiredWorkers || 0), 0);
    const active = clientRequests.reduce((sum, request) => sum + activeAssignments(request).length, 0);
    const confirmed = clientRequests.reduce((sum, request) => sum + confirmedAssignments(request).length, 0);
    const row = sheet.addRow({
      client: clientName,
      requests: clientRequests.length,
      required,
      active,
      confirmed,
      pending: Math.max(0, required - confirmed),
      workers: buildClientWorkersSummary(clientRequests)
    });
    styleDataRow(row, index);
    row.height = Math.min(260, Math.max(42, 28 + active * 42 + clientRequests.length * 26));
  });

  const totalRequired = requests.reduce((sum, request) => sum + Number(request.requiredWorkers || 0), 0);
  const totalConfirmed = requests.reduce((sum, request) => sum + confirmedAssignments(request).length, 0);
  const totals = sheet.addRow({
    client: 'TOTAL GENERAL',
    requests: requests.length,
    required: totalRequired,
    active: requests.reduce((sum, request) => sum + activeAssignments(request).length, 0),
    confirmed: totalConfirmed,
    pending: Math.max(0, totalRequired - totalConfirmed),
    workers: ''
  });
  totals.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E2D3D' } };
    cell.border = commonBorder('FFCBD5E1');
  });
  sheet.views = [{ state: 'frozen', ySplit: 3 }];
  sheet.autoFilter = { from: 'A3', to: 'G3' };
}

function buildProgrammingRow(request, includeClientColumn = false) {
  const base = {
    client: request.clientName || 'Sin cliente',
    operation: request.operationPointName || 'Sin operación',
    city: request.cityName || '-',
    address: request.address || '-',
    service: request.serviceName || request.service?.name || 'Sin servicio',
    time: buildHorario(request),
    required: request.requiredWorkers || 0,
    coverage: buildCoverageText(request),
    requestStatus: statusLabel(request.status),
    assignedWorkers: buildAssignedWorkersCell(request),
    requestedBy: request.requestedByName || '-',
    requestedPhone: request.requestedByPhone || '-',
    requestedEmail: request.requestedByEmail || '-',
    notes: request.notes || '-'
  };
  return includeClientColumn ? base : { ...base, client: undefined };
}

function addProgrammingRows(sheet, requests, includeClientColumn = false) {
  requests.forEach((request, index) => {
    const row = sheet.addRow(buildProgrammingRow(request, includeClientColumn));
    styleDataRow(row, index);
    styleStatusCell(row.getCell('requestStatus'), request.status);
    row.height = calculateRowHeight(request);
  });
}

function setTextColumns(sheet, columnKeys) {
  columnKeys.forEach((key) => {
    const column = sheet.getColumn(key);
    column.numFmt = '@';
  });
}

function addConsolidatedSheet(workbook, selectedDate, requests) {
  const sheet = workbook.addWorksheet('Programación completa');
  sheet.columns = [
    { key: 'client', width: 28 },
    { key: 'operation', width: 26 },
    { key: 'city', width: 16 },
    { key: 'address', width: 30 },
    { key: 'service', width: 26 },
    { key: 'time', width: 16 },
    { key: 'required', width: 14 },
    { key: 'coverage', width: 22 },
    { key: 'requestStatus', width: 24 },
    { key: 'assignedWorkers', width: 86 },
    { key: 'requestedBy', width: 24 },
    { key: 'requestedPhone', width: 18 },
    { key: 'requestedEmail', width: 28 },
    { key: 'notes', width: 34 }
  ];
  applyTitle(sheet, 'Programación completa agrupada por solicitud', `Fecha de servicio: ${selectedDate}`, 14);
  sheet.addRow(['Cliente', 'Operación / punto', 'Ciudad', 'Dirección', 'Servicio', 'Horario', 'Aux. requeridos', 'Cobertura', 'Estado solicitud', 'Auxiliares asignados / documentos', 'Solicitante', 'Tel. solicitante', 'Correo solicitante', 'Observaciones']);
  styleHeader(sheet.getRow(3));
  addProgrammingRows(sheet, requests, true);
  setTextColumns(sheet, ['assignedWorkers', 'requestedPhone']);
  sheet.views = [{ state: 'frozen', ySplit: 3 }];
  sheet.autoFilter = { from: 'A3', to: 'N3' };
}

function addClientSheet(workbook, clientName, selectedDate, requests, sheetIndex) {
  const sheet = workbook.addWorksheet(cleanSheetName(clientName, `Cliente ${sheetIndex}`));
  sheet.columns = [
    { key: 'operation', width: 26 },
    { key: 'city', width: 16 },
    { key: 'address', width: 30 },
    { key: 'service', width: 26 },
    { key: 'time', width: 16 },
    { key: 'required', width: 14 },
    { key: 'coverage', width: 22 },
    { key: 'requestStatus', width: 24 },
    { key: 'assignedWorkers', width: 86 },
    { key: 'requestedBy', width: 24 },
    { key: 'requestedPhone', width: 18 },
    { key: 'requestedEmail', width: 28 },
    { key: 'notes', width: 34 }
  ];
  applyTitle(sheet, `Programación — ${clientName}`, `Fecha de servicio: ${selectedDate}`, 13);
  sheet.addRow(['Operación / punto', 'Ciudad', 'Dirección', 'Servicio', 'Horario', 'Aux. requeridos', 'Cobertura', 'Estado solicitud', 'Auxiliares asignados / documentos', 'Solicitante', 'Tel. solicitante', 'Correo solicitante', 'Observaciones']);
  styleHeader(sheet.getRow(3));
  addProgrammingRows(sheet, requests, false);
  setTextColumns(sheet, ['assignedWorkers', 'requestedPhone']);
  sheet.views = [{ state: 'frozen', ySplit: 3 }];
  sheet.autoFilter = { from: 'A3', to: 'M3' };
}

async function buildScheduleWorkbook(prisma, selectedDate) {
  const requests = await loadScheduleRequests(prisma, selectedDate);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'LoginPro Operaciones';
  workbook.created = new Date();
  workbook.modified = new Date();

  const requestsByClient = groupByClient(requests);
  addSummarySheet(workbook, selectedDate, requestsByClient, requests);
  addConsolidatedSheet(workbook, selectedDate, requests);
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

async function renderServiceRequestsSummary(req, res, prisma) {
  const selectedDate = normalizeDateParam(req.query.fecha || req.query.date);
  const type = normalizeSummaryType(req.query.tipo || req.query.type);
  const meta = summaryTypeMeta(type);
  const [requests, metrics] = await Promise.all([
    loadSummaryServiceRequests(prisma, selectedDate, type),
    buildOperationsDashboardMetrics(prisma, selectedDate)
  ]);
  return res.render('operacionesSolicitudesResumen', {
    pageTitle: meta.title,
    subtitle: meta.description,
    selectedDate,
    type,
    typeLabel: meta.title,
    requests,
    metrics,
    message: normalizeString(req.query.message),
    isServiceRequestEditLocked,
    statusLabel,
    assignmentStatusLabel,
    activeAssignments,
    confirmedAssignments,
    buildHorario,
    role: req.session?.userRole || req.userRole,
    canAccessDispatch: Boolean(req.session?.canAccessDispatch || req.canAccessDispatch)
  });
}

export function dispatchDashboardMetricsRouter(prisma) {
  const router = express.Router();
  router.get('/', requireOps, async (req, res) => renderOperationsDashboard(req, res, prisma));
  router.get('/abrir', requireOps, async (req, res) => renderOperationsDashboard(req, res, prisma));
  router.get('/solicitudes/resumen', requireOps, async (req, res) => renderServiceRequestsSummary(req, res, prisma));
  router.get('/asignaciones/solicitudes/:id/editar', requireOps, async (req, res, next) => guardEditableServiceRequest(prisma, req, res, next));
  router.post('/asignaciones/solicitudes/:id/editar', requireOps, async (req, res, next) => guardEditableServiceRequest(prisma, req, res, next));
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
