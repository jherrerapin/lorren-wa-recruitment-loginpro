import express from 'express';
import ExcelJS from 'exceljs';
import {
  buildPayrollExportRows,
  loadPayrollPolicies,
  loadPayrollReport,
  savePayrollCompensation,
  savePayrollPolicy
} from '../modules/dispatch-payroll/application/payrollReport.js';
import {
  DEFAULT_PAYROLL_POLICY,
  PAYROLL_CONCEPT_CODES,
  formatPayrollMinutes,
  minutesToDecimalHours
} from '../modules/dispatch-payroll/domain/payrollConceptEngine.js';
import {
  resolvePayrollFeatureAccess,
  setPayrollFeatureAccess
} from '../services/payrollFeatureAccess.js';

const PAYROLL_EXCEL_HEADER_ROW = 4;
const PAYROLL_EXCEL_COLORS = Object.freeze({
  navy: 'FF1E2D3D',
  teal: 'FF0D7A6B',
  tealSoft: 'FFE6F4F1',
  border: 'FFE1E4E8',
  stripe: 'FFF8FAFC',
  muted: 'FF64748B',
  green: 'FF166534',
  greenSoft: 'FFDCFCE7',
  amber: 'FF92400E',
  amberSoft: 'FFFEF3C7',
  white: 'FFFFFFFF'
});

const PAYROLL_EXCEL_COLUMN_WIDTHS = Object.freeze({
  Documento: 17,
  TipoDocumento: 15,
  Nombre: 30,
  FechaInicial: 13,
  FechaFinal: 13,
  DiasTrabajados: 14,
  DiasDescontados: 16,
  DiasLaboradosNetos: 18,
  Descansos: 32,
  HorasOrdinarias: 16,
  TotalTrabajado: 16,
  HorasExtraTotal: 16,
  Estado: 16,
  Novedades: 42
});

function normalizeString(value, maxLength = 200) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizeWorkerIds(value) {
  const source = Array.isArray(value) ? value : [value];
  return [...new Set(source
    .flatMap((item) => (typeof item === 'string' ? item.split(',') : []))
    .map((item) => normalizeString(item, 120))
    .filter(Boolean))];
}

function actor(req) {
  return {
    actorUsername: normalizeString(req.session?.username || req.username, 160),
    actorRole: normalizeString(req.session?.userRole || req.userRole, 80),
    ipAddress: normalizeString(req.ip, 120),
    userAgent: normalizeString(req.get?.('user-agent'), 500)
  };
}

function roleFromRequest(req) {
  return req.session?.userRole || req.userRole;
}

function allowTestData(req) {
  return roleFromRequest(req) === 'dev';
}

function sanitizedPayrollInput(req, source = {}) {
  const input = { ...(source || {}) };
  if (!allowTestData(req)) delete input.includeTest;
  else if (String(input.includeTest || '').toLowerCase() === 'true') input.includeTest = 'true';
  else delete input.includeTest;
  return input;
}

