import express from 'express';
import ExcelJS from 'exceljs';
import { loadAttendanceAdminBoard } from '../modules/dispatch-attendance/application/adminAttendance.js';
import { loadPayrollReport } from '../modules/dispatch-payroll/application/payrollReport.js';
import { PAYROLL_CONCEPT_CODES } from '../modules/dispatch-payroll/domain/payrollConceptEngine.js';

const EXPORT_COLORS = Object.freeze({
  navy: 'FF1E2D3D',
  teal: 'FF0D7A6B',
  tealSoft: 'FFE6F4F1',
  border: 'FFE1E4E8',
  stripe: 'FFF8FAFC',
  white: 'FFFFFFFF'
});

const CONCEPT_LABELS = Object.freeze({
  HEDO: 'Extra diurna ordinaria',
  HENO: 'Extra nocturna ordinaria',
  HEDD: 'Extra diurna dominical',
  HEND: 'Extra nocturna dominical',
  HEDF: 'Extra diurna festiva',
  HENF: 'Extra nocturna festiva',
  RNO: 'Recargo nocturno ordinario',
  RDD: 'Recargo diurno dominical no compensado',
  RND: 'Recargo nocturno dominical no compensado',
  RDF: 'Recargo diurno festivo',
  RNF: 'Recargo nocturno festivo',
  RDDC: 'Recargo diurno dominical compensado',
  RNDC: 'Recargo nocturno dominical compensado'
});

function normalizeString(value, maxLength = 300) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizeList(value, maxLength = 300) {
  const source = Array.isArray(value) ? value : [value];
  return [...new Set(source.map((item) => normalizeString(item, maxLength)).filter(Boolean))];
}

function normalizedDocument(value) {
  return (normalizeString(value, 120) || '').replace(/[^0-9A-Za-z]/g, '').toLocaleLowerCase('es-CO');
}

function normalizedName(value) {
  return (normalizeString(value, 220) || '').toLocaleLowerCase('es-CO').replace(/\s+/g, ' ');
}

function identityKey({ workerName, fullName, documentNumber } = {}) {
  const document = normalizedDocument(documentNumber);
  return document ? `doc:${document}` : `name:${normalizedName(workerName || fullName)}`;
}

function selectedWorkerKey(value) {
  const normalized = normalizeString(value, 350);
  if (!normalized) return null;
  const separator = normalized.indexOf('|');
  if (separator < 0) return `name:${normalizedName(normalized)}`;
  const name = normalized.slice(0, separator).trim();
  const documentText = normalized.slice(separator + 1).trim();
  const withoutType = documentText.replace(/^(?:CC|PPT)\s+/i, '');
  const document = normalizedDocument(withoutType);
  return document ? `doc:${document}` : `name:${normalizedName(name)}`;
}

function dateKeysForBoardRows(rows = []) {
  const keys = new Map();
  for (const row of rows) {
    const identity = identityKey(row);
    if (!keys.has(identity)) keys.set(identity, new Set());
    if (row.serviceDateIso) keys.get(identity).add(row.serviceDateIso);
  }
  return keys;
}

function boardContextByDay(rows = []) {
  const context = new Map();
  for (const row of rows) {
    const key = `${identityKey(row)}|${row.serviceDateIso || ''}`;
    if (!context.has(key)) context.set(key, []);
    context.get(key).push(row);
  }
  return context;
}

function markingSummary(markings = [], field) {
  return (Array.isArray(markings) ? markings : [])
    .map((marking) => normalizeString(marking?.[field], 220))
    .filter(Boolean)
    .join(' / ');
}

function markingOperations(markings = []) {
  return (Array.isArray(markings) ? markings : [])
    .map((marking) => [marking?.clientName, marking?.operationName].filter(Boolean).join(' · '))
    .filter(Boolean)
    .join(' / ');
}

