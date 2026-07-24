import express from 'express';
import ExcelJS from 'exceljs';
import {
  buildDispatchServiceDateWhere,
  dispatchServiceDateKey,
  filterDispatchServiceRequestsByDate,
  normalizeDispatchDateParam
} from '../services/dispatchDate.js';
import { confirmedOperationalAssignments, deriveDispatchRequestOperationalState, operationalAssignments } from '../services/dispatchOperationalCoverage.js';
import { resolveAttendanceFeatureAccess } from '../services/attendanceFeatureAccess.js';

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

function selectedDateFromQuery(query = {}) {
  return normalizeDispatchDateParam(query.fecha || query.date);
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
  return base.replace(/[\\/*?:[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || fallback;
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

function serviceRequestStartAt(request) {
  const date = dispatchServiceDateKey(request?.serviceDate);
  const startTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(request?.startTime || '')) ? request.startTime : '00:00';
  const start = new Date(`${date}T${startTime}:00-05:00`);
  return Number.isNaN(start.getTime()) ? null : start;
}

function isServiceRequestEditLocked(request, now = new Date()) {
  const start = serviceRequestStartAt(request);
  if (!start) return false;
  return now.getTime() > start.getTime() + EDIT_GRACE_PERIOD_MS;
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

async function loadServiceRequestsForDate(prisma, selectedDate) {
  const broadWhere = buildDispatchServiceDateWhere(selectedDate);
  const requests = await prisma.dispatchServiceRequest.findMany({
    where: broadWhere,
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

  return filterDispatchServiceRequestsByDate(requests, selectedDate).map((request) => ({
    ...request,
    status: deriveDispatchRequestOperationalState(request).status
  }));
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

function renderHome(res, req, selectedDate, requests, attendanceAccess) {
  const metrics = buildOperationsDashboardMetrics(requests);
  return res.render('operacionesDashboard', {
    role: req.session?.userRole || req.userRole,
    pageTitle: 'Operaciones / Despacho',
    subtitle: 'Gestión operativa de solicitudes, asignaciones, novedades y reemplazos.',
    activeSection: 'dashboard',
    selectedDate,
    metrics,
    canAccessDispatch: Boolean(req.session?.canAccessDispatch || req.canAccessDispatch),
    canAccessAttendanceFeature: Boolean(attendanceAccess?.allowed)
  });
}

function renderSummary(res, req, selectedDate, type, requests) {
  const metrics = buildOperationsDashboardMetrics(requests);
  const filteredRequests = filterRequestsBySummaryType(requests, type);
  const meta = summaryTypeMeta(type);
  return res.render('operacionesSolicitudesResumen', {
    role: req.session?.userRole || req.userRole,
    pageTitle: meta.title,
    subtitle: meta.description,
    selectedDate,
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
    isServiceRequestEditLocked,
    canAccessDispatch: Boolean(req.session?.canAccessDispatch || req.canAccessDispatch)
  });
}

async function exportRequestsToExcel(res, selectedDate, serviceRequests) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Lórren Dispatch';
  workbook.created = new Date();

  const summarySheet = workbook.addWorksheet('Resumen');
  const summaryColumns = [
    { header: 'Cliente', key: 'client', width: 28 },
    { header: 'Operación', key: 'operation', width: 28 },
    { header: 'Servicio', key: 'service', width: 24 },
    { header: 'Horario', key: 'horario', width: 18 },
    { header: 'Requeridos', key: 'required', width: 13 },
    { header: 'Asignados', key: 'assigned', width: 13 },
    { header: 'Confirmados', key: 'confirmed', width: 13 },
    { header: 'Estado', key: 'status', width: 26 },
    { header: 'Novedades', key: 'incidents', width: 12 }
  ];
  applyTitle(summarySheet, 'Reporte de Operaciones', `Fecha: ${selectedDate}`, summaryColumns.length);
  summarySheet.columns = summaryColumns;
  const summaryHeaderRow = summarySheet.getRow(3);
  summaryHeaderRow.values = summaryColumns.map((column) => column.header);
  styleHeader(summaryHeaderRow);

  serviceRequests.forEach((request, index) => {
    const active = activeAssignments(request);
    const confirmed = confirmedAssignments(request);
    const row = summarySheet.addRow({
      client: request.clientName || '-',
      operation: request.operationPointName || '-',
      service: request.serviceName || request.service?.name || '-',
      horario: buildHorario(request),
      required: request.requiredWorkers || 0,
      assigned: active.length,
      confirmed: confirmed.length,
      status: statusLabel(request.status),
      incidents: (request.incidents || []).length
    });
    styleDataRow(row, index);
    styleStatusCell(row.getCell('status'), request.status);
    row.height = 22;
  });

  const groupedByClient = groupByClient(serviceRequests);
  for (const [clientName, clientRequests] of groupedByClient) {
    const sheetName = cleanSheetName(clientName, 'Cliente');
    const clientSheet = workbook.addWorksheet(sheetName);
    const clientColumns = [
      { header: 'Operación', key: 'operation', width: 28 },
      { header: 'Servicio', key: 'service', width: 24 },
      { header: 'Horario', key: 'horario', width: 18 },
      { header: 'Auxiliares asignados', key: 'workers', width: 52 },
      { header: 'Cobertura', key: 'coverage', width: 28 },
      { header: 'Estado', key: 'status', width: 26 }
    ];
    applyTitle(clientSheet, clientName, `Fecha: ${selectedDate}`, clientColumns.length);
    clientSheet.columns = clientColumns;
    const headerRow = clientSheet.getRow(3);
    headerRow.values = clientColumns.map((column) => column.header);
    styleHeader(headerRow);

    clientRequests.forEach((request, index) => {
      const row = clientSheet.addRow({
        operation: request.operationPointName || '-',
        service: request.serviceName || request.service?.name || '-',
        horario: buildHorario(request),
        workers: buildAssignedWorkersCell(request),
        coverage: buildCoverageText(request),
        status: statusLabel(request.status)
      });
      styleDataRow(row, index);
      styleStatusCell(row.getCell('status'), request.status);
      row.height = Math.min(260, Math.max(42, 30 + Math.max(1, activeAssignments(request).length) * 48));
    });
  }

  const safeDate = selectedDate.replace(/[^0-9-]/g, '');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="programacion-operativa-${safeDate}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
}

export function dispatchDashboardMetricsRouter(prisma) {
  const router = express.Router();

  router.use(requireOps);

  router.get('/', async (req, res) => {
    try {
      const selectedDate = selectedDateFromQuery(req.query);
      const [requests, attendanceAccess] = await Promise.all([
        loadServiceRequestsForDate(prisma, selectedDate),
        loadAttendanceAccessForDashboard(prisma, req)
      ]);
      return renderHome(res, req, selectedDate, requests, attendanceAccess);
    } catch (err) {
      console.error('[DispatchOps] Error cargando inicio:', err);
      return res.status(500).send('Error cargando el panel de operaciones');
    }
  });

  router.get('/dispatch/operations', async (req, res) => {
    try {
      const selectedDate = selectedDateFromQuery(req.query);
      const [requests, attendanceAccess] = await Promise.all([
        loadServiceRequestsForDate(prisma, selectedDate),
        loadAttendanceAccessForDashboard(prisma, req)
      ]);
      return renderHome(res, req, selectedDate, requests, attendanceAccess);
    } catch (err) {
      console.error('[DispatchOps] Error cargando dashboard:', err);
      return res.status(500).send('Error cargando el dashboard de operaciones');
    }
  });

  async function handleSummary(req, res) {
    try {
      const selectedDate = selectedDateFromQuery(req.query);
      const type = normalizeSummaryType(req.query.type || req.query.tipo);
      const requests = await loadServiceRequestsForDate(prisma, selectedDate);
      return renderSummary(res, req, selectedDate, type, requests);
    } catch (err) {
      console.error('[DispatchOps] Error cargando resumen:', err);
      return res.status(500).send('Error cargando el resumen de operaciones');
    }
  }

  router.get('/dispatch/operations/summary', handleSummary);
  router.get('/solicitudes/resumen', handleSummary);

  async function handleExport(req, res) {
    try {
      const selectedDate = selectedDateFromQuery(req.query);
      const requests = await loadServiceRequestsForDate(prisma, selectedDate);
      return exportRequestsToExcel(res, selectedDate, requests);
    } catch (err) {
      console.error('[DispatchOps] Error exportando:', err);
      return res.status(500).send('Error generando el reporte de operaciones');
    }
  }

  router.get('/dispatch/operations/export', handleExport);
  router.get('/programacion.xlsx', handleExport);

  return router;
}