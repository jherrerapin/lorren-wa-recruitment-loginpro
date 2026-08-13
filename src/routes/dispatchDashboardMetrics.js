import express from 'express';
import ExcelJS from 'exceljs';
import {
  buildDispatchServiceDateSearchRange,
  buildDispatchServiceDateWhere,
  dispatchServiceDateKey,
  filterDispatchServiceRequestsByDate,
  normalizeDispatchDateParam
} from '../services/dispatchDate.js';
import { confirmedOperationalAssignments, deriveDispatchRequestOperationalState, operationalAssignments } from '../services/dispatchOperationalCoverage.js';
import { resolveAttendanceFeatureAccess } from '../services/attendanceFeatureAccess.js';
import {
  DISPATCH_SERVICE_REQUEST_POLICY_INCLUDE,
  resolveDispatchServiceRequestPolicy
} from '../services/dispatchServiceRequestPolicy.js';

const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'CONFIRMATION_PENDING', 'CONFIRMED'];
const CONFIRMED_ASSIGNMENT_STATUS = 'CONFIRMED';
const PENDING_REQUEST_STATUSES = ['PENDING_ASSIGNMENT', 'ASSIGNMENT_PARTIAL', 'PENDING_CONFIRMATION'];
const OPEN_INCIDENT_STATUSES = ['OPEN', 'IN_PROGRESS'];
const DEV_TEST_REQUEST_SOURCE = 'DEV_TEST';

function normalizeString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeDispatchAlertPhoneInput(value) {
  const digits = String(value || '').replace(/\D+/g, '');
  if (!digits) return null;
  const local = digits.startsWith('57') && digits.length === 12 ? digits.slice(2) : digits;
  return /^3\d{9}$/.test(local) ? `57${local}` : null;
}

function dispatchAlertPhoneForInput(value) {
  const digits = String(value || '').replace(/\D+/g, '');
  return digits.startsWith('57') && digits.length === 12 ? digits.slice(2) : digits;
}

async function findCurrentDispatchAppUser(prisma, req) {
  const userId = normalizeString(req.session?.userId || req.userId);
  if (userId) {
    const byId = await prisma.appUser.findUnique({ where: { id: userId } });
    if (byId) return byId;
  }
  const username = normalizeString(req.session?.username || req.username);
  if (!username) return null;
  return prisma.appUser.findUnique({ where: { username } });
}