function noStore(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

function safeQuery(source = {}) {
  const params = new URLSearchParams();
  ['periodType', 'from', 'to', 'anchor', 'clientId', 'operationPointId', 'search', 'includeTest'].forEach((key) => {
    const value = normalizeString(source[key], 180);
    if (value) params.set(key, value);
  });
  const workerIds = normalizeWorkerIds(source.filterWorkerId ?? source.workerId);
  if (workerIds.length) params.set('workerId', workerIds.join(','));
  return params;
}

function redirectToPayroll(res, source, { success = null, error = null } = {}) {
  const params = safeQuery(source);
  if (success) params.set('success', success);
  if (error) params.set('error', error);
  return res.redirect(`/admin/operaciones/asistencia/nomina?${params.toString()}`);
}

function publicError(error) {
  const code = typeof error?.message === 'string' ? error.message : '';
  const messages = {
    payroll_period_too_long: 'El periodo personalizado no puede superar 62 días.',
    payroll_range_invalid: 'Selecciona un rango de fechas válido.',
    payroll_policy_dev_required: 'Solo DEV puede modificar la política de jornada.',
    payroll_policy_client_required: 'Selecciona un cliente para guardar la política.',
    payroll_policy_client_not_found: 'El cliente seleccionado ya no existe.',
    payroll_compensation_invalid: 'Selecciona un estado de compensatorio válido.',
    payroll_compensation_worker_not_found: 'El auxiliar ya no existe.',
    payroll_access_dev_required: 'Solo DEV puede cambiar este permiso.',
    payroll_access_user_not_found: 'El usuario ya no existe.'
  };
  return messages[code] || 'No fue posible completar la operación de nómina.';
}

async function loadAccess(prisma, req) {
  const access = await resolvePayrollFeatureAccess(prisma, {
    userRole: roleFromRequest(req),
    userId: req.session?.userId || req.userId,
    username: req.session?.username || req.username
  });
  req.canAccessPayroll = access.allowed;
  if (req.session) req.session.canAccessPayroll = access.allowed;
  return access;
}

function requireDev(req, res, next) {
  if (roleFromRequest(req) !== 'dev') return res.status(403).json({ ok: false, error: 'dev_required' });
  return next();
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function reportFilename(report, extension) {
  return `nomina-${report.period.from}-${report.period.to}.${extension}`;
}

function sumRows(rows, field) {
  return rows.reduce((sum, row) => sum + Number(row?.[field] || 0), 0);
}

function payrollExcelHeaders(rows) {
  return rows.length
    ? Object.keys(rows[0])
    : ['Documento', 'Nombre', 'FechaInicial', 'FechaFinal', ...PAYROLL_CONCEPT_CODES];
}

function payrollExcelColumnWidth(header) {
  if (PAYROLL_CONCEPT_CODES.includes(header)) return 11;
  return PAYROLL_EXCEL_COLUMN_WIDTHS[header] || Math.max(12, Math.min(24, header.length + 3));
}

function isPayrollHourHeader(header) {
  return PAYROLL_CONCEPT_CODES.includes(header)
    || header.includes('Horas')
    || header === 'TotalTrabajado';
}

export function buildPayrollExcelWorkbook(report) {
  const rows = buildPayrollExportRows(report);
  const headers = payrollExcelHeaders(rows);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Lórren · LoginPro';
  workbook.company = 'LoginPro Service';
  workbook.title = 'Nómina y tiempo trabajado';
  workbook.subject = `Corte ${report.period.from} a ${report.period.to}`;
  workbook.created = report.generatedAt instanceof Date ? report.generatedAt : new Date();

  const sheet = workbook.addWorksheet('Nómina');
  sheet.properties.defaultRowHeight = 20;
  sheet.columns = headers.map((header) => ({
    key: header,
    width: payrollExcelColumnWidth(header)
  }));

  const lastColumnLetter = sheet.getColumn(headers.length).letter;
  sheet.mergeCells(`A1:${lastColumnLetter}1`);
  sheet.mergeCells(`A2:${lastColumnLetter}2`);

  const titleCell = sheet.getCell('A1');
  titleCell.value = 'Nómina y tiempo trabajado';
  titleCell.font = { bold: true, size: 16, color: { argb: PAYROLL_EXCEL_COLORS.white } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PAYROLL_EXCEL_COLORS.navy } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left' };
  sheet.getRow(1).height = 30;

  const subtitleCell = sheet.getCell('A2');
  subtitleCell.value = `Corte ${report.period.from} a ${report.period.to} · ${rows.length} auxiliar(es)`;
  subtitleCell.font = { bold: true, size: 11, color: { argb: PAYROLL_EXCEL_COLORS.teal } };
  subtitleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PAYROLL_EXCEL_COLORS.tealSoft } };
  subtitleCell.alignment = { vertical: 'middle', horizontal: 'left' };
  sheet.getRow(2).height = 22;
  sheet.getRow(3).height = 8;

  const headerRow = sheet.getRow(PAYROLL_EXCEL_HEADER_ROW);
  headers.forEach((header, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = header;
    cell.font = { bold: true, size: 10, color: { argb: PAYROLL_EXCEL_COLORS.white } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PAYROLL_EXCEL_COLORS.teal } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: PAYROLL_EXCEL_COLORS.teal } },
      bottom: { style: 'thin', color: { argb: PAYROLL_EXCEL_COLORS.navy } },
      left: { style: 'thin', color: { argb: PAYROLL_EXCEL_COLORS.border } },
      right: { style: 'thin', color: { argb: PAYROLL_EXCEL_COLORS.border } }
    };
  });
  headerRow.height = 32;

  const statusIndex = headers.indexOf('Estado') + 1;
  const wrapHeaders = new Set(['Nombre', 'Descansos', 'Novedades']);
  const centeredHeaders = new Set(['TipoDocumento', 'FechaInicial', 'FechaFinal', 'DiasTrabajados', 'DiasDescontados', 'DiasLaboradosNetos', 'Estado']);

  rows.forEach((sourceRow, rowIndex) => {
    const row = sheet.addRow(Object.fromEntries(headers.map((header) => [header, sourceRow[header] ?? ''])));
    row.height = 22;
    row.eachCell({ includeEmpty: true }, (cell, columnIndex) => {
      const header = headers[columnIndex - 1];
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: rowIndex % 2 ? PAYROLL_EXCEL_COLORS.stripe : PAYROLL_EXCEL_COLORS.white }
      };
      cell.border = {
        bottom: { style: 'thin', color: { argb: PAYROLL_EXCEL_COLORS.border } },
        left: { style: 'thin', color: { argb: PAYROLL_EXCEL_COLORS.border } },
        right: { style: 'thin', color: { argb: PAYROLL_EXCEL_COLORS.border } }
      };
      cell.alignment = {
        vertical: 'middle',
        horizontal: centeredHeaders.has(header) ? 'center' : (isPayrollHourHeader(header) ? 'right' : 'left'),
        wrapText: wrapHeaders.has(header)
      };
      if (isPayrollHourHeader(header)) cell.numFmt = '0.0';
      if (['DiasTrabajados', 'DiasDescontados', 'DiasLaboradosNetos'].includes(header)) cell.numFmt = '0.##';
    });

    if (statusIndex > 0) {
      const statusCell = row.getCell(statusIndex);
      const hasNovelties = statusCell.value === 'Con novedades';
      statusCell.font = {
        bold: true,
        color: { argb: hasNovelties ? PAYROLL_EXCEL_COLORS.amber : PAYROLL_EXCEL_COLORS.green }
      };
      statusCell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: hasNovelties ? PAYROLL_EXCEL_COLORS.amberSoft : PAYROLL_EXCEL_COLORS.greenSoft }
      };
    }
  });

  sheet.views = [{
    state: 'frozen',
    xSplit: 3,
    ySplit: PAYROLL_EXCEL_HEADER_ROW,
    topLeftCell: 'D5',
    activeCell: 'D5',
    showGridLines: false
  }];
  sheet.autoFilter = {
    from: `A${PAYROLL_EXCEL_HEADER_ROW}`,
    to: `${lastColumnLetter}${PAYROLL_EXCEL_HEADER_ROW}`
  };
  sheet.pageSetup = {
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 }
  };
  sheet.headerFooter.oddFooter = '&LLoginPro Service&C&P de &N&RReporte de Nómina';

  return workbook;
}

