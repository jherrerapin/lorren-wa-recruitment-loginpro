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

function assignmentStatusLabel(value) {
  return ({
    ASSIGNED: 'Asignado',
    CONFIRMATION_PENDING: 'Pendiente confirmación',
    CONFIRMED: 'Confirmado',
    NO_CONFIRMO: 'No confirmó',
    CANCELLED: 'Cancelado'
  }[value] || value || '-');
}

function formatDate(value) {
  if (!value) return '-';
  return new Date(value).toISOString().slice(0, 10);
}

function formatDateTime(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
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

function workerDocumentType(worker) {
  return normalizeString(worker?.documentType) || '-';
}

function workerDocumentNumber(worker) {
  return normalizeString(worker?.documentNumber) || 'Sin documento registrado';
}

function workerDocumentLabel(worker) {
  const documentType = normalizeString(worker?.documentType);
  const documentNumber = normalizeString(worker?.documentNumber);
  if (documentType && documentNumber) return `${documentType} ${documentNumber}`;
  if (documentNumber) return documentNumber;
  return 'Sin documento registrado';
}

function assignedWorkersSummaryForRequests(requests) {
  const rows = [];
  for (const request of requests) {
    for (const assignment of activeAssignments(request)) {
      const worker = assignment.worker || {};
      const name = normalizeString(worker.fullName) || 'Auxiliar';
      rows.push(`${name} · ${workerDocumentLabel(worker)}`);
    }
  }
  return rows.length ? rows.join('\n') : 'Sin auxiliares asignados';
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
  row.height = 28;
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

function styleAssignmentStatusCell(cell, status) {
  const colors = {
    CONFIRMED: { fg: 'FFDCFCE7', font: 'FF166534' },
    CONFIRMATION_PENDING: { fg: 'FFDBEAFE', font: 'FF1D4ED8' },
    ASSIGNED: { fg: 'FFFEF3C7', font: 'FF92400E' }
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
    { key: 'pending', width: 14 },
    { key: 'workers', width: 58 }
  ];
  applyTitle(sheet, 'Programación operativa por cliente', `Fecha de servicio: ${selectedDate}`, 7);
  sheet.addRow(['Cliente', 'Solicitudes', 'Aux. requeridos', 'Asignados activos', 'Confirmados', 'Pendientes', 'Auxiliares asignados']);
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
      workers: assignedWorkersSummaryForRequests(clientRequests)
    });
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

function addProgrammingRows(sheet, requests, includeClientColumn = false) {
  let rowIndex = 0;
  for (const request of requests) {
    const assignments = activeAssignments(request);
    const rows = assignments.length ? assignments : [null];
    rows.forEach((assignment) => {
      const worker = assignment?.worker || {};
      const rowValues = {
        client: request.clientName || 'Sin cliente',
        operation: request.operationPointName || 'Sin operación',
        city: request.cityName || '-',
        address: request.address || '-',
        service: request.serviceName || request.service?.name || 'Sin servicio',
        date: formatDate(request.serviceDate),
        startTime: request.startTime || '-',
        endTime: request.endTime || '-',
        required: request.requiredWorkers || 0,
        requestStatus: statusLabel(request.status),
        workerName: normalizeString(worker.fullName) || 'Sin auxiliar asignado',
        documentType: assignment ? workerDocumentType(worker) : '-',
        documentNumber: assignment ? workerDocumentNumber(worker) : '-',
        workerPhone: assignment ? (normalizeString(worker.phone) || '-') : '-',
        assignmentStatus: assignment ? assignmentStatusLabel(assignment.status) : 'Sin asignación',
        assignedBy: assignment ? (assignment.createdByUsername || 'Sin usuario') : '-',
        assignmentCreatedAt: assignment ? formatDateTime(assignment.createdAt) : '-',
        requestedBy: request.requestedByName || '-',
        requestedPhone: request.requestedByPhone || '-',
        requestedEmail: request.requestedByEmail || '-',
        notes: request.notes || '-'
      };
      const row = sheet.addRow(includeClientColumn ? rowValues : { ...rowValues, client: undefined });
      styleDataRow(row, rowIndex);
      styleStatusCell(row.getCell('requestStatus'), request.status);
      styleAssignmentStatusCell(row.getCell('assignmentStatus'), assignment?.status);
      rowIndex += 1;
    });
  }
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
    { key: 'date', width: 13 },
    { key: 'startTime', width: 12 },
    { key: 'endTime', width: 12 },
    { key: 'required', width: 14 },
    { key: 'requestStatus', width: 24 },
    { key: 'workerName', width: 30 },
    { key: 'documentType', width: 12 },
    { key: 'documentNumber', width: 22 },
    { key: 'workerPhone', width: 18 },
    { key: 'assignmentStatus', width: 24 },
    { key: 'assignedBy', width: 22 },
    { key: 'assignmentCreatedAt', width: 22 },
    { key: 'requestedBy', width: 24 },
    { key: 'requestedPhone', width: 18 },
    { key: 'requestedEmail', width: 28 },
    { key: 'notes', width: 34 }
  ];
  applyTitle(sheet, 'Programación completa de auxiliares', `Fecha de servicio: ${selectedDate}`, 21);
  sheet.addRow(['Cliente', 'Operación / punto', 'Ciudad', 'Dirección', 'Servicio', 'Fecha', 'Hora inicio', 'Hora fin', 'Aux. requeridos', 'Estado solicitud', 'Auxiliar asignado', 'Tipo doc.', 'Número documento', 'Teléfono auxiliar', 'Estado asignación', 'Asignado por', 'Fecha/hora asignación', 'Solicitante', 'Tel. solicitante', 'Correo solicitante', 'Observaciones']);
  styleHeader(sheet.getRow(3));
  addProgrammingRows(sheet, requests, true);
  setTextColumns(sheet, ['documentNumber', 'workerPhone', 'requestedPhone']);
  sheet.views = [{ state: 'frozen', ySplit: 3 }];
  sheet.autoFilter = { from: 'A3', to: 'U3' };
}

