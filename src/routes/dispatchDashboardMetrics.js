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
    select: { id: true, serviceDate: true, startTime: true, status: true }
  });
  if (!serviceRequest) return res.status(404).send('Solicitud no encontrada');
  req.serviceRequest = serviceRequest;
  return next();
}

export function createDispatchDashboardMetricsRouter(prisma) {
  const router = express.Router();

  router.use(requireOps);

  // Dashboard principal de operaciones
  router.get('/dispatch/operations', async (req, res) => {
    try {
      const selectedDate = normalizeDateParam(req.query.date);
      const metrics = await buildOperationsDashboardMetrics(prisma, selectedDate);
      const { start, end } = buildUtcDayRange(selectedDate);

      const serviceRequests = await prisma.dispatchServiceRequest.findMany({
        where: { serviceDate: { gte: start, lt: end } },
        include: {
          service: true,
          assignments: {
            include: { worker: true },
            orderBy: [{ status: 'asc' }, { createdAt: 'asc' }]
          },
          incidents: {
            where: { status: { in: OPEN_INCIDENT_STATUSES } },
            orderBy: { createdAt: 'desc' }
          }
        },
        orderBy: [{ clientName: 'asc' }, { operationPointName: 'asc' }, { startTime: 'asc' }]
      });

      const groupedByClient = groupByClient(serviceRequests);
      const now = new Date();

      res.render('dispatch/operations-dashboard', {
        selectedDate,
        metrics,
        serviceRequests,
        groupedByClient,
        now,
        isServiceRequestEditLocked,
        activeAssignments,
        confirmedAssignments,
        statusLabel,
        assignmentStatusLabel,
        buildHorario,
        buildCoverageText,
        isOpsUser: isOpsUser(req)
      });
    } catch (err) {
      console.error('[DispatchOps] Error cargando dashboard:', err);
      res.status(500).send('Error cargando el dashboard de operaciones');
    }
  });

  // Vista de resumen / detalle por tipo
  router.get('/dispatch/operations/summary', async (req, res) => {
    try {
      const selectedDate = normalizeDateParam(req.query.date);
      const type = normalizeSummaryType(req.query.type);
      const meta = summaryTypeMeta(type);
      const serviceRequests = await loadSummaryServiceRequests(prisma, selectedDate, type);
      const groupedByClient = groupByClient(serviceRequests);
      const now = new Date();

      res.render('dispatch/operations-summary', {
        selectedDate,
        type,
        meta,
        serviceRequests,
        groupedByClient,
        now,
        isServiceRequestEditLocked,
        activeAssignments,
        confirmedAssignments,
        statusLabel,
        assignmentStatusLabel,
        buildHorario,
        buildCoverageText,
        isOpsUser: isOpsUser(req)
      });
    } catch (err) {
      console.error('[DispatchOps] Error cargando resumen:', err);
      res.status(500).send('Error cargando el resumen de operaciones');
    }
  });

  // Exportar Excel del día
  router.get('/dispatch/operations/export', async (req, res) => {
    try {
      const selectedDate = normalizeDateParam(req.query.date);
      const { start, end } = buildUtcDayRange(selectedDate);

      const serviceRequests = await prisma.dispatchServiceRequest.findMany({
        where: { serviceDate: { gte: start, lt: end } },
        include: {
          service: true,
          assignments: {
            include: { worker: true },
            orderBy: [{ status: 'asc' }, { createdAt: 'asc' }]
          },
          incidents: {
            where: { status: { in: OPEN_INCIDENT_STATUSES } },
            include: { worker: true },
            orderBy: { createdAt: 'desc' }
          }
        },
        orderBy: [{ clientName: 'asc' }, { operationPointName: 'asc' }, { startTime: 'asc' }]
      });

      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Lórren Dispatch';
      workbook.created = new Date();

      // Hoja 1: Resumen general
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
      summaryHeaderRow.values = summaryColumns.map((c) => c.header);
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

      // Hoja 2: Detalle por cliente
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
        const clientHeaderRow = clientSheet.getRow(3);
        clientHeaderRow.values = clientColumns.map((c) => c.header);
        styleHeader(clientHeaderRow);

        clientRequests.forEach((request, index) => {
          const workersText = buildAssignedWorkersCell(request);
          const row = clientSheet.addRow({
            operation: request.operationPointName || '-',
            service: request.serviceName || request.service?.name || '-',
            horario: buildHorario(request),
            workers: workersText,
            coverage: buildCoverageText(request),
            status: statusLabel(request.status)
          });
          styleDataRow(row, index);
          styleStatusCell(row.getCell('status'), request.status);
          row.height = calculateRowHeight(request);
        });
      }

      // Hoja 3: Consolidado auxiliares
      const workersSheet = workbook.addWorksheet('Auxiliares');
      const workersColumns = [
        { header: 'Auxiliar', key: 'name', width: 30 },
        { header: 'Documento', key: 'document', width: 22 },
        { header: 'Cliente', key: 'client', width: 28 },
        { header: 'Operación', key: 'operation', width: 28 },
        { header: 'Servicio', key: 'service', width: 24 },
        { header: 'Horario', key: 'horario', width: 18 },
        { header: 'Estado asignación', key: 'assignStatus', width: 24 }
      ];
      applyTitle(workersSheet, 'Auxiliares del día', `Fecha: ${selectedDate}`, workersColumns.length);
      workersSheet.columns = workersColumns;
      const workersHeaderRow = workersSheet.getRow(3);
      workersHeaderRow.values = workersColumns.map((c) => c.header);
      styleHeader(workersHeaderRow);

      let workerRowIndex = 0;
      for (const request of serviceRequests) {
        for (const assignment of activeAssignments(request)) {
          const worker = assignment.worker || {};
          const row = workersSheet.addRow({
            name: normalizeString(worker.fullName) || 'Auxiliar',
            document: workerDocumentLabel(worker),
            client: request.clientName || '-',
            operation: request.operationPointName || '-',
            service: request.serviceName || request.service?.name || '-',
            horario: buildHorario(request),
            assignStatus: assignmentStatusLabel(assignment.status)
          });
          styleDataRow(row, workerRowIndex);
          row.height = 22;
          workerRowIndex++;
        }
      }

      const filename = `operaciones-${selectedDate}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      await workbook.xlsx.write(res);
      res.end();
    } catch (err) {
      console.error('[DispatchOps] Error exportando Excel:', err);
      res.status(500).send('Error generando el archivo de exportación');
    }
  });

  // Exportar resumen por cliente (para envío)
  router.get('/dispatch/operations/export-client/:clientName', async (req, res) => {
    try {
      const selectedDate = normalizeDateParam(req.query.date);
      const { start, end } = buildUtcDayRange(selectedDate);
      const clientName = decodeURIComponent(req.params.clientName || '');

      const serviceRequests = await prisma.dispatchServiceRequest.findMany({
        where: {
          serviceDate: { gte: start, lt: end },
          clientName
        },
        include: {
          service: true,
          assignments: {
            include: { worker: true },
            orderBy: [{ status: 'asc' }, { createdAt: 'asc' }]
          }
        },
        orderBy: [{ operationPointName: 'asc' }, { startTime: 'asc' }]
      });

      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Lórren Dispatch';
      workbook.created = new Date();

      const sheet = workbook.addWorksheet('Auxiliares');
      const columns = [
        { header: 'Operación', key: 'operation', width: 30 },
        { header: 'Servicio', key: 'service', width: 26 },
        { header: 'Horario', key: 'horario', width: 18 },
        { header: 'Auxiliares', key: 'workers', width: 56 },
        { header: 'Cobertura', key: 'coverage', width: 28 }
      ];
      applyTitle(sheet, clientName, `Fecha: ${selectedDate}`, columns.length);
      sheet.columns = columns;
      const headerRow = sheet.getRow(3);
      headerRow.values = columns.map((c) => c.header);
      styleHeader(headerRow);

      serviceRequests.forEach((request, index) => {
        const row = sheet.addRow({
          operation: request.operationPointName || '-',
          service: request.serviceName || request.service?.name || '-',
          horario: buildHorario(request),
          workers: buildAssignedWorkersCell(request),
          coverage: buildCoverageText(request)
        });
        styleDataRow(row, index);
        row.height = calculateRowHeight(request);
      });

      const safeClientName = clientName.replace(/[^a-zA-Z0-9\-_]/g, '-').slice(0, 40);
      const filename = `${safeClientName}-${selectedDate}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      await workbook.xlsx.write(res);
      res.end();
    } catch (err) {
      console.error('[DispatchOps] Error exportando cliente:', err);
      res.status(500).send('Error generando el archivo del cliente');
    }
  });

  // Consolidado de auxiliares para envío por WhatsApp
  router.get('/dispatch/operations/workers-summary', async (req, res) => {
    try {
      const selectedDate = normalizeDateParam(req.query.date);
      const { start, end } = buildUtcDayRange(selectedDate);

      const serviceRequests = await prisma.dispatchServiceRequest.findMany({
        where: { serviceDate: { gte: start, lt: end } },
        include: {
          service: true,
          assignments: {
            include: { worker: true },
            orderBy: [{ status: 'asc' }, { createdAt: 'asc' }]
          }
        },
        orderBy: [{ clientName: 'asc' }, { operationPointName: 'asc' }, { startTime: 'asc' }]
      });

      const groupedByClient = groupByClient(serviceRequests);

      res.render('dispatch/workers-summary', {
        selectedDate,
        groupedByClient,
        buildClientWorkersSummary,
        activeAssignments,
        buildHorario,
        isOpsUser: isOpsUser(req)
      });
    } catch (err) {
      console.error('[DispatchOps] Error cargando resumen auxiliares:', err);
      res.status(500).send('Error cargando el resumen de auxiliares');
    }
  });

  return router;
}
