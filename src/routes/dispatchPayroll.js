import express from 'express';
import ExcelJS from 'exceljs';
import multer from 'multer';
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
  PAYROLL_IMPORT_MAX_BYTES,
  analyzePayrollAttendanceImport,
  buildPayrollAttendanceImportPreview,
  commitPayrollAttendanceImport,
  loadRecentPayrollAttendanceImports,
  parsePayrollAttendanceImportFile,
  payrollAttendanceImportErrorMessage,
  reversePayrollAttendanceImportBatch
} from '../modules/dispatch-payroll/application/payrollAttendanceImport.js';
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
  white: 'FFFFFFFF'
});
const PAYROLL_OVERTIME_CONCEPT_CODES = Object.freeze(['HEDO', 'HENO', 'HEDD', 'HEND', 'HEDF', 'HENF']);

const PAYROLL_EXCEL_COLUMN_WIDTHS = Object.freeze({
  Documento: 17,
  TipoDocumento: 15,
  Nombre: 30,
  FechaInicial: 13,
  FechaFinal: 13,
  DiasRemunerados: 17,
  DiasNoRemunerados: 19,
  PermisosRemunerados: 20,
  Incapacidades: 15,
  TurnosNocturnos: 17,
  Domingos: 12,
  Festivos: 12,
  Descansos: 32,
  HorasOrdinarias: 16,
  TotalTrabajado: 16,
  HorasExtraTotal: 16
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
    actorUserId: normalizeString(req.session?.userId || req.userId, 120),
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
  [
    'periodType', 'from', 'to', 'anchor',
    'extraPeriodType', 'extraFrom', 'extraTo', 'extraAnchor',
    'clientId', 'operationPointId', 'search', 'includeTest'
  ].forEach((key) => {
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
  return messages[code] || payrollAttendanceImportErrorMessage(code) || 'No fue posible completar la operación de nómina.';
}

function multerUploadHandler(upload) {
  return (req, res, next) => upload(req, res, (error) => {
    if (!error) return next();
    if (error?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ ok: false, error: publicError(new Error('payroll_import_file_too_large')) });
    return res.status(400).json({ ok: false, error: publicError(new Error('payroll_import_file_invalid')) });
  });
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

function payrollExcelRows(report) {
  return buildPayrollExportRows(report).map((sourceRow, index) => {
    const reportRow = report.rows[index] || {};
    const row = {};
    for (const [header, value] of Object.entries(sourceRow)) {
      if (header === 'DiasTrabajados') {
        row.DiasRemunerados = Number(reportRow.remuneratedDays || 0);
        row.DiasNoRemunerados = Number(reportRow.unremuneratedDays || 0);
        row.PermisosRemunerados = Number(reportRow.paidPermissionDays || 0);
        row.Incapacidades = Number(reportRow.incapacityDays || 0);
        row.TurnosNocturnos = Number(reportRow.nightShiftCount || 0);
        row.Domingos = Number(reportRow.sundayCount || 0);
        row.Festivos = Number(reportRow.holidayCount || 0);
        continue;
      }
      if (header === 'DiasDescontados' || header === 'DiasLaboradosNetos') continue;
      row[header] = value;
    }
    return row;
  });
}

function payrollExcelHeaders(rows) {
  return rows.length
    ? Object.keys(rows[0]).filter((header) => header !== 'Novedades' && header !== 'Estado')
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
  const rows = payrollExcelRows(report);
  const headers = payrollExcelHeaders(rows);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Lórren · LoginPro';
  workbook.company = 'LoginPro Service';
  workbook.title = 'Nómina y tiempo trabajado';
  workbook.subject = `Corte ${report.period.from} a ${report.period.to}`;
  workbook.created = report.generatedAt instanceof Date ? report.generatedAt : new Date();

  const sheet = workbook.addWorksheet('Nómina');
  sheet.properties.defaultRowHeight = 20;
  sheet.columns = headers.map((header) => ({ key: header, width: payrollExcelColumnWidth(header) }));

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
  const overtimePeriod = report.overtimePeriod || report.period;
  subtitleCell.value = `Corte ${report.period.from} a ${report.period.to} · Extras ${overtimePeriod.from} a ${overtimePeriod.to} · ${rows.length} auxiliar(es)`;
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

  const wrapHeaders = new Set(['Nombre', 'Descansos']);
  const centeredHeaders = new Set([
    'TipoDocumento', 'FechaInicial', 'FechaFinal', 'DiasRemunerados', 'DiasNoRemunerados',
    'PermisosRemunerados', 'Incapacidades', 'TurnosNocturnos', 'Domingos', 'Festivos'
  ]);

  rows.forEach((sourceRow, rowIndex) => {
    const row = sheet.addRow(Object.fromEntries(headers.map((header) => [header, sourceRow[header] ?? ''])));
    row.height = 22;
    row.eachCell({ includeEmpty: true }, (cell, columnIndex) => {
      const header = headers[columnIndex - 1];
      cell.fill = {
        type: 'pattern', pattern: 'solid',
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
      if (['DiasRemunerados', 'DiasNoRemunerados', 'PermisosRemunerados', 'Incapacidades', 'TurnosNocturnos', 'Domingos', 'Festivos'].includes(header)) cell.numFmt = '0';
    });
  });

  sheet.views = [{ state: 'frozen', xSplit: 3, ySplit: PAYROLL_EXCEL_HEADER_ROW, topLeftCell: 'D5', activeCell: 'D5', showGridLines: false }];
  sheet.autoFilter = { from: `A${PAYROLL_EXCEL_HEADER_ROW}`, to: `${lastColumnLetter}${PAYROLL_EXCEL_HEADER_ROW}` };
  sheet.pageSetup = {
    orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    margins: { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 }
  };
  sheet.headerFooter.oddFooter = '&LLoginPro Service&C&P de &N&RReporte de Nómina';
  return workbook;
}

function cloneConceptValues(source = {}) {
  return Object.fromEntries(PAYROLL_CONCEPT_CODES.map((code) => [code, Number(source?.[code] || 0)]));
}

function noveltyIdentity(novelty = {}) {
  return [
    novelty.code || '', novelty.dateKey || '', novelty.sessionId || '', novelty.message || '', novelty.blocking === false ? '0' : '1'
  ].join('|');
}

function mergeNovelties(general = [], overtime = []) {
  const seen = new Set();
  const merged = [];
  for (const novelty of [...general, ...overtime]) {
    const key = noveltyIdentity(novelty);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(novelty);
  }
  return merged;
}

function neutralGeneralRowFromOvertime(row) {
  const conceptMinutes = Object.fromEntries(PAYROLL_CONCEPT_CODES.map((code) => [code, 0]));
  const conceptHours = Object.fromEntries(PAYROLL_CONCEPT_CODES.map((code) => [code, 0]));
  return {
    ...row,
    totalMinutes: 0,
    ordinaryMinutes: 0,
    overtimeMinutes: 0,
    unrecognizedOvertimeMinutes: 0,
    totalHours: 0,
    ordinaryHours: 0,
    overtimeHours: 0,
    unrecognizedOvertimeHours: 0,
    conceptMinutes,
    conceptHours,
    workedDays: 0,
    deductedDays: 0,
    netWorkedDays: 0,
    remuneratedDays: 0,
    unremuneratedDays: 0,
    paidPermissionDays: 0,
    incapacityDays: 0,
    nightShiftCount: 0,
    sundayCount: 0,
    holidayCount: 0,
    restAssignments: [],
    daily: [],
    novelties: [],
    status: 'CALCULADO',
    exportable: true
  };
}

function recalculateCombinedTotals(report) {
  const rows = report.rows || [];
  const conceptMinutes = Object.fromEntries(PAYROLL_CONCEPT_CODES.map((code) => [
    code,
    rows.reduce((sum, row) => sum + Number(row?.conceptMinutes?.[code] || 0), 0)
  ]));
  const totals = {
    ...(report.totals || {}),
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
    remuneratedDays: sumRows(rows, 'remuneratedDays'),
    unremuneratedDays: sumRows(rows, 'unremuneratedDays'),
    paidPermissionDays: sumRows(rows, 'paidPermissionDays'),
    incapacityDays: sumRows(rows, 'incapacityDays'),
    nightShiftCount: sumRows(rows, 'nightShiftCount'),
    sundayCount: sumRows(rows, 'sundayCount'),
    holidayCount: sumRows(rows, 'holidayCount'),
    conceptMinutes
  };
  totals.totalHours = minutesToDecimalHours(totals.totalMinutes);
  totals.ordinaryHours = minutesToDecimalHours(totals.ordinaryMinutes);
  totals.overtimeHours = minutesToDecimalHours(totals.overtimeMinutes);
  totals.unrecognizedOvertimeHours = minutesToDecimalHours(totals.unrecognizedOvertimeMinutes);
  totals.conceptHours = Object.fromEntries(PAYROLL_CONCEPT_CODES.map((code) => [code, minutesToDecimalHours(conceptMinutes[code])]));
  return totals;
}

function hasOvertimePeriodSignal(row) {
  return Number(row?.overtimeMinutes || 0) > 0
    || Number(row?.unrecognizedOvertimeMinutes || 0) > 0
    || PAYROLL_OVERTIME_CONCEPT_CODES.some((code) => Number(row?.conceptMinutes?.[code] || 0) > 0)
    || (Array.isArray(row?.novelties) && row.novelties.length > 0);
}

export function combinePayrollPeriodReports(generalReport, overtimeReport) {
  const generalRows = Array.isArray(generalReport?.rows) ? generalReport.rows : [];
  const overtimeRows = Array.isArray(overtimeReport?.rows) ? overtimeReport.rows : [];
  const rows = generalRows.map((row) => ({
    ...row,
    conceptMinutes: cloneConceptValues(row.conceptMinutes),
    conceptHours: cloneConceptValues(row.conceptHours),
    novelties: [...(row.novelties || [])]
  }));
  const rowByWorker = new Map(rows.map((row) => [row.workerId, row]));

  for (const overtimeRow of overtimeRows) {
    let target = rowByWorker.get(overtimeRow.workerId);
    if (!target) {
      if (!hasOvertimePeriodSignal(overtimeRow)) continue;
      target = neutralGeneralRowFromOvertime(overtimeRow);
      rows.push(target);
      rowByWorker.set(target.workerId, target);
    }
    target.overtimeMinutes = Number(overtimeRow.overtimeMinutes || 0);
    target.unrecognizedOvertimeMinutes = Number(overtimeRow.unrecognizedOvertimeMinutes || 0);
    target.overtimeHours = minutesToDecimalHours(target.overtimeMinutes);
    target.unrecognizedOvertimeHours = minutesToDecimalHours(target.unrecognizedOvertimeMinutes);
    for (const code of PAYROLL_OVERTIME_CONCEPT_CODES) {
      target.conceptMinutes[code] = Number(overtimeRow.conceptMinutes?.[code] || 0);
      target.conceptHours[code] = minutesToDecimalHours(target.conceptMinutes[code]);
    }
    target.novelties = mergeNovelties(target.novelties, overtimeRow.novelties || []);
    target.exportable = !target.novelties.some((novelty) => novelty?.blocking !== false);
    target.status = target.exportable ? 'CALCULADO' : 'CON_NOVEDADES';
  }

  for (const target of rows) {
    if (overtimeRows.some((row) => row.workerId === target.workerId)) continue;
    target.overtimeMinutes = 0;
    target.unrecognizedOvertimeMinutes = 0;
    target.overtimeHours = 0;
    target.unrecognizedOvertimeHours = 0;
    for (const code of PAYROLL_OVERTIME_CONCEPT_CODES) {
      target.conceptMinutes[code] = 0;
      target.conceptHours[code] = 0;
    }
  }

  rows.sort((left, right) => left.fullName.localeCompare(right.fullName, 'es'));
  const report = {
    ...generalReport,
    rows,
    overtimePeriod: overtimeReport?.period || generalReport?.period
  };
  report.totals = recalculateCombinedTotals(report);
  return report;
}

export function buildOvertimeReportInput(source = {}, generalPeriod = {}) {
  const input = { ...(source || {}) };
  const requestedType = normalizeString(input.extraPeriodType, 20)?.toUpperCase();
  const hasExplicitOvertimePeriod = Boolean(
    requestedType || input.extraAnchor || input.extraFrom || input.extraTo
  );

  if (!hasExplicitOvertimePeriod) {
    return {
      ...input,
      periodType: 'CUSTOM',
      from: generalPeriod.from,
      to: generalPeriod.to,
      anchor: generalPeriod.from
    };
  }

  if (!['WEEKLY', 'CUSTOM'].includes(requestedType)) throw new Error('payroll_range_invalid');
  if (requestedType === 'WEEKLY') {
    return {
      ...input,
      periodType: 'WEEKLY',
      anchor: input.extraAnchor || input.extraFrom || generalPeriod.from,
      from: undefined,
      to: undefined
    };
  }
  return {
    ...input,
    periodType: 'CUSTOM',
    from: input.extraFrom || input.extraAnchor || generalPeriod.from,
    to: input.extraTo || input.extraFrom || input.extraAnchor || generalPeriod.to,
    anchor: input.extraFrom || input.extraAnchor || generalPeriod.from
  };
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
    remuneratedDays: sumRows(rows, 'remuneratedDays'),
    unremuneratedDays: sumRows(rows, 'unremuneratedDays'),
    paidPermissionDays: sumRows(rows, 'paidPermissionDays'),
    incapacityDays: sumRows(rows, 'incapacityDays'),
    nightShiftCount: sumRows(rows, 'nightShiftCount'),
    sundayCount: sumRows(rows, 'sundayCount'),
    holidayCount: sumRows(rows, 'holidayCount'),
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
  if (!normalizeString(input.periodType, 20)) input.periodType = 'BIWEEKLY';

  const options = { allowTestData: allowTestData(req) };
  const generalReport = await loadPayrollReport(prisma, input, options);
  const overtimeInput = buildOvertimeReportInput(input, generalReport.period);
  const sameResolvedRange = overtimeInput.periodType === 'CUSTOM'
    && String(overtimeInput.from || '') === String(generalReport.period.from || '')
    && String(overtimeInput.to || '') === String(generalReport.period.to || '');
  const overtimeReport = sameResolvedRange
    ? { ...generalReport, period: { periodType: 'CUSTOM', from: generalReport.period.from, to: generalReport.period.to, anchor: generalReport.period.from, spanDays: generalReport.period.spanDays } }
    : await loadPayrollReport(prisma, overtimeInput, options);
  const report = combinePayrollPeriodReports(generalReport, overtimeReport);
  return applyPayrollWorkerSelection(report, workerIds);
}

export function dispatchPayrollRouter(prisma) {
  const router = express.Router();
  const formParser = express.urlencoded({ extended: false, limit: '24kb' });
  const jsonParser = express.json({ limit: '8kb', strict: true });
  const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: PAYROLL_IMPORT_MAX_BYTES, files: 1 } }).single('file');
  const importParser = multerUploadHandler(importUpload);

  router.get('/api/users/:userId/access', requireDev, async (req, res) => {
    noStore(res);
    try {
      const access = await resolvePayrollFeatureAccess(prisma, { userRole: 'admin', userId: req.params.userId, username: null });
      return res.json({ ok: true, enabled: access.allowed, userId: access.userId });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error?.message || 'payroll_access_failed' });
    }
  });

  router.post('/api/users/:userId/access', requireDev, jsonParser, async (req, res) => {
    noStore(res);
    try {
      const result = await setPayrollFeatureAccess(prisma, { targetUserId: req.params.userId, enabled: req.body?.enabled === true, ...actor(req) });
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
      const result = await setPayrollFeatureAccess(prisma, { targetUserId: user.id, enabled: req.body?.enabled === true, ...actor(req) });
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

  router.post('/imports/preview', importParser, async (req, res) => {
    try {
      const parsed = await parsePayrollAttendanceImportFile(req.file, { mapping: req.body?.mapping });
      const analysis = await analyzePayrollAttendanceImport(prisma, parsed, {
        includeTest: allowTestData(req) && String(req.body?.includeTest || '').toLowerCase() === 'true'
      });
      return res.status(200).json(buildPayrollAttendanceImportPreview(analysis));
    } catch (error) {
      return res.status(400).json({ ok: false, error: publicError(error), code: normalizeString(error?.message, 120) });
    }
  });

  router.post('/imports/commit', importParser, async (req, res) => {
    try {
      const result = await commitPayrollAttendanceImport(prisma, req.file, {
        mapping: req.body?.mapping,
        previewFingerprint: normalizeString(req.body?.previewFingerprint, 128),
        includeTest: allowTestData(req) && String(req.body?.includeTest || '').toLowerCase() === 'true',
        actor: actor(req)
      });
      return res.status(200).json({ ok: true, ...result });
    } catch (error) {
      console.warn('[PAYROLL_ATTENDANCE_IMPORT_FAILED]', { code: normalizeString(error?.message, 120) || 'unknown' });
      return res.status(400).json({ ok: false, error: publicError(error), code: normalizeString(error?.message, 120) });
    }
  });

  router.post('/imports/:batchId/reverse', formParser, async (req, res) => {
    try {
      const result = await reversePayrollAttendanceImportBatch(prisma, req.params.batchId, { actor: actor(req) });
      const message = result.conflicts
        ? `Reversa parcial: ${result.reversedWorkdays} jornada(s) reversada(s) y ${result.conflicts} protegida(s) por cambios posteriores.`
        : `Importación reversada: ${result.reversedWorkdays} jornada(s).`;
      return redirectToPayroll(res, sanitizedPayrollInput(req, req.body), { success: message });
    } catch (error) {
      return redirectToPayroll(res, sanitizedPayrollInput(req, req.body), { error: publicError(error) });
    }
  });

  router.get('/', async (req, res) => {
    try {
      const [report, recentImports] = await Promise.all([
        reportForRequest(prisma, req, req.query || {}),
        loadRecentPayrollAttendanceImports(prisma, 20).catch(() => [])
      ]);
      const selectedClientId = report.filters.clientId || report.clients[0]?.id || '';
      const selectedPolicies = await loadPayrollPolicies(prisma, selectedClientId ? [selectedClientId] : []);
      const selectedPolicy = selectedPolicies.get(selectedClientId) || DEFAULT_PAYROLL_POLICY;
      return res.render('operacionesNomina', {
        pageTitle: 'Nómina y tiempo trabajado', role: roleFromRequest(req), report, recentImports, selectedPolicy,
        conceptCodes: PAYROLL_CONCEPT_CODES, formatPayrollMinutes,
        success: normalizeString(req.query?.success, 300), error: normalizeString(req.query?.error, 300)
      });
    } catch (error) {
      console.error('[PAYROLL_REPORT_FAILED]', error);
      return res.status(500).render('operacionesNomina', {
        pageTitle: 'Nómina y tiempo trabajado', role: roleFromRequest(req), recentImports: [],
        report: {
          period: { periodType: 'BIWEEKLY', from: '', to: '', anchor: '' },
          overtimePeriod: { periodType: 'CUSTOM', from: '', to: '', anchor: '' },
          filters: { clientId: '', operationPointId: '', workerId: '', search: '', includeTest: false },
          clients: [], workers: [], rows: [], conceptCodes: PAYROLL_CONCEPT_CODES,
          totals: {
            workers: 0, totalMinutes: 0, ordinaryMinutes: 0, overtimeMinutes: 0,
            exportableWorkers: 0, workersWithNovelties: 0,
            remuneratedDays: 0, unremuneratedDays: 0, paidPermissionDays: 0, incapacityDays: 0,
            nightShiftCount: 0, sundayCount: 0, holidayCount: 0,
            conceptMinutes: {}, conceptHours: {}
          }
        },
        selectedPolicy: DEFAULT_PAYROLL_POLICY, conceptCodes: PAYROLL_CONCEPT_CODES, formatPayrollMinutes,
        success: null, error: publicError(error)
      });
    }
  });

  router.post('/policy', formParser, async (req, res) => {
    if (roleFromRequest(req) !== 'dev') return redirectToPayroll(res, sanitizedPayrollInput(req, req.body), { error: 'Solo DEV puede modificar la política de jornada.' });
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