export function applyPayrollWorkerSelection(report, requestedWorkerIds = []) {
  const workerIds = normalizeWorkerIds(requestedWorkerIds);
  const sourceRows = Array.isArray(report?.rows) ? report.rows : [];
  const availableWorkers = sourceRows.map((row) => ({
    id: row.workerId,
    fullName: row.fullName,
    documentType: row.documentType || '',
    documentNumber: row.documentNumber || '',
    phone: row.phone || ''
  }));
  const selected = new Set(workerIds);
  const rows = selected.size ? sourceRows.filter((row) => selected.has(row.workerId)) : sourceRows;
  const conceptMinutes = Object.fromEntries(PAYROLL_CONCEPT_CODES.map((code) => [
    code,
    rows.reduce((sum, row) => sum + Number(row?.conceptMinutes?.[code] || 0), 0)
  ]));
  const totals = {
    ...(report?.totals || {}),
    workers: rows.length,
    totalMinutes: sumRows(rows, 'totalMinutes'),
    ordinaryMinutes: sumRows(rows, 'ordinaryMinutes'),
    overtimeMinutes: sumRows(rows, 'overtimeMinutes'),
    unrecognizedOvertimeMinutes: sumRows(rows, 'unrecognizedOvertimeMinutes'),
    exportableWorkers: rows.filter((row) => row.exportable).length,
    workersWithNovelties: rows.filter((row) => !row.exportable).length,
    workedDays: sumRows(rows, 'workedDays'),
    deductedDays: sumRows(rows, 'deductedDays'),
    netWorkedDays: sumRows(rows, 'netWorkedDays'),
    conceptMinutes
  };
  totals.totalHours = minutesToDecimalHours(totals.totalMinutes);
  totals.ordinaryHours = minutesToDecimalHours(totals.ordinaryMinutes);
  totals.overtimeHours = minutesToDecimalHours(totals.overtimeMinutes);
  totals.unrecognizedOvertimeHours = minutesToDecimalHours(totals.unrecognizedOvertimeMinutes);
  totals.conceptHours = Object.fromEntries(PAYROLL_CONCEPT_CODES.map((code) => [code, minutesToDecimalHours(conceptMinutes[code])]));
  return {
    ...report,
    rows,
    workers: availableWorkers,
    filters: { ...(report?.filters || {}), workerId: workerIds.join(',') },
    totals
  };
}

