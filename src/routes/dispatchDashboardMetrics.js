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

/**
 * buildOperationsDashboardMetrics
 *
 * Usa COUNT puro — no trae filas completas a memoria.
 * Es la query del encabezado del dashboard (4 conteos en paralelo).
 */
async function buildOperationsDashboardMetrics(prisma, selectedDate) {
  const { start, end } = buildUtcDayRange(selectedDate);
  const whereForDate = { serviceDate: { gte: start, lt: end } };

  const [totalRequests, pendingRequests, completedRequests, openIncidents] = await Promise.all([
    prisma.dispatchServiceRequest.count({ where: whereForDate }),
    prisma.dispatchServiceRequest.count({ where: { ...whereForDate, status: { in: PENDING_REQUEST_STATUSES } } }),
    prisma.dispatchServiceRequest.count({ where: { ...whereForDate, status: 'ASSIGNMENT_COMPLETE' } }),
    prisma.dispatchIncident.count({ where: { status: { in: OPEN_INCIDENT_STATUSES }, serviceRequest: { is: whereForDate } } })
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

/**
 * loadSummaryServiceRequests
 *
 * Vista detalle (solicitudes/resumen): trae assignments + incidents completos
 * porque la plantilla los necesita para mostrar auxiliares y novedades.
 */
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
  const requestId = req.params.id || req.params.serviceRequestId;
  const serviceRequest = await prisma.dispatchServiceRequest.findUnique({
    where: { id: requestId },
    sele