async function loadCurrentDispatchAlertSettings(prisma, req) {
  const user = await findCurrentDispatchAppUser(prisma, req);
  return {
    available: Boolean(user),
    phone: dispatchAlertPhoneForInput(user?.dispatchAlertPhone),
    reminderEnabled: Boolean(user?.dispatchWindowExpiryReminderEnabled)
  };
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

function selectedDateRangeFromQuery(query = {}) {
  const legacyDate = normalizeDispatchDateParam(query.fecha || query.date);
  let from = normalizeDispatchDateParam(query.fechaDesde || query.from || legacyDate, legacyDate);
  let to = normalizeDispatchDateParam(query.fechaHasta || query.to || legacyDate, legacyDate);
  if (from > to) [from, to] = [to, from];
  return { from, to };
}

function dateRangeLabel(range) {
  return range.from === range.to ? range.from : `${range.from} a ${range.to}`;
}

function activeAssignments(request) {
  return operationalAssignments(request);
}

function confirmedAssignments(request) {
  return confirmedOperationalAssignments(request);
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
  return base.replace(/[\/*?:[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || fallback;
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

function workerDocumentLabel(worker) {
  const documentType = normalizeString(worker?.documentType);
  const documentNumber = normalizeString(worker?.documentNumber);
  if (documentType && documentNumber) return `${documentType} ${documentNumber}`;
  if (documentNumber) return documentNumber;
  return 'Sin documento registrado';
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

function buildCoverageText(request) {
  const active = activeAssignments(request).length;
  const confirmed = confirmedAssignments(request).length;
  const required = Number(request.requiredWorkers || 0);
  return `${active}/${required} asignados · ${confirmed}/${required} confirmados`;
}

function normalizeSummaryType(value) {
  const type = normalizeString(value) || 'total';
  return ['total', 'pending', 'complete', 'incidents'].includes(type) ? type : 'total';
}

function summaryTypeMeta(type) {
  return ({
    total: {
      title: 'Solicitudes del rango',
      description: 'Todas las solicitudes programadas para el rango seleccionado.'
    },
    pending: {
      title: 'Solicitudes pendientes',
      description: 'Solicitudes del rango que aún requieren asignación, cobertura parcial o confirmación.'
    },
    complete: {
      title: 'Solicitudes con asignación completa',
      description: 'Solicitudes del rango cuya cobertura ya está confirmada.'
    },
    incidents: {
      title: 'Solicitudes con novedades abiertas',
      description: 'Solicitudes del rango que tienen novedades abiertas o en proceso.'
    }
  }[type]);
}

function filterRequestsBySummaryType(requests = [], type = 'total') {
  if (type === 'pending') return requests.filter((request) => PENDING_REQUEST_STATUSES.includes(request.status));
  if (type === 'complete') return requests.filter((request) => request.status === 'ASSIGNMENT_COMPLETE');
  if (type === 'incidents') return requests.filter((request) => (request.incidents || []).some((incident) => OPEN_INCIDENT_STATUSES.includes(incident.status)));
  return requests;
}

function buildOperationsDashboardMetrics(requests = []) {
  return {
    totalRequests: requests.length,
    pendingRequests: requests.filter((request) => PENDING_REQUEST_STATUSES.includes(request.status)).length,
    completedRequests: requests.filter((request) => request.status === 'ASSIGNMENT_COMPLETE').length,
    openIncidents: requests.reduce((sum, request) => sum + (request.incidents || []).filter((incident) => OPEN_INCIDENT_STATUSES.includes(incident.status)).length, 0)
  };
}

function excludeDevTestRequests(where = {}) {
  return {
    AND: [where, { source: { not: DEV_TEST_REQUEST_SOURCE } }]
  };
}

function buildDateRangeWhere(range) {
  const start = buildDispatchServiceDateSearchRange(range.from).start;
  const end = buildDispatchServiceDateSearchRange(range.to).end;
  return { serviceDate: { gte: start, lt: end } };
}

function filterRequestsByDateRange(requests = [], range) {
  return requests.filter((request) => {
    const key = dispatchServiceDateKey(request?.serviceDate);
    return Boolean(key && key >= range.from && key <= range.to);
  });
}

async function loadServiceRequestsForRange(prisma, range) {
  const requests = await prisma.dispatchServiceRequest.findMany({
    where: excludeDevTestRequests(buildDateRangeWhere(range)),
    include: {
      service: true,
      ...DISPATCH_SERVICE_REQUEST_POLICY_INCLUDE,
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
    orderBy: [{ serviceDate: 'asc' }, { clientName: 'asc' }, { operationPointName: 'asc' }, { startTime: 'asc' }, { createdAt: 'asc' }]
  });

  return filterRequestsByDateRange(requests, range).map((request) => ({
    ...request,
    status: deriveDispatchRequestOperationalState(request).status
  }));
}

async function loadServiceRequestsForDate(prisma, selectedDate) {
  return loadServiceRequestsForRange(prisma, { from: selectedDate, to: selectedDate });
}

async function loadAttendanceAccessForDashboard(prisma, req) {
  try {
    return await resolveAttendanceFeatureAccess(prisma, {
      userRole: req.session?.userRole || req.userRole,
      username: req.session?.username || req.username
    });
  } catch (error) {
    console.error('[DispatchOps] Error resolviendo acceso a asistencia:', error);
    return { allowed: false, reason: 'access_resolution_failed' };
  }
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
    if (index % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
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

function renderHome(res, req, range, requests, programmingRequests, attendanceAccess, dispatchAlertSettings) {
  const metrics = buildOperationsDashboardMetrics(requests);
  const programmingMetrics = buildOperationsDashboardMetrics(programmingRequests);
  return res.render('operacionesDashboard', {
    role: req.session?.userRole || req.userRole,
    pageTitle: 'Operaciones / Despacho',
    subtitle: 'Gestión operativa de solicitudes, asignaciones, novedades y reemplazos.',
    activeSection: 'dashboard',
    selectedDate: range.to,
    selectedDateFrom: range.from,
    selectedDateTo: range.to,
    metrics,
    programmingMetrics,
    dispatchAlertSettings,
    alertSettingsMessage: normalizeString(req.query.alertSettingsMessage),
    alertSettingsError: normalizeString(req.query.alertSettingsError),
    canAccessDispatch: Boolean(req.session?.canAccessDispatch || req.canAccessDispatch),
    canAccessAttendanceFeature: Boolean(attendanceAccess?.allowed)
  });
}

function renderSummary(res, req, range, type, requests) {
  const metrics = buildOperationsDashboardMetrics(requests);
  const filteredRequests = filterRequestsBySummaryType(requests, type);
  const meta = summaryTypeMeta(type);
  return res.render('operacionesSolicitudesResumen', {
    role: req.session?.userRole || req.userRole,
    pageTitle: meta.title,
    subtitle: `${meta.description} Rango: ${dateRangeLabel(range)}.`,
    selectedDate: range.to,
    selectedDateFrom: range.from,
    selectedDateTo: range.to,
    type,
    typeLabel: meta.title,
    metrics,
    requests: filteredRequests,
    message: normalizeString(req.query.message),
    activeAssignments,
    confirmedAssignments,
    statusLabel,
    assignmentStatusLabel,
    buildHorario,
    buildCoverageText,
    resolveServiceRequestPolicy: resolveDispatchServiceRequestPolicy,
    canAccessDispatch: Boolean(req.session?.canAccessDispatch || req.canAccessDispatch)
  });
}

async function exportRequestsToExcel(res, range, serviceRequests) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Lórren Dispatch';
  workbook.created = new Date();
  const rangeText = dateRangeLabel(range);
  const subtitle = range.from === range.to ? `Fecha de servicio: ${rangeText}` : `Rango de servicio: ${rangeText}`;

  const summarySheet = workbook.addWorksheet('Resumen');
  const summaryColumns = [
    { header: 'Cliente', key: 'client', width: 28 },
    { header: 'Operación', key: 'operation', width: 28 },
    { header: 'Servicio', key: 'service', width: 24 },
    { header: 'Horario', key: 'horario', width: 18 },
    { header: 'Requeridos', key: 'required', width: 13 },
    { header: 'Asignados', key: 'assigned', width: 13 },
    { header: 'Confirmados', key: 'confirmed', width: 13 },
    { header: 'Estado', key: 'status', width: 22 },
    { header: 'Auxiliares asignados', key: 'workers', width: 48 }
  ];
  summarySheet.columns = summaryColumns;
  applyTitle(summarySheet, 'Solicitudes de Operaciones', subtitle, summaryColumns.length);
  const headerRow = summarySheet.addRow(summaryColumns.map((column) => column.header));
  styleHeader(headerRow);

  serviceRequests.forEach((request, index) => {
    const row = summarySheet.addRow({
      client: request.clientName || 'Sin cliente',
      operation: request.operationPointName || request.operationPoint?.name || 'Sin operación',
      service: request.serviceName || request.service?.name || 'Sin servicio',
      horario: buildHorario(request),
      required: request.requiredWorkers || 0,
      assigned: activeAssignments(request).length,
      confirmed: confirmedAssignments(request).length,
      status: statusLabel(request.status),
      workers: buildAssignedWorkersCell(request)
    });
    styleDataRow(row, index);
    styleStatusCell(row.getCell('status'), request.status);
  });

  summarySheet.views = [{ state: 'frozen', ySplit: 3 }];
  summarySheet.autoFilter = { from: 'A3', to: 'I3' };
  summarySheet.getColumn('workers').alignment = { wrapText: true, vertical: 'top' };

  for (const [clientName, requests] of groupByClient(serviceRequests)) {
    const sheet = workbook.addWorksheet(cleanSheetName(clientName, 'Cliente'));
    sheet.columns = summaryColumns;
    applyTitle(sheet, clientName, subtitle, summaryColumns.length);
    const clientHeader = sheet.addRow(summaryColumns.map((column) => column.header));
    styleHeader(clientHeader);
    requests.forEach((request, index) => {
      const row = sheet.addRow({
        client: request.clientName || clientName,
        operation: request.operationPointName || request.operationPoint?.name || 'Sin operación',
        service: request.serviceName || request.service?.name || 'Sin servicio',
        horario: buildHorario(request),
        required: request.requiredWorkers || 0,
        assigned: activeAssignments(request).length,
        confirmed: confirmedAssignments(request).length,
        status: statusLabel(request.status),
        workers: buildAssignedWorkersCell(request)
      });
      styleDataRow(row, index);
      styleStatusCell(row.getCell('status'), request.status);
    });
    sheet.views = [{ state: 'frozen', ySplit: 3 }];
    sheet.autoFilter = { from: 'A3', to: 'I3' };
    sheet.getColumn('workers').alignment = { wrapText: true, vertical: 'top' };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const fileRange = range.from === range.to ? range.from : `${range.from}-a-${range.to}`;
  const fileName = `solicitudes-operaciones-${fileRange}.xlsx`;
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="${fileName}"`);
  return res.send(Buffer.from(buffer));
}

export function dispatchDashboardMetricsRouter(prisma) {
  const router = express.Router();

  router.get('/', requireOps, async (req, res) => {
    const range = selectedDateRangeFromQuery(req.query);
    const rangeRequestsPromise = loadServiceRequestsForRange(prisma, range);
    const programmingRequestsPromise = range.from === range.to
      ? rangeRequestsPromise
      : loadServiceRequestsForDate(prisma, range.to);
    const [requests, programmingRequests, attendanceAccess, dispatchAlertSettings] = await Promise.all([
      rangeRequestsPromise,
      programmingRequestsPromise,
      loadAttendanceAccessForDashboard(prisma, req),
      loadCurrentDispatchAlertSettings(prisma, req)
    ]);
    return renderHome(res, req, range, requests, programmingRequests, attendanceAccess, dispatchAlertSettings);
  });

  router.post('/alertas-whatsapp', requireOps, express.urlencoded({ extended: false }), async (req, res) => {
    const range = selectedDateRangeFromQuery(req.body || {});
    const redirectWith = (key, message) => {
      const params = new URLSearchParams({ fechaDesde: range.from, fechaHasta: range.to, [key]: message });
      return res.redirect(`/admin/operaciones?${params.toString()}`);
    };

    const rawPhone = normalizeString(req.body?.dispatchAlertPhone);
    const dispatchAlertPhone = normalizeDispatchAlertPhoneInput(rawPhone);
    const dispatchWindowExpiryReminderEnabled = req.body?.dispatchWindowExpiryReminderEnabled === 'true';
    if (rawPhone && !dispatchAlertPhone) {
      return redirectWith('alertSettingsError', 'El WhatsApp de alertas debe ser un celular colombiano válido.');
    }
    if (dispatchWindowExpiryReminderEnabled && !dispatchAlertPhone) {
      return redirectWith('alertSettingsError', 'Configura un WhatsApp de alertas antes de activar el recordatorio de ventana.');
    }

    const user = await findCurrentDispatchAppUser(prisma, req);
    if (!user) {
      return redirectWith('alertSettingsError', 'No fue posible identificar tu usuario para guardar esta configuración.');
    }

    await prisma.appUser.update({
      where: { id: user.id },
      data: { dispatchAlertPhone, dispatchWindowExpiryReminderEnabled }
    });
    return redirectWith('alertSettingsMessage', 'Configuración de alertas de despacho guardada.');
  });

  router.get('/resumen', requireOps, async (req, res) => {
    const range = selectedDateRangeFromQuery(req.query);
    const requests = await loadServiceRequestsForRange(prisma, range);
    return renderSummary(res, req, range, normalizeSummaryType(req.query.type), requests);
  });

  router.get('/resumen/exportar', requireOps, async (req, res) => {
    const range = selectedDateRangeFromQuery(req.query);
    const requests = await loadServiceRequestsForRange(prisma, range);
    const type = normalizeSummaryType(req.query.type);
    return exportRequestsToExcel(res, range, filterRequestsBySummaryType(requests, type));
  });

  router.get('/solicitudes/:serviceRequestId', requireOps, async (req, res) => {
    const request = await prisma.dispatchServiceRequest.findUnique({
      where: { id: req.params.serviceRequestId },
      include: {
        service: true,
        ...DISPATCH_SERVICE_REQUEST_POLICY_INCLUDE,
        assignments: {
          include: { worker: true },
          orderBy: [{ status: 'asc' }, { createdAt: 'asc' }]
        },
        incidents: {
          include: { worker: true, assignment: { include: { worker: true } } },
          orderBy: { createdAt: 'desc' }
        }
      }
    });
    if (!request || request.source === DEV_TEST_REQUEST_SOURCE) return res.status(404).send('Solicitud no encontrada');
    const derivedRequest = { ...request, status: deriveDispatchRequestOperationalState(request).status };
    return res.render('operacionesSolicitudDetalle', {
      role: req.session?.userRole || req.userRole,
      request: derivedRequest,
      selectedDate: dispatchServiceDateKey(request.serviceDate),
      activeAssignments,
      confirmedAssignments,
      assignmentStatusLabel,
      statusLabel,
      buildHorario,
      buildCoverageText,
      resolveServiceRequestPolicy: resolveDispatchServiceRequestPolicy,
      message: normalizeString(req.query.message)
    });
  });

  return router;
}