async function reportForRequest(prisma, req, source) {
  const input = sanitizedPayrollInput(req, source);
  const workerIds = normalizeWorkerIds(input.workerId);
  delete input.workerId;
  delete input.filterWorkerId;
  const report = await loadPayrollReport(prisma, input, {
    allowTestData: allowTestData(req)
  });
  return applyPayrollWorkerSelection(report, workerIds);
}

export function dispatchPayrollRouter(prisma) {
  const router = express.Router();
  const formParser = express.urlencoded({ extended: false, limit: '24kb' });
  const jsonParser = express.json({ limit: '8kb', strict: true });

  router.get('/api/users/:userId/access', requireDev, async (req, res) => {
    noStore(res);
    try {
      const access = await resolvePayrollFeatureAccess(prisma, {
        userRole: 'admin',
        userId: req.params.userId,
        username: null
      });
      return res.json({ ok: true, enabled: access.allowed, userId: access.userId });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error?.message || 'payroll_access_failed' });
    }
  });

  router.post('/api/users/:userId/access', requireDev, jsonParser, async (req, res) => {
    noStore(res);
    try {
      const result = await setPayrollFeatureAccess(prisma, {
        targetUserId: req.params.userId,
        enabled: req.body?.enabled === true,
        ...actor(req)
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error?.message || 'payroll_access_failed' });
    }
  });

  router.post('/api/users/by-username/:username/access', requireDev, jsonParser, async (req, res) => {
    noStore(res);
    const username = normalizeString(req.params.username, 160);
    const user = username ? await prisma.appUser.findUnique({ where: { username }, select: { id: true } }) : null;
    if (!user) return res.status(404).json({ ok: false, error: 'payroll_access_user_not_found' });
    try {
      const result = await setPayrollFeatureAccess(prisma, {
        targetUserId: user.id,
        enabled: req.body?.enabled === true,
        ...actor(req)
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error?.message || 'payroll_access_failed' });
    }
  });

  router.use(async (req, res, next) => {
    noStore(res);
    try {
      const access = await loadAccess(prisma, req);
      if (!access.allowed) return res.status(403).send('No tienes permiso para acceder a Nómina y tiempo trabajado.');
      res.locals.canAccessPayroll = true;
      return next();
    } catch (error) {
      console.error('[PAYROLL_ACCESS_FAILED]', error);
      return res.status(503).send('No fue posible comprobar el permiso de Nómina.');
    }
  });

  router.get('/', async (req, res) => {
    try {
      const report = await reportForRequest(prisma, req, req.query || {});
      const selectedClientId = report.filters.clientId || report.clients[0]?.id || '';
      const selectedPolicies = await loadPayrollPolicies(prisma, selectedClientId ? [selectedClientId] : []);
      const selectedPolicy = selectedPolicies.get(selectedClientId) || DEFAULT_PAYROLL_POLICY;
      return res.render('operacionesNomina', {
        pageTitle: 'Nómina y tiempo trabajado',
        role: roleFromRequest(req),
        report,
        selectedPolicy,
        conceptCodes: PAYROLL_CONCEPT_CODES,
        formatPayrollMinutes,
        success: normalizeString(req.query?.success, 300),
        error: normalizeString(req.query?.error, 300)
      });
    } catch (error) {
      console.error('[PAYROLL_REPORT_FAILED]', error);
      return res.status(500).render('operacionesNomina', {
        pageTitle: 'Nómina y tiempo trabajado',
        role: roleFromRequest(req),
        report: {
          period: { periodType: 'WEEKLY', from: '', to: '', anchor: '' },
          filters: { clientId: '', operationPointId: '', workerId: '', search: '', includeTest: false },
          clients: [], workers: [], rows: [], conceptCodes: PAYROLL_CONCEPT_CODES,
          totals: { workers: 0, totalMinutes: 0, ordinaryMinutes: 0, overtimeMinutes: 0, exportableWorkers: 0, workersWithNovelties: 0, conceptMinutes: {}, conceptHours: {} }
        },
        selectedPolicy: DEFAULT_PAYROLL_POLICY,
        conceptCodes: PAYROLL_CONCEPT_CODES,
        formatPayrollMinutes,
        success: null,
        error: publicError(error)
      });
    }
  });

  router.post('/policy', formParser, async (req, res) => {
    if (roleFromRequest(req) !== 'dev') {
      return redirectToPayroll(res, sanitizedPayrollInput(req, req.body), { error: 'Solo DEV puede modificar la política de jornada.' });
    }
    try {
      await savePayrollPolicy(prisma, { ...req.body, recognizeEarlyArrival: req.body.recognizeEarlyArrival === 'true', ...actor(req) });
      return redirectToPayroll(res, sanitizedPayrollInput(req, req.body), { success: 'Política de jornada guardada con auditoría.' });
    } catch (error) {
      return redirectToPayroll(res, sanitizedPayrollInput(req, req.body), { error: publicError(error) });
    }
  });

  router.post('/compensation', formParser, async (req, res) => {
    try {
      await savePayrollCompensation(prisma, { ...req.body, ...actor(req) });
      return redirectToPayroll(res, sanitizedPayrollInput(req, req.body), { success: 'Estado del compensatorio actualizado.' });
    } catch (error) {
      return redirectToPayroll(res, sanitizedPayrollInput(req, req.body), { error: publicError(error) });
    }
  });

  router.get('/export.csv', async (req, res) => {
    try {
      const report = await reportForRequest(prisma, req, req.query || {});
      const rows = buildPayrollExportRows(report);
      const headers = rows.length ? Object.keys(rows[0]) : ['Documento', 'Nombre', 'FechaInicial', 'FechaFinal', ...PAYROLL_CONCEPT_CODES];
      const lines = [headers.join(';'), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(';'))];
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${reportFilename(report, 'csv')}"`);
      return res.send(`\uFEFF${lines.join('\r\n')}`);
    } catch (error) {
      return redirectToPayroll(res, sanitizedPayrollInput(req, req.query), { error: publicError(error) });
    }
  });

  router.get('/export.xlsx', async (req, res) => {
    try {
      const report = await reportForRequest(prisma, req, req.query || {});
      const workbook = buildPayrollExcelWorkbook(report);
      const buffer = await workbook.xlsx.writeBuffer();
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.set('Content-Disposition', `attachment; filename="${reportFilename(report, 'xlsx')}"`);
      return res.send(Buffer.from(buffer));
    } catch (error) {
      return redirectToPayroll(res, sanitizedPayrollInput(req, req.query), { error: publicError(error) });
    }
  });

  return router;
}