function correctionSummary(markings = []) {
  return (Array.isArray(markings) ? markings : [])
    .flatMap((marking) => Array.isArray(marking?.corrections) ? marking.corrections : [])
    .map((correction) => {
      const change = [correction?.previousLabel, correction?.newLabel].filter(Boolean).join(' → ');
      return [correction?.markTypeLabel, change, correction?.reason].filter(Boolean).join(': ');
    })
    .filter(Boolean)
    .join(' | ');
}

function dailyExportRows(report, boardRows) {
  const allowedDates = dateKeysForBoardRows(boardRows);
  const boardContext = boardContextByDay(boardRows);
  const output = [];

  for (const worker of report?.rows || []) {
    const identity = identityKey(worker);
    const workerDates = allowedDates.get(identity);
    if (!workerDates?.size) continue;

    for (const day of worker.daily || []) {
      if (!workerDates.has(day.dateKey)) continue;
      const attendanceRows = boardContext.get(`${identity}|${day.dateKey}`) || [];
      const statusLabels = [...new Set(attendanceRows.map((row) => row.statusLabel).filter(Boolean))];
      const cityNames = [...new Set(attendanceRows.map((row) => row.cityName).filter(Boolean))];
      const markings = day.markings || [];
      const row = {
        Fecha: day.dateKey,
        Documento: worker.documentNumber || '',
        TipoDocumento: worker.documentType || '',
        Auxiliar: worker.fullName || '',
        EstadoAsistencia: statusLabels.join(' / '),
        Sucursal: cityNames.join(' / '),
        Cliente: (day.clientNames || []).join(', '),
        Operacion: (day.operationNames || []).join(', '),
        MarcacionesOperacion: markingOperations(markings),
        Entrada: markingSummary(markings, 'arrivalLabel'),
        InicioAlmuerzo: markingSummary(markings, 'breakStartLabel'),
        FinAlmuerzo: markingSummary(markings, 'breakEndLabel'),
        Salida: markingSummary(markings, 'departureLabel'),
        Correcciones: correctionSummary(markings),
        HorasTotales: Number(day.totalHours || 0),
        HorasOrdinarias: Number(day.ordinaryHours || 0),
        HorasExtraTotal: Number(day.overtimeHours || 0)
      };
      for (const code of PAYROLL_CONCEPT_CODES) row[code] = Number(day.conceptHours?.[code] || 0);
      output.push(row);
    }
  }

  return output.sort((left, right) => (
    String(left.Fecha).localeCompare(String(right.Fecha), 'es')
    || String(left.Auxiliar).localeCompare(String(right.Auxiliar), 'es')
  ));
}