function addClientSheet(workbook, clientName, selectedDate, requests, sheetIndex) {
  const sheet = workbook.addWorksheet(cleanSheetName(clientName, `Cliente ${sheetIndex}`));
  sheet.columns = [
    { key: 'operation', width: 26 },
    { key: 'city', width: 16 },
    { key: 'address', width: 30 },
    { key: 'service', width: 26 },
    { key: 'date', width: 13 },
    { key: 'startTime', width: 12 },
    { key: 'endTime', width: 12 },
    { key: 'required', width: 14 },
    { key: 'requestStatus', width: 24 },
    { key: 'workerName', width: 30 },
    { key: 'documentType', width: 12 },
    { key: 'documentNumber', width: 22 },
    { key: 'workerPhone', width: 18 },
    { key: 'assignmentStatus', width: 24 },
    { key: 'assignedBy', width: 22 },
    { key: 'assignmentCreatedAt', width: 22 },
    { key: 'requestedBy', width: 24 },
    { key: 'requestedPhone', width: 18 },
    { key: 'requestedEmail', width: 28 },
    { key: 'notes', width: 34 }
  ];
  applyTitle(sheet, `Programación — ${clientName}`, `Fecha de servicio: ${selectedDate}`, 20);
  sheet.addRow(['Operación / punto', 'Ciudad', 'Dirección', 'Servicio', 'Fecha', 'Hora inicio', 'Hora fin', 'Aux. requeridos', 'Estado solicitud', 'Auxiliar asignado', 'Tipo doc.', 'Número documento', 'Teléfono auxiliar', 'Estado asignación', 'Asignado por', 'Fecha/hora asignación', 'Solicitante', 'Tel. solicitante', 'Correo solicitante', 'Observaciones']);
  styleHeader(sheet.getRow(3));
  addProgrammingRows(sheet, requests, false);
  setTextColumns(sheet, ['documentNumber', 'workerPhone', 'requestedPhone']);
  sheet.views = [{ state: 'frozen', ySplit: 3 }];
  sheet.autoFilter = { from: 'A3', to: 'T3' };
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