export function buildAttendanceFilteredWorkbook(report, boardRows) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Lórren · LoginPro';
  workbook.company = 'LoginPro Service';
  workbook.title = 'Asistencia filtrada · detalle diario';
  workbook.created = new Date();

  const rows = dailyExportRows(report, boardRows);
  const sheet = workbook.addWorksheet('Detalle diario');
  const fixedColumns = [
    ['Fecha', 13], ['Documento', 18], ['TipoDocumento', 14], ['Auxiliar', 30],
    ['EstadoAsistencia', 24], ['Sucursal', 18], ['Cliente', 24], ['Operacion', 28],
    ['MarcacionesOperacion', 34], ['Entrada', 24], ['InicioAlmuerzo', 24], ['FinAlmuerzo', 24],
    ['Salida', 24], ['Correcciones', 42], ['HorasTotales', 14], ['HorasOrdinarias', 16], ['HorasExtraTotal', 16]
  ];
  const conceptColumns = PAYROLL_CONCEPT_CODES.map((code) => [code, 14]);
  sheet.columns = [...fixedColumns, ...conceptColumns].map(([key, width]) => ({ key, width }));

  const lastColumn = sheet.getColumn(sheet.columns.length).letter;
  sheet.mergeCells(`A1:${lastColumn}1`);
  sheet.mergeCells(`A2:${lastColumn}2`);
  sheet.getCell('A1').value = 'Asistencia filtrada · detalle diario';
  sheet.getCell('A1').font = { bold: true, size: 16, color: { argb: EXPORT_COLORS.white } };
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: EXPORT_COLORS.navy } };
  sheet.getCell('A2').value = `Periodo ${report?.period?.from || ''} a ${report?.period?.to || ''} · ${rows.length} fila(s)`;
  sheet.getCell('A2').font = { bold: true, color: { argb: EXPORT_COLORS.teal } };
  sheet.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: EXPORT_COLORS.tealSoft } };

  const headers = fixedColumns.map(([key]) => key).concat(PAYROLL_CONCEPT_CODES);
  const headerLabels = {
    TipoDocumento: 'Tipo documento',
    EstadoAsistencia: 'Estado asistencia',
    Operacion: 'Operación',
    MarcacionesOperacion: 'Operación de marcación',
    InicioAlmuerzo: 'Inicio almuerzo',
    FinAlmuerzo: 'Fin almuerzo',
    HorasTotales: 'Horas totales',
    HorasOrdinarias: 'Horas ordinarias',
    HorasExtraTotal: 'Horas extra total'
  };
  const headerRow = sheet.getRow(4);
  headers.forEach((key, index) => {
    const codeLabel = CONCEPT_LABELS[key] ? `${key} · ${CONCEPT_LABELS[key]}` : null;
    headerRow.getCell(index + 1).value = codeLabel || headerLabels[key] || key;
  });
  headerRow.font = { bold: true, color: { argb: EXPORT_COLORS.white } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: EXPORT_COLORS.teal } };
  headerRow.alignment = { vertical: 'middle', wrapText: true };
  headerRow.height = 34;

  rows.forEach((source, rowIndex) => {
    const excelRow = sheet.getRow(rowIndex + 5);
    headers.forEach((key, columnIndex) => {
      excelRow.getCell(columnIndex + 1).value = source[key] ?? '';
    });
    if (rowIndex % 2 === 1) {
      excelRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: EXPORT_COLORS.stripe } };
    }
    excelRow.alignment = { vertical: 'top', wrapText: true };
  });

  sheet.views = [{ state: 'frozen', ySplit: 4, xSplit: 4 }];
  sheet.autoFilter = { from: 'A4', to: `${lastColumn}4` };
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber < 4) return;
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = {
        bottom: { style: 'thin', color: { argb: EXPORT_COLORS.border } }
      };
    });
  });

  return workbook;
}

export function attendanceFilteredExportRouter(prisma) {
  const router = express.Router();

  router.get('/export-filtrado.xlsx', async (req, res) => {
    try {
      const board = await loadAttendanceAdminBoard(prisma, req.query || {});
      const selected = new Set(normalizeList(req.query?.workerKey).map(selectedWorkerKey).filter(Boolean));
      const filteredRows = selected.size
        ? (board.rows || []).filter((row) => selected.has(identityKey(row)))
        : (board.rows || []);

      const report = await loadPayrollReport(prisma, {
        periodType: 'CUSTOM',
        from: board.range.from,
        to: board.range.to,
        anchor: board.range.from
      }, {
        allowTestData: (req.session?.userRole || req.userRole) === 'dev'
      });

      const workbook = buildAttendanceFilteredWorkbook(report, filteredRows);
      const buffer = await workbook.xlsx.writeBuffer();
      const filename = `asistencia-filtrada-${board.range.from}-${board.range.to}.xlsx`;
      res.set('Cache-Control', 'no-store');
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.set('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(Buffer.from(buffer));
    } catch (error) {
      console.error('[ATTENDANCE_FILTERED_EXPORT_FAILED]', { code: error?.message || 'unknown' });
      return res.status(500).send('No fue posible generar el Excel de asistencia filtrada.');
    }
  });

  return router;
}